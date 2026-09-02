"""Forensic motion-search control-plane service (G4) — tenant-scoped job issuer.

Owns the motion-search job LIFECYCLE from the caller's side (mirrors ``ExportService``):
  * ``create`` — verify the camera + that recordings cover the window → CLAMP the window
    to the configured cap (a huge range can't run forever) → persist a QUEUED
    ``MotionSearchJob``. No ffmpeg here (the ``MotionSearchWorker`` does the analysis).
    Returns immediately with ``{job_id, status:"queued"}``.
  * ``get`` — the tenant-scoped job status/result view (hits when done).

Discipline mirrors the export/playback services: every read/by-id goes through
``kernel.auth.assert_owned`` / ``scoped``; new rows are stamped with the caller's
``tenant_id``. GRACEFUL: a window with no recordings → ``MotionSearchNotFound`` (404);
the job never 500s.

Window cap (``VE_MOTION_SEARCH_MAX_WINDOW_SEC``, default 4h): a requested window longer
than the cap is TRUNCATED to ``[from, from+cap]`` and a ``note`` records it — the search
still runs, just bounded. Documented so the frontend can warn.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import NotFoundError

from app.vms.models import Camera, MotionSearchJob, Recording

log = logging.getLogger("vision.motion_search_service")

# Default analysis-window cap: 4 hours. A longer request is truncated (+ a note) so a
# pathological range can't tie up the worker for hours. Tunable via env.
_DEFAULT_MAX_WINDOW_SEC = 4 * 3600


def max_window_sec() -> int:
    try:
        v = int((os.getenv("VE_MOTION_SEARCH_MAX_WINDOW_SEC", "") or "").strip() or _DEFAULT_MAX_WINDOW_SEC)
    except (TypeError, ValueError):
        return _DEFAULT_MAX_WINDOW_SEC
    return max(60, v)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class MotionSearchNotFound(NotFoundError):
    """No recordings in the window / job not found → 404."""


class MotionSearchService:
    """Tenant-scoped motion-search job issuer + reader over ``motion_search_jobs``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── row helpers ─────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    async def _job(self, job_id: str) -> MotionSearchJob:
        row = await self.db.get(MotionSearchJob, job_id)
        assert_owned(row, self.scope, message="motion-search job not found")
        return row

    async def _has_recordings(self, camera_id: str, from_: datetime, to: datetime) -> bool:
        """True if any owned Recording overlaps [from, to] (same rule as playback/export)."""
        stmt = (
            scoped(select(Recording.id), Recording, self.scope)
            .where(Recording.camera_id == camera_id)
            .where(Recording.start_time < to)
            .where((Recording.end_time.is_(None)) | (Recording.end_time > from_))
            .limit(1)
        )
        return (await self.db.execute(stmt)).scalar_one_or_none() is not None

    # ── create (queue) ──────────────────────────────────────────────────
    async def create(
        self,
        camera_id: str,
        from_: datetime,
        to: datetime,
        regions: list[dict],
        *,
        sensitivity: float,
        sample_fps: float,
        actor,
    ) -> MotionSearchJob:
        """Verify camera + covered recordings → clamp window → persist a QUEUED job.

        Returns the persisted row; the router maps it to ``MotionSearchJobPublic``. The
        worker runs the ffmpeg VMD analysis asynchronously and fills ``hits``.
        """
        if to <= from_:
            raise MotionSearchNotFound("empty search window (to must be after from)")
        camera = await self._camera(camera_id)

        if not await self._has_recordings(camera.id, from_, to):
            raise MotionSearchNotFound("no recordings in the requested window")

        # Enforce the window cap: truncate a too-long window and record why in the note.
        note = None
        cap = max_window_sec()
        if (to - from_).total_seconds() > cap:
            capped_to = from_ + timedelta(seconds=cap)
            note = (
                f"window truncated from {(to - from_).total_seconds():.0f}s to the "
                f"{cap}s cap (VE_MOTION_SEARCH_MAX_WINDOW_SEC)"
            )
            log.info(
                "motion-search window capped: camera=%s requested=%ss cap=%ss",
                camera.id, (to - from_).total_seconds(), cap,
            )
            to = capped_to

        row = MotionSearchJob(
            tenant_id=self.scope.tenant_id,
            camera_id=camera.id,
            from_time=from_,
            to_time=to,
            regions=[dict(r) for r in regions],
            sensitivity=float(sensitivity),
            sample_fps=float(sample_fps),
            status="queued",
            progress=0,
            hits=[],
            note=note,
            requested_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        log.info(
            "motion-search job queued: %s camera=%s [%s → %s] regions=%d",
            row.id, camera.id, from_, to, len(regions),
        )
        return row

    # ── read ────────────────────────────────────────────────────────────
    async def get(self, job_id: str) -> MotionSearchJob:
        return await self._job(job_id)
