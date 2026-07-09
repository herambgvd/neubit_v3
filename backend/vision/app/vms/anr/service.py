"""ANR fulfiller (P6-A) — resolve the footage source, pull the gap, land segments.

Tenant-scoped worker invoked by the ``AnrConsumer`` per ``anr.request``. It:

  1. loads the camera + resolves the footage SOURCE (an NVR channel → the NVR's driver
     over the NVR host; else an edge/Profile-G camera → the camera's own driver);
  2. reuses the P4-B driver footage search (``search_recordings`` + ``get_playback_uri``)
     over the gap window → a replay RTSP URI;
  3. ffmpeg-pulls that replay into an fmp4 segment on the shared ``recordings`` volume
     under ``cameras/<tenant>/<camera>/<profile>/<gap-start>.mp4`` (the Go ``nvr``
     segment-tracker layout — so the pulled segment becomes a ``Recording`` row via the
     existing ``RecordingConsumer``, NOT a double-write here);
  4. returns an ``AnrResult`` the consumer publishes on ``anr.result``.

GRACEFUL by construction: an unreachable edge/NVR, no on-device footage, a driver that
can't search, or an ffmpeg failure → ``AnrResult(status="failed", error=…)`` — every
branch returns a result, none raises. Credentials are decrypted in-memory only (via
``vms.common.crypto``); the drivers are the SAME P4-B ones (no brand protocol here).
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned

from app.vms.common.crypto import decrypt_secret
from app.vms.drivers import Credentials, get_driver
from app.vms.models import NVR, Camera

from .ffmpeg import AnrFfmpegError, pull_segment, segment_filename

log = logging.getLogger("vision.anr")

DEFAULT_RECORDINGS_DIR = "/recordings"


def recordings_dir() -> str:
    """Root of the shared recordings volume (``VE_RECORDINGS_DIR``, default ``/recordings``).

    The SAME root the Go ``nvr`` records under + the vision storage/export paths use, so
    a pulled ANR segment lands where the segment tracker + coverage look for it.
    """
    return (os.getenv("VE_RECORDINGS_DIR", "").strip() or DEFAULT_RECORDINGS_DIR).rstrip("/")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(v) -> datetime | None:
    if not v:
        return None
    try:
        s = str(v).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


@dataclass
class AnrRequest:
    """A decoded ``anr.request`` payload from the Go ``nvr``."""

    job_id: int
    tenant_id: str | None
    camera_id: str
    profile: str
    gap_from: datetime
    gap_to: datetime
    record_path: str | None = None

    @classmethod
    def from_event(cls, tenant_id: str | None, payload: dict) -> "AnrRequest | None":
        """Build from an event envelope's tenant + payload. ``None`` if malformed."""
        try:
            job_id = int(payload.get("job_id"))
        except (TypeError, ValueError):
            return None
        camera_id = payload.get("camera_id")
        gap_from = _parse_dt(payload.get("gap_from"))
        gap_to = _parse_dt(payload.get("gap_to"))
        if not job_id or not camera_id or gap_from is None or gap_to is None:
            return None
        if gap_to <= gap_from:
            return None
        return cls(
            job_id=job_id,
            tenant_id=tenant_id,
            camera_id=str(camera_id),
            profile=(payload.get("profile") or "main"),
            gap_from=gap_from,
            gap_to=gap_to,
            record_path=payload.get("record_path") or None,
        )


@dataclass
class AnrResult:
    """The outcome the consumer publishes on ``anr.result``."""

    job_id: int
    status: str  # done | failed
    backfilled_segments: int = 0
    error: str | None = None

    def payload(self) -> dict:
        p: dict = {
            "job_id": self.job_id,
            "status": self.status,
            "backfilled_segments": self.backfilled_segments,
        }
        if self.error:
            p["error"] = self.error[:2000]
        return p


@dataclass
class _Source:
    """A resolved footage source: which driver/host/creds + channel to search."""

    brand: str
    host: str
    creds: Credentials
    channel: int | None
    kind: str  # "nvr" | "edge"


