"""Export worker (P4-B) — background task in ``app.main`` lifespan.

Picks QUEUED ``ExportJob`` rows and ffmpeg-concats the covered fmp4 recording segments
into a single mp4 in the downloads area, flipping each job ``queued → running → done``
(+ file_path/file_size) or ``failed`` (+ error). Follows the ``RetentionTieringWorker``
lifecycle exactly:

  * own DB session per cycle; a cancellable ``stop()``; per-cycle transient backoff.
  * BOUNDED concurrency (``VE_EXPORT_CONCURRENCY``, default 2) so several exports can run
    without saturating the box; each job is claimed atomically (``queued → running`` via
    a guarded UPDATE) so two workers/cycles never double-run one.
  * GRACEFUL by construction: missing segments, an S3-tiered window, or an ffmpeg error
    → ``status=failed`` with the reason in ``error``; one bad job never crashes the loop.

Runs estate-wide under a platform scope (it services every tenant's queue); the produced
clip is written under a per-tenant/-camera subtree of the downloads root so paths don't
collide and a tenant's exports are grouped.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone

from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.common.storage_backend import LocalBackend
from app.vms.models import Camera, ExportJob, Recording

from .ffmpeg import ExportFfmpegError, concat_segments
from .service import build_concat_plan
from .signing import build_manifest, sha256_file, sign_manifest, write_sidecar

log = logging.getLogger("vision.export_worker")

# A platform scope for the worker (it drains every tenant's queue). Never used to serve
# another tenant's data — only to claim + fulfil jobs already keyed by their tenant_id.
_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def tick_sec() -> int:
    return max(2, _env_int("VE_EXPORT_TICK_SEC", 5))


def concurrency() -> int:
    return max(1, _env_int("VE_EXPORT_CONCURRENCY", 2))


def downloads_dir() -> str:
    """Root of the downloads area (a subdir on the recordings volume by default).

    Defaults to ``<VE_RECORDINGS_DIR>/downloads`` so the export clips ride the same
    pooled volume as the segments (no extra mount needed); override with
    ``VE_DOWNLOADS_DIR`` for a dedicated volume.
    """
    explicit = os.getenv("VE_DOWNLOADS_DIR", "").strip()
    if explicit:
        return explicit.rstrip("/")
    rec = (os.getenv("VE_RECORDINGS_DIR", "").strip() or "/recordings").rstrip("/")
    return f"{rec}/downloads"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ExportWorker:
    """Estate-wide export-job drainer. Started in ``app.main`` lifespan."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False
        self._sem = asyncio.Semaphore(concurrency())

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info(
            "export worker started (tick=%ss concurrency=%s downloads=%s)",
            tick_sec(), concurrency(), downloads_dir(),
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("export worker stopped")

    async def _loop(self) -> None:
        backoff = tick_sec()
        while self._running:
            try:
                ran = await self.run_cycle()
                backoff = tick_sec()
                if not ran:
                    await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                backoff = min(backoff * 2, 300)
                log.warning("export cycle error (%s) — backing off %ss", exc, backoff)
                try:
                    await asyncio.sleep(backoff)
                except asyncio.CancelledError:
                    return

    async def run_cycle(self) -> int:
        """Claim + run up to ``concurrency`` queued jobs. Returns how many ran."""
        job_ids = await self._claim_batch(concurrency())
        if not job_ids:
            return 0
        await asyncio.gather(*(self._guarded_run(jid) for jid in job_ids))
        return len(job_ids)

    async def _claim_batch(self, limit: int) -> list[str]:
        """Atomically flip up to ``limit`` oldest queued jobs → running; return their ids.

        The guarded ``UPDATE ... WHERE status='queued'`` claim makes the transition safe
        under overlapping cycles: only rows still queued are flipped, so a job is claimed
        once. (Single-process today; the guard keeps it correct if the worker is scaled.)
        """
        claimed: list[str] = []
        async with self._sessionmaker() as db:
            rows = (
                await db.execute(
                    select(ExportJob.id)
                    .where(ExportJob.status == "queued")
                    .order_by(ExportJob.created_at.asc())
                    .limit(limit)
                )
            ).scalars().all()
            for jid in rows:
                res = await db.execute(
                    sa_update(ExportJob)
                    .where(ExportJob.id == jid, ExportJob.status == "queued")
                    .values(status="running")
                )
                if res.rowcount:
                    claimed.append(jid)
            await db.commit()
        return claimed

    async def _guarded_run(self, job_id: str) -> None:
        async with self._sem:
            try:
                await self._run_job(job_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never let a job crash the worker
                log.warning("export job %s crashed: %s", job_id, exc)
                await self._fail(job_id, f"internal error: {exc}")

    async def _run_job(self, job_id: str) -> None:
        """Resolve segments → ffmpeg concat (+ watermark) → sign → mark done/failed.

        Own DB session. Captures the job's window/tenant/camera + watermark flag up front
        so the signing manifest can be assembled after the concat without re-reading.
        """
        async with self._sessionmaker() as db:
            job = await db.get(ExportJob, job_id)
            if job is None or job.status != "running":
                return
            from_ = _aware(job.from_time)
            to = _aware(job.to_time)
            want_watermark = bool(getattr(job, "watermark", False))
            fmt = job.format or "mp4"
            tenant_id = job.tenant_id
            camera_id = job.camera_id
            requested_by = job.requested_by

            recs = (
                await db.execute(
                    select(Recording)
                    .where(Recording.camera_id == job.camera_id)
                    .where(Recording.start_time < to)
                    .where((Recording.end_time.is_(None)) | (Recording.end_time > from_))
                    .order_by(Recording.start_time.asc())
                )
            ).scalars().all()

            # Camera name for the watermark overlay (best-effort; falls back to the id).
            camera_name = camera_id
            if want_watermark:
                cam = await db.get(Camera, camera_id)
                if cam is not None and cam.name:
                    camera_name = cam.name

        if not recs:
            await self._fail(job_id, "no recordings cover the requested window")
            return

        plan = build_concat_plan(list(recs), from_, to)
        if not plan.local_only:
            await self._fail(
                job_id, "window spans S3-tiered segments (server-side staging is P4-C/P6)"
            )
            return

        # Only concat segments whose files are actually present on disk (graceful when a
        # segment was retention-pruned between queue + run). If ALL are gone → fail.
        present: list[str] = []
        for p in plan.segment_paths:
            if p and await LocalBackend.exists(p):
                present.append(p)
        if not present:
            await self._fail(job_id, "recorded segment files are missing on disk")
            return

        out_path = self._out_path(job_id)
        watermark_text = f"{camera_name}" if want_watermark else None
        try:
            await concat_segments(
                present,
                out_path,
                head_offset_sec=plan.head_offset_sec,
                duration_sec=plan.duration_sec,
                watermark_text=watermark_text,
            )
        except ExportFfmpegError as exc:
            await self._fail(job_id, str(exc))
            return

        try:
            size = os.path.getsize(out_path)
        except OSError:
            size = None

        # ── Tamper-evident signing: SHA-256 the clip + Ed25519-sign a provenance
        # manifest + write the ``<job>.manifest.json`` sidecar. Never fatal — a signing
        # gap still yields a usable clip (unsigned manifest) rather than a failed job.
        checksum = None
        signature = None
        manifest_path = self._manifest_path(job_id)
        try:
            checksum = sha256_file(out_path)
            manifest = build_manifest(
                file_name=os.path.basename(out_path),
                file_hash=checksum,
                camera_id=camera_id,
                tenant_id=str(tenant_id) if tenant_id else None,
                from_=from_,
                to=to,
                duration_sec=plan.duration_sec,
                fmt=fmt,
                watermark=want_watermark,
                exported_by=requested_by,
                exported_at=_utcnow(),
                job_id=job_id,
            )
            sidecar = sign_manifest(manifest)
            signature = sidecar.get("signature")
            write_sidecar(sidecar, manifest_path)
        except Exception as exc:  # noqa: BLE001 — signing must not fail the export
            log.warning("export %s: signing failed (%s) — clip is usable but unsigned", job_id, exc)
            manifest_path = manifest_path if os.path.exists(manifest_path) else None

        await self._complete(
            job_id, out_path, size,
            checksum=checksum, signature=signature, manifest_path=manifest_path,
        )

    def _out_path(self, job_id: str) -> str:
        """Downloads path for a job's clip: ``<downloads>/<job_id>.mp4`` (flat, unique)."""
        return os.path.join(downloads_dir(), f"{job_id}.mp4")

    def _manifest_path(self, job_id: str) -> str:
        """Sidecar path for a job: ``<downloads>/<job_id>.manifest.json`` (next to the mp4)."""
        return os.path.join(downloads_dir(), f"{job_id}.manifest.json")

    async def _complete(
        self,
        job_id: str,
        path: str,
        size: int | None,
        *,
        checksum: str | None = None,
        signature: str | None = None,
        manifest_path: str | None = None,
    ) -> None:
        async with self._sessionmaker() as db:
            job = await db.get(ExportJob, job_id)
            if job is None:
                return
            job.status = "done"
            job.file_path = path
            job.file_size = size
            job.checksum = checksum
            job.signature = signature
            job.manifest_path = manifest_path
            job.error = None
            job.finished_at = _utcnow()
            await db.commit()
        log.info(
            "export job done: %s (%s bytes, signed=%s) → %s",
            job_id, size, bool(signature), path,
        )

    async def _fail(self, job_id: str, reason: str) -> None:
        async with self._sessionmaker() as db:
            job = await db.get(ExportJob, job_id)
            if job is None:
                return
            job.status = "failed"
            job.error = reason[:2000]
            job.finished_at = _utcnow()
            await db.commit()
        log.info("export job failed: %s — %s", job_id, reason)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
