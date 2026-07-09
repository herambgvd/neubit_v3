"""Clip-export control-plane service (P4-B) — tenant-scoped job issuer + reader.

Owns the export-job LIFECYCLE from the caller's side:
  * ``create`` — verify the camera + that recordings cover the window → persist a
    QUEUED ``ExportJob`` (the ``ExportWorker`` picks it up). No ffmpeg here (that's the
    worker) — the request returns immediately with ``{job_id, status:"queued"}``.
  * ``get`` — the tenant-scoped job status/result view.
  * ``resolve_download`` — the tenant-scoped path to the produced mp4 for streaming
    (404 until done; 404 if the file vanished).

Discipline mirrors the playback/recording services: every read/by-id goes through
``kernel.auth.assert_owned`` / ``scoped``; new rows are stamped with the caller's
``tenant_id``. GRACEFUL: a window with no recordings → ``ExportNotFound`` (404); the
job never 500s. Locked recordings are fine to export (export is read-only).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import NotFoundError

from app.vms.models import Camera, ExportJob, Recording

log = logging.getLogger("vision.export_service")

# S3-tiered segments (path prefixed ``s3://``) live off-disk and cannot be concatenated
# in-place — the worker skips windows that need them (a P4-C/P6 staging enhancement).
_S3_PREFIX = "s3://"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """Coerce a possibly-naive datetime to aware-UTC (SQLite read-back is naive)."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class ConcatPlan:
    """A resolved, ordered concat plan for one export window (pure — no ffmpeg here).

    ``segment_paths`` are the ordered local fmp4 files to concat; ``head_offset_sec`` is
    how far into the concatenated timeline the requested ``from`` falls (front trim);
    ``duration_sec`` is the requested span length (tail cap). ``local_only`` is False
    when any covering segment is S3-tiered (the worker then fails the job with a clear
    message rather than producing a partial clip).
    """

    def __init__(
        self,
        segment_paths: list[str],
        head_offset_sec: float,
        duration_sec: float,
        *,
        local_only: bool,
    ) -> None:
        self.segment_paths = segment_paths
        self.head_offset_sec = head_offset_sec
        self.duration_sec = duration_sec
        self.local_only = local_only


def build_concat_plan(
    recordings: list[Recording], from_: datetime, to: datetime
) -> ConcatPlan:
    """Order the covering recordings + compute head-offset/duration for the window.

    Recordings are sorted by ``start_time``; the head offset is ``from - first.start``
    clamped to >= 0 (when ``from`` falls inside the first segment). The duration is the
    requested window length ``(to - from)``. If any covering segment path is S3-tiered,
    ``local_only`` is False so the worker fails cleanly.
    """
    ordered = sorted(recordings, key=lambda r: _aware(r.start_time))
    paths = [r.path for r in ordered]
    local_only = all(not (p or "").startswith(_S3_PREFIX) for p in paths)

    head_offset = 0.0
    if ordered:
        first_start = _aware(ordered[0].start_time)
        if first_start and from_ > first_start:
            head_offset = (from_ - first_start).total_seconds()
    duration = max(0.0, (to - from_).total_seconds())
    return ConcatPlan(paths, head_offset, duration, local_only=local_only)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class ExportNotFound(NotFoundError):
    """No recordings in the window / job not found / clip not ready → 404."""


class ExportService:
    """Tenant-scoped export-job issuer + reader over ``export_jobs``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── row helpers ─────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    async def _job(self, job_id: str) -> ExportJob:
        row = await self.db.get(ExportJob, job_id)
        assert_owned(row, self.scope, message="export job not found")
        return row

    async def _has_recordings(self, camera_id: str, from_: datetime, to: datetime) -> bool:
        """True if any owned Recording overlaps [from, to] (same overlap rule as playback)."""
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
        self, camera_id: str, from_: datetime, to: datetime, fmt: str, *, actor
    ) -> ExportJob:
        """Verify camera + covered recordings → persist a QUEUED ExportJob (no ffmpeg).

        Returns the persisted row; the router maps it to ``ExportJobPublic``. The
        worker performs the concat asynchronously.
        """
        if to <= from_:
            raise ExportNotFound("empty export window (to must be after from)")
        camera = await self._camera(camera_id)

        if not await self._has_recordings(camera.id, from_, to):
            raise ExportNotFound("no recordings in the requested window")

        row = ExportJob(
            tenant_id=self.scope.tenant_id,
            camera_id=camera.id,
            from_time=from_,
            to_time=to,
            format=(fmt or "mp4").lower(),
            status="queued",
            requested_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        log.info("export job queued: %s camera=%s [%s → %s]", row.id, camera.id, from_, to)
        return row

    # ── read ────────────────────────────────────────────────────────────
    async def get(self, job_id: str) -> ExportJob:
        return await self._job(job_id)

    async def resolve_download(self, job_id: str) -> tuple[ExportJob, str]:
        """Return ``(job, file_path)`` for a DONE job whose file still exists (else 404)."""
        import os

        job = await self._job(job_id)
        if job.status != "done" or not job.file_path:
            raise ExportNotFound("export not ready")
        if not os.path.exists(job.file_path):
            raise ExportNotFound("export file no longer available")
        return job, job.file_path