class AnrFulfiller:
    """Tenant-scoped ANR backfill. One instance per request (own DB session)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def fulfill(self, req: AnrRequest) -> AnrResult:
        """Run the full backfill for ``req``. Always returns a result (never raises)."""
        # 1) Load the camera (tenant-scoped from the event).
        camera = await self.db.get(Camera, req.camera_id)
        try:
            assert_owned(camera, self.scope, message="camera not found")
        except Exception:  # noqa: BLE001 — unknown/foreign camera → clean failed result
            return AnrResult(req.job_id, "failed", error="camera not found for tenant")

        # 2) Resolve the footage source (NVR channel vs edge/Profile-G camera).
        source = await self._resolve_source(camera)
        if source is None:
            return AnrResult(
                req.job_id,
                "failed",
                error="no footage source: camera is not an NVR channel and has no edge recording",
            )

        # 3) Search the gap window → a replay RTSP URI (reuse the P4-B driver search).
        from_iso = req.gap_from.astimezone(timezone.utc).isoformat()
        to_iso = req.gap_to.astimezone(timezone.utc).isoformat()
        uri, err = await self._search_playback_uri(source, from_iso, to_iso)
        if not uri:
            return AnrResult(req.job_id, "failed", error=err or "no on-device footage for the gap window")

        # 4) ffmpeg-pull the replay → an fmp4 segment on the recordings volume.
        out_path = self._segment_path(req)
        duration = (req.gap_to - req.gap_from).total_seconds()
        try:
            size = await pull_segment(uri, out_path, duration_sec=duration)
        except AnrFfmpegError as exc:
            return AnrResult(req.job_id, "failed", error=str(exc))
        except Exception as exc:  # noqa: BLE001 — any pull error → failed, never crash
            return AnrResult(req.job_id, "failed", error=f"pull error: {exc}")

        log.info(
            "ANR job %s backfilled: camera=%s source=%s gap=%s→%s (%.0fs, %d bytes) → %s",
            req.job_id, req.camera_id, source.kind, from_iso, to_iso, duration, size, out_path,
        )
        # The pulled segment now lives under the tracker's watched layout → the Go nvr
        # segment tracker emits ``recording.segment`` → the RecordingConsumer persists a
        # Recording row. We report ONE backfilled segment (the pulled window).
        return AnrResult(req.job_id, "done", backfilled_segments=1)

    # ── source resolution ────────────────────────────────────────────────
    async def _resolve_source(self, camera: Camera) -> _Source | None:
        """NVR channel → the NVR's driver/host/creds; else edge camera with its own driver.

        Returns ``None`` when neither a linked NVR nor an edge-recording-capable camera
        is available (the fulfiller then fails the job cleanly).
        """
        # NVR channel: pull from the recorder's own storage over the NVR host.
        if camera.nvr_id:
            nvr = await self.db.get(NVR, camera.nvr_id)
            if nvr is not None and nvr.host:
                creds = Credentials(
                    username=nvr.username or "admin",
                    password=decrypt_secret(nvr.enc_creds) or "",
                    port=nvr.port or 80,
                )
                return _Source(
                    brand=nvr.brand or camera.brand or "onvif",
                    host=nvr.host,
                    creds=creds,
                    channel=camera.nvr_channel_number,
                    kind="nvr",
                )

        # Edge / ONVIF Profile-G camera: pull from the camera's own SD-card/onboard store.
        host = camera.onvif_host or (camera.network_info or {}).get("ip")
        if host:
            creds = Credentials(
                username=camera.onvif_user or "admin",
                password=decrypt_secret(camera.onvif_enc_pass) or "",
                port=camera.onvif_port or 80,
            )
            return _Source(
                brand=camera.brand or "onvif",
                host=host,
                creds=creds,
                channel=camera.nvr_channel_number,
                kind="edge",
            )
        return None

    async def _search_playback_uri(
        self, source: _Source, from_iso: str, to_iso: str
    ) -> tuple[str | None, str | None]:
        """Search the source's footage for the window → a replay RTSP URI (reuse P4-B).

        First ``search_recordings`` to confirm the device HAS footage covering the
        window (and to pick a ``recording_token`` when the brand needs one), then
        ``get_playback_uri`` for the RTSP-with-time replay URL. Graceful: an unreachable
        device / a driver that can't search → ``(None, reason)`` (never raises).
        Returns ``(uri, None)`` on success or ``(None, error)`` on any failure.
        """
        driver = get_driver(source.brand)
        try:
            try:
                matches = await driver.search_recordings(
                    source.host, source.creds,
                    channel=source.channel, start_time=from_iso, end_time=to_iso,
                )
            except Exception as exc:  # noqa: BLE001 — search must never crash the fulfiller
                log.info("ANR search failed (%s ch%s): %s", source.host, source.channel, exc)
                return None, f"footage search failed: {exc}"

            if not matches:
                return None, "no on-device footage for the gap window"

            recording_token = None
            for m in matches:
                recording_token = m.get("recording_token") or m.get("track_id")
                if recording_token:
                    break

            try:
                uri = await driver.get_playback_uri(
                    source.host, source.creds,
                    channel=source.channel, start_time=from_iso, end_time=to_iso,
                    recording_token=recording_token,
                )
            except Exception as exc:  # noqa: BLE001 — never crash
                log.info("ANR playback-uri failed (%s ch%s): %s", source.host, source.channel, exc)
                return None, f"playback-uri failed: {exc}"

            if not uri:
                return None, "no replay URI derivable for the gap window"
            return uri, None
        finally:
            try:
                await driver.aclose()
            except Exception:  # noqa: BLE001
                pass

    # ── output path ──────────────────────────────────────────────────────
    def _segment_path(self, req: AnrRequest) -> str:
        """The on-disk path the pulled segment lands under.

        ``<recordings>/cameras/<tenant>/<camera>/<profile>/<gap-start>.mp4`` — the exact
        layout the Go ``nvr`` segment tracker (``parsePath`` / ``parseSegmentStart``)
        parses, so the pulled segment is picked up + emitted as ``recording.segment``.
        Prefers the ``record_path`` the nvr sent (its recording-target dir) when present,
        else derives from ``VE_RECORDINGS_DIR`` + the standard layout.
        """
        tenant = req.tenant_id or (str(self.scope.tenant_id) if self.scope.tenant_id else "platform")
        name = segment_filename(req.gap_from)

        base = (req.record_path or "").strip()
        if base:
            # The nvr's record_path already points at the profile dir for this target.
            return os.path.join(base.rstrip("/"), name)

        return os.path.join(
            recordings_dir(), "cameras", str(tenant), str(req.camera_id), req.profile, name
        )


def scope_for(tenant_id: str | None) -> Scope:
    """A per-tenant scope for the fulfiller (superadmin only for the platform namespace).

    The consumer trusts the tenant carried in the event envelope; the fulfiller reads +
    writes strictly within that tenant. A ``None`` tenant (platform) → superadmin.
    """
    tid: uuid.UUID | None = None
    if tenant_id:
        try:
            tid = uuid.UUID(str(tenant_id))
        except (ValueError, TypeError):
            tid = None
    return Scope(tenant_id=tid, is_superadmin=(tid is None))
