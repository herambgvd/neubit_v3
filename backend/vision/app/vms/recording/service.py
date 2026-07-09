"""Recording control-plane service (P3-A) — tenant-scoped.

Owns the per-camera recording POLICY (mode / weekly schedule / retention /
substream) + the browse/query over the ``recordings`` metadata table, and drives
the Go ``nvr`` data-plane (start/stop MediaMTX record) for the modes that record
immediately (continuous / manual). Schedule windows are toggled by the
``RecordingScheduler`` (a periodic task in vision's lifespan); motion/event are
fired by P5 (the nvr's event-clip entry point).

Discipline mirrors the camera/live services:
  * every read/by-id goes through ``kernel.auth.assert_owned`` / ``scoped``; new
    rows are stamped with the caller's ``tenant_id``.
  * GRACEFUL: an unreachable camera (no RTSP derivable) or a down nvr surfaces as a
    clean 502 (``RecordingUpstreamError``), never a 500 — a policy change still
    persists even if the nvr call fails (the scheduler/reconcile self-heals).

The RTSP-source derivation is REUSED from ``LiveService`` (same decrypt-in-memory,
prefer-substream logic) so recording and live share one code path.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import AppError

from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.live.service import LiveService
from app.vms.models import Camera, Recording

log = logging.getLogger("vision.recording_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class RecordingUpstreamError(AppError):
    """Camera unreachable / nvr down / no RTSP derivable → a clean 502 (never 500)."""

    code = "MEDIA_UPSTREAM"
    status_code = 502


# Modes whose recording is driven immediately (vs. schedule / motion / event which
# are toggled by the scheduler / P5 events).
_IMMEDIATE_MODES = {"continuous", "manual"}


class RecordingService:
    """Tenant-scoped recording policy + browse over ``recordings``."""

    def __init__(self, db: AsyncSession, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        self.bearer = bearer
        self.nvr = NvrClient(bearer=bearer)
        # Reuse the live service purely for its RTSP-source derivation (no session).
        self._live = LiveService(db, scope, bearer=bearer)

    # ── row helpers ─────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    def _record_profile(self, camera: Camera) -> str:
        """Which profile to record: the sub-stream if ``record_substream`` else main."""
        return "sub" if camera.record_substream else "main"

    async def _rtsp_for(self, camera: Camera, profile: str) -> str | None:
        return await self._live._rtsp_source_for(camera, profile)

    # ── config (PUT /cameras/{id}/recording) ────────────────────────────
    async def set_config(self, camera_id: str, body, *, actor):
        """Persist the recording policy; drive the nvr for immediate modes.

        continuous → start recording now; manual → leave as-is (operator toggles);
        schedule → the scheduler opens/closes windows; motion/event → P5. On a mode
        that should NOT be recording continuously (manual/schedule/motion/event with
        no window open), we STOP any active recording so a mode switch takes effect.
        """
        camera = await self._camera(camera_id)
        camera.recording_mode = body.mode
        camera.recording_schedule = body.schedule or {}
        camera.retention_days = body.retention_days
        camera.record_substream = body.record_substream
        actor_id = _actor_id(actor)
        if actor_id:
            camera.updated_by = actor_id
        camera.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(camera)

        recording_now = False
        # Drive the data-plane. Best-effort: a down nvr does not roll back the policy
        # (the scheduler/reconcile re-asserts it), but continuous is surfaced as 502
        # if it can't start right now so the operator sees the camera is unreachable.
        try:
            if body.mode == "continuous" and camera.is_enabled:
                await self._drive_start(camera, trigger="continuous")
                recording_now = True
            else:
                # Any non-continuous mode: stop an in-flight continuous recording so
                # the switch is honoured (schedule windows / manual re-enable later).
                await self.nvr.stop_recording(
                    camera_id=camera.id, profile=self._record_profile(camera)
                )
        except RecordingUpstreamError:
            raise
        except NvrUnavailable as exc:
            # Non-continuous stop is best-effort; a continuous start failure is 502.
            if body.mode == "continuous":
                raise RecordingUpstreamError(exc.message) from exc
            log.info("recording config stop best-effort failed: %s", exc)

        return self._config_public(camera, recording_now)

    async def get_config(self, camera_id: str):
        camera = await self._camera(camera_id)
        return self._config_public(camera, recording_now=False)

    # ── manual start / stop ─────────────────────────────────────────────
    async def start(self, camera_id: str, *, actor, trigger: str = "manual"):
        camera = await self._camera(camera_id)
        act = await self._drive_start(camera, trigger=trigger)
        return {
            "camera_id": camera.id,
            "profile": self._record_profile(camera),
            "recording": True,
            "trigger_type": act.get("trigger_type", trigger),
        }

    async def stop(self, camera_id: str, *, actor):
        camera = await self._camera(camera_id)
        profile = self._record_profile(camera)
        await self.nvr.stop_recording(camera_id=camera.id, profile=profile)
        return {
            "camera_id": camera.id,
            "profile": profile,
            "recording": False,
            "trigger_type": None,
        }

    async def _drive_start(self, camera: Camera, *, trigger: str) -> dict:
        """Derive RTSP + ask the nvr to start recording. Raises 502 on failure."""
        profile = self._record_profile(camera)
        rtsp_url = await self._rtsp_for(camera, profile)
        if not rtsp_url:
            raise RecordingUpstreamError("camera has no reachable RTSP stream to record")
        try:
            return await self.nvr.start_recording(
                camera_id=camera.id, profile=profile, rtsp_url=rtsp_url, trigger=trigger
            )
        except NvrUnavailable as exc:
            raise RecordingUpstreamError(exc.message) from exc

    # ── browse (GET /cameras/{id}/recordings, GET /recordings/{id}) ──────
    async def list_(
        self,
        camera_id: str,
        *,
        skip: int = 0,
        limit: int = 50,
        from_: datetime | None = None,
        to: datetime | None = None,
        trigger: str | None = None,
    ):
        # Ensure the camera is owned (scoped) before listing its recordings.
        await self._camera(camera_id)
        stmt = scoped(select(Recording), Recording, self.scope).where(
            Recording.camera_id == camera_id
        )
        count_stmt = scoped(
            select(func.count(Recording.id)), Recording, self.scope
        ).where(Recording.camera_id == camera_id)
        if from_ is not None:
            stmt = stmt.where(Recording.start_time >= from_)
            count_stmt = count_stmt.where(Recording.start_time >= from_)
        if to is not None:
            stmt = stmt.where(Recording.start_time <= to)
            count_stmt = count_stmt.where(Recording.start_time <= to)
        if trigger:
            stmt = stmt.where(Recording.trigger_type == trigger)
            count_stmt = count_stmt.where(Recording.trigger_type == trigger)

        total = int((await self.db.execute(count_stmt)).scalar() or 0)
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(Recording.start_time.desc()).offset(skip).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        from .schemas import RecordingListResponse, RecordingPublic

        return RecordingListResponse(
            items=[RecordingPublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def get(self, rec_id: str):
        row = await self.db.get(Recording, rec_id)
        assert_owned(row, self.scope, message="recording not found")
        from .schemas import RecordingPublic

        return RecordingPublic.from_row(row)

    # ── segment persistence (called by the NATS consumer) ───────────────
    async def persist_segment(self, tenant_id, payload: dict) -> str | None:
        """Persist a Recording from an nvr segment event. Deduped by ``path``.

        Returns the new row id, or ``None`` if the segment was already stored (an
        at-least-once redelivery). Runs OUTSIDE a caller scope — the consumer trusts
        the tenant from the subject/payload.
        """
        path = payload.get("path")
        if not path:
            return None
        # Dedupe: skip if this path is already recorded.
        existing = (
            await self.db.execute(select(Recording.id).where(Recording.path == path))
        ).scalar_one_or_none()
        if existing:
            return None

        camera_id = payload.get("camera_id")
        if not camera_id:
            return None

        # tenant_id from the subject is a str (or None for platform). The Recording
        # column is a Uuid | None; coerce.
        import uuid as _uuid

        tid = None
        if tenant_id:
            try:
                tid = _uuid.UUID(str(tenant_id))
            except (ValueError, TypeError):
                tid = None

        row = Recording(
            tenant_id=tid,
            camera_id=camera_id,
            profile=payload.get("profile") or "main",
            path=path,
            start_time=_parse_dt(payload.get("start")) or _utcnow(),
            end_time=_parse_dt(payload.get("end")),
            duration=_as_float(payload.get("duration")),
            file_size=_as_int(payload.get("size")),
            codec=payload.get("codec"),
            resolution=payload.get("resolution"),
            trigger_type=payload.get("trigger_type") or "continuous",
        )
        self.db.add(row)
        try:
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001 — a racing insert (unique path) is fine
            await self.db.rollback()
            log.info("segment persist race for %s: %s", path, exc)
            return None
        return row.id

    # ── helpers ─────────────────────────────────────────────────────────
    def _config_public(self, camera: Camera, recording_now: bool):
        from .schemas import RecordingConfigPublic

        return RecordingConfigPublic(
            camera_id=camera.id,
            mode=camera.recording_mode,
            schedule=camera.recording_schedule or {},
            retention_days=camera.retention_days,
            record_substream=camera.record_substream,
            recording_now=recording_now,
        )


def _parse_dt(v) -> datetime | None:
    if not v:
        return None
    try:
        # fromisoformat handles the RFC3339 the nvr emits (…±hh:mm / Z via replace).
        s = str(v).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _as_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def _as_int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (ValueError, TypeError):
        return None
