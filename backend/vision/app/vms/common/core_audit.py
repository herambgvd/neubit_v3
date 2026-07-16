"""Best-effort video-access audit → core's tamper-evident trail (Task 3).

Enterprise-VMS + DPDP/GDPR require a tamper-evident record of WHO viewed recorded
footage / exported evidence. Core already owns the append-only audit log and exposes
the ingest endpoint ``POST /security/audit/video`` (gated by ``audit.write``). This
module is the thin vision-side CLIENT: it posts an ``AuditIngestIn`` for a granted
sensitive video op (recorded playback, clip export) after ACL enforcement, using a
short-lived superadmin service token (which satisfies ``audit.write`` on core).

Design mirrors ``linkage/door_camera.py``:
  * ``VE_CORE_URL`` unset → no-op (core is off; nothing to report to).
  * URL is built from ``core_base_url()`` + the same ``VE_API_PREFIX`` prefix core
    routes live under (default ``/api/v1``) → ``<core>/api/v1/security/audit/video``.

BEST-EFFORT / NON-BLOCKING: the whole call is wrapped in try/except. On ANY error
(network, non-2xx, timeout, malformed principal) we log and RETURN — auditing must
NEVER raise into or fail the user's playback/export request. The user op landing is
more important than the audit landing; a dropped audit is a monitoring concern, not a
request failure.

ZERO LATENCY: call sites use ``fire_and_forget_video_audit`` — it schedules the async
POST as a background task and returns immediately, so the audit's (short) network round
trip adds NOTHING to the user's response. ``report_video_audit`` itself stays async and
awaited-internally-swallowed so it remains directly unit-testable.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from kernel.auth import Principal

from app.vms.common.service_token import mint_service_token
# Reuse door_camera's core URL + api-prefix construction (single source of truth) so
# the audit ingest path is derived exactly like the placement lookups core also serves.
from app.vms.linkage.door_camera import _api_prefix, core_base_url

log = logging.getLogger("vision.common.core_audit")

# Short — a slow/absent core must not stall the user's playback/export response.
_DEFAULT_TIMEOUT = 4.0


async def report_video_audit(
    *,
    action: str,
    camera_id: str,
    principal: Principal,
    meta: dict | None = None,
) -> None:
    """Report a granted video-access op to core's audit trail. Best-effort, never raises.

    ``action`` is the audit verb (``"vms.playback.view"`` / ``"vms.export.request"``),
    ``camera_id`` the target camera, ``principal`` the acting ``kernel.auth.Principal``
    (its ``user_id`` → ``actor_id``, ``tenant_id`` → ``tenant_id``; it carries no email
    so ``actor_email`` is omitted and core falls back to the service email). ``meta`` is
    free-form context (from/to/format/job_id) stored verbatim on the audit record.

    Returns silently — and NEVER raises — when core is unconfigured, unreachable, or
    rejects the ingest. Auditing is a side effect of the user op, never a gate on it.
    """
    base = core_base_url()
    if not base:
        # Core is off (no VE_CORE_URL) → nothing to report to; no-op, like door_camera.
        return

    try:
        tenant_id = getattr(principal, "tenant_id", None)
        token = mint_service_token(
            tenant_id=str(tenant_id) if tenant_id else None
        )
        headers = {"Authorization": f"Bearer {token}"}
        prefix = _api_prefix()
        url = f"{base}{prefix}/security/audit/video"
        payload = {
            "action": action,
            "target_type": "camera",
            "target_id": camera_id,
            # Principal has no email → actor_email omitted; core falls back to the
            # service identity. Serialize UUIDs as strings for JSON.
            "actor_id": str(principal.user_id) if getattr(principal, "user_id", None) else None,
            "actor_email": None,
            "tenant_id": str(tenant_id) if tenant_id else None,
            "meta": meta or {},
        }
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT, headers=headers) as client:
            resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            # A rejected ingest is logged but swallowed — the user op already succeeded.
            log.warning(
                "video audit ingest %s cam=%s → %s", action, camera_id, resp.status_code
            )
    except httpx.HTTPError as exc:
        log.info("video audit ingest %s cam=%s failed (network): %s", action, camera_id, exc)
    except Exception as exc:  # noqa: BLE001 — auditing must never crash the user request
        log.warning("video audit ingest %s cam=%s unexpected error: %s", action, camera_id, exc)


# Strong refs to in-flight background audit tasks. Without this, the event loop only
# holds a weak ref and may GC a still-running task → "Task was destroyed but it is
# pending!" / "exception never retrieved". We drop each task from the set on completion.
_BG: set = set()


def fire_and_forget_video_audit(**kwargs) -> None:
    """Schedule ``report_video_audit`` as a background task — NEVER blocks the caller.

    Call sites use this (not ``await report_video_audit(...)``) so the audit's network
    round trip adds ZERO latency to the user's playback/export/live response. The POST
    runs on the event loop after the response is sent; any error is still fully swallowed
    inside ``report_video_audit`` (this wrapper only handles the scheduling itself).

    ``kwargs`` are forwarded verbatim to ``report_video_audit`` (action / camera_id /
    principal / meta).
    """
    try:
        task = asyncio.create_task(report_video_audit(**kwargs))
        _BG.add(task)
        task.add_done_callback(_BG.discard)
    except RuntimeError:
        # No running event loop (shouldn't happen inside a request handler) — drop the
        # audit silently rather than raise into the user op.
        pass
