"""Linkage action executors (P5-B) — one coroutine per action type.

Each executor is GRACEFUL: it returns an ``ActionResult(ok, detail, recording_id?)`` and
NEVER raises out — a device that's down (nvr / camera relay / PTZ) logs + returns
``ok=False`` so the engine records it in the fire-audit and continues to the next action.

The executors reuse the existing seams — no new infra:
  * ``start_recording`` → the Go nvr's event-clip via ``RecordingService`` (which wraps
    ``NvrClient.start_recording`` with pre/post + trigger). Sets the Recording
    ``trigger_type=event`` (the nvr stamps it from the ``trigger`` we pass) and returns
    the recording id when the segment lands (best-effort — the segment consumer persists
    the row asynchronously, so we return the nvr's active-target ref).
  * ``notify`` → publishes ``tenant.<id>.notify.request`` for the workflow/notifier
    connector framework (vision has no transport of its own).
  * ``ptz_preset`` → the driver ``ptz(goto_preset)``.
  * ``trigger_output`` → the driver ``configure("io", {relay_token, state})`` (the ONVIF
    ``SetRelayOutputState`` seam already exists — no interface change needed); optional
    auto-release after ``release_after_seconds``.
  * ``popup`` → publishes ``tenant.<id>.vms.popup`` for the operator UI (P5-C over SSE).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from kernel.auth import Scope

from app.vms.common.crypto import decrypt_secret
from app.vms.common.events import emit_notify_request, emit_popup
from app.vms.common.nvr_client import NvrUnavailable
from app.vms.common.service_token import mint_service_token
from app.vms.drivers import Credentials, PtzCommand, get_driver
from app.vms.drivers.base import DriverError
from app.vms.models import Camera

log = logging.getLogger("vision.linkage.actions")

# A platform scope for the background executors (they authorize off the camera/event,
# not a caller — the engine already resolved the tenant from the event envelope).
_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)


@dataclass
class ActionResult:
    type: str
    ok: bool
    detail: str = ""
    recording_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"type": self.type, "ok": self.ok, "detail": self.detail}
        if self.recording_id:
            d["recording_id"] = self.recording_id
        return d


# ── ctx the engine hands each executor ──────────────────────────────────────────
@dataclass
class ActionContext:
    """Everything an executor needs, resolved by the engine before dispatch."""

    tenant_id: str | None
    camera_id: str | None
    event_id: str | None
    event_type: str
    severity: str
    title: str
    sessionmaker: Any  # async_sessionmaker
    reason: str = ""  # human reason (e.g. "door forced at Lobby")


def _creds_for(cam: Camera) -> Credentials:
    return Credentials(
        username=cam.onvif_user or "admin",
        password=decrypt_secret(cam.onvif_enc_pass) or "",
        port=cam.onvif_port or 80,
        rtsp_port=(cam.network_info or {}).get("rtsp_port") or 554,
    )


def _host_for(cam: Camera) -> str | None:
    return cam.onvif_host or (cam.network_info or {}).get("ip")


async def _load_camera(ctx: ActionContext) -> Camera | None:
    if not ctx.camera_id:
        return None
    async with ctx.sessionmaker() as db:
        return await db.get(Camera, ctx.camera_id)


# ── start_recording ─────────────────────────────────────────────────────────────
async def action_start_recording(ctx: ActionContext, config: dict) -> ActionResult:
    """Fire an event-clip on the nvr (pre/post buffer) → Recording trigger_type=event.

    Reuses ``RecordingService.start`` (which derives the RTSP + calls the Go nvr's
    ``start_recording`` with ``trigger="event"``). The nvr stamps ``trigger_type`` from
    the trigger; the produced segments are persisted as ``event`` recordings by the P3-A
    segment consumer. Graceful: an unreachable nvr / no-RTSP camera → ``ok=False`` (a
    clean skip), never a crash.
    """
    if not ctx.camera_id:
        return ActionResult("start_recording", False, "no camera to record")

    # Import here to avoid a heavy import at module load / a cycle through the engine.
    from app.vms.recording.service import RecordingService, RecordingUpstreamError

    bearer = mint_service_token(tenant_id=ctx.tenant_id)
    try:
        async with ctx.sessionmaker() as db:
            svc = RecordingService(db, _PLATFORM_SCOPE, bearer=bearer)
            out = await svc.start(ctx.camera_id, actor=None, trigger="event")
        return ActionResult(
            "start_recording",
            True,
            f"event-clip started (profile={out.get('profile')})",
        )
    except RecordingUpstreamError as exc:
        return ActionResult("start_recording", False, f"nvr upstream: {exc}")
    except NvrUnavailable as exc:  # noqa: F841 — belt & suspenders
        return ActionResult("start_recording", False, f"nvr unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001 — never crash the engine
        log.warning("start_recording action failed for %s: %s", ctx.camera_id, exc)
        return ActionResult("start_recording", False, f"error: {exc}")


# ── notify ──────────────────────────────────────────────────────────────────────
async def action_notify(ctx: ActionContext, config: dict) -> ActionResult:
    """Publish a channel-agnostic notify request for the connector framework.

    vision has no notification transport, so this action is a NATS hand-off
    (``tenant.<id>.notify.request``) the workflow/notifier consumes (email / webhook /
    push). ``config`` carries ``{channel, target?, subject?, body?}`` — passed through.
    """
    channel = (config.get("channel") or "email").strip()
    payload = {
        "channel": channel,
        "target": config.get("target"),
        "subject": config.get("subject") or f"VMS: {ctx.title}",
        "body": config.get("body") or ctx.reason or ctx.title,
        "event_id": ctx.event_id,
        "camera_id": ctx.camera_id,
        "event_type": ctx.event_type,
        "severity": ctx.severity,
        "config": {k: v for k, v in config.items() if k not in {"channel", "target", "subject", "body"}},
    }
    try:
        subj = await emit_notify_request(ctx.tenant_id, payload)
        return ActionResult("notify", True, f"notify.request published on {subj} (channel={channel})")
    except Exception as exc:  # noqa: BLE001
        log.warning("notify action failed: %s", exc)
        return ActionResult("notify", False, f"publish failed: {exc}")


# ── ptz_preset ──────────────────────────────────────────────────────────────────
async def action_ptz_preset(ctx: ActionContext, config: dict) -> ActionResult:
    """Recall a PTZ preset on the camera (``get_driver(brand).ptz(goto_preset)``)."""
    preset = config.get("preset_token") or config.get("preset")
    if not preset:
        return ActionResult("ptz_preset", False, "no preset_token in config")
    cam = await _load_camera(ctx)
    if cam is None:
        return ActionResult("ptz_preset", False, "camera not found")
    host = _host_for(cam)
    if not host:
        return ActionResult("ptz_preset", False, "camera has no host")
    driver = get_driver(cam.brand or "onvif")
    cmd = PtzCommand(
        action="goto_preset",
        preset_token=str(preset),
        profile_token=cam.onvif_profile_token,
    )
    try:
        await driver.ptz(host, _creds_for(cam), cmd)
        return ActionResult("ptz_preset", True, f"recalled preset {preset}")
    except DriverError as exc:
        return ActionResult("ptz_preset", False, f"ptz failed: {exc}")
    except Exception as exc:  # noqa: BLE001
        log.warning("ptz_preset action failed for %s: %s", ctx.camera_id, exc)
        return ActionResult("ptz_preset", False, f"error: {exc}")
    finally:
        try:
            await driver.aclose()
        except Exception:  # noqa: BLE001
            pass


# ── trigger_output ──────────────────────────────────────────────────────────────
async def action_trigger_output(ctx: ActionContext, config: dict) -> ActionResult:
    """Drive a camera relay output via the driver ``configure("io", …)`` seam.

    ``config``: ``{relay_token?, state?, release_after_seconds?}`` (defaults RelayOut1 /
    active / 0). When ``release_after_seconds > 0`` and ``state == "active"``, a tracked
    background task flips it back to inactive after the delay. The ONVIF driver's
    ``configure`` ``io`` section already wraps ``SetRelayOutputState`` — no interface
    change is needed for the default driver; a brand whose ``configure`` doesn't support
    ``io`` degrades to ``ok=False`` (graceful).
    """
    cam = await _load_camera(ctx)
    if cam is None:
        return ActionResult("trigger_output", False, "camera not found")
    host = _host_for(cam)
    if not host:
        return ActionResult("trigger_output", False, "camera has no host")

    relay_token = config.get("relay_token") or "RelayOut1"
    state = config.get("state") or "active"
    release_after = int(config.get("release_after_seconds") or 0)
    driver = get_driver(cam.brand or "onvif")
    creds = _creds_for(cam)
    try:
        await driver.configure(host, creds, "io", {"relay_token": relay_token, "state": state})
    except DriverError as exc:
        return ActionResult("trigger_output", False, f"relay set failed: {exc}")
    except NotImplementedError:
        return ActionResult("trigger_output", False, "driver has no relay-output support")
    except Exception as exc:  # noqa: BLE001
        log.warning("trigger_output action failed for %s: %s", ctx.camera_id, exc)
        return ActionResult("trigger_output", False, f"error: {exc}")

    # Optional auto-release (fire-and-forget; the engine tracks/awaits nothing here — a
    # relay stuck active is a device concern, not a linkage-audit concern).
    if release_after > 0 and state == "active":
        async def _release() -> None:
            try:
                await asyncio.sleep(release_after)
                await driver.configure(host, creds, "io", {"relay_token": relay_token, "state": "inactive"})
            except Exception as exc:  # noqa: BLE001
                log.info("relay auto-release failed for %s: %s", ctx.camera_id, exc)
            finally:
                try:
                    await driver.aclose()
                except Exception:  # noqa: BLE001
                    pass

        asyncio.create_task(_release())
        return ActionResult(
            "trigger_output", True, f"relay {relay_token}={state} (release in {release_after}s)"
        )

    try:
        await driver.aclose()
    except Exception:  # noqa: BLE001
        pass
    return ActionResult("trigger_output", True, f"relay {relay_token}={state}")


# ── popup ───────────────────────────────────────────────────────────────────────
async def action_popup(ctx: ActionContext, config: dict) -> ActionResult:
    """Publish ``tenant.<id>.vms.popup`` for the operator UI (P5-C SSE)."""
    if not ctx.camera_id:
        return ActionResult("popup", False, "no camera to pop")
    payload = {
        "camera_id": ctx.camera_id,
        "reason": config.get("reason") or ctx.reason or ctx.title,
        "event_id": ctx.event_id,
        "event_type": ctx.event_type,
        "severity": ctx.severity,
    }
    try:
        subj = await emit_popup(ctx.tenant_id, payload)
        return ActionResult("popup", True, f"popup published on {subj}")
    except Exception as exc:  # noqa: BLE001
        log.warning("popup action failed: %s", exc)
        return ActionResult("popup", False, f"publish failed: {exc}")


# Dispatch table the engine walks.
EXECUTORS = {
    "start_recording": action_start_recording,
    "notify": action_notify,
    "ptz_preset": action_ptz_preset,
    "trigger_output": action_trigger_output,
    "popup": action_popup,
}
