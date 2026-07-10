"""Motion-search worker (G4) — background task in ``app.main`` lifespan.

Picks QUEUED ``MotionSearchJob`` rows and runs a non-AI ffmpeg VMD analysis over the
covering recorded fmp4 segments: for each drawn region it crops + scores per-frame
scene change (``motion_search.ffmpeg.analyze_segment``), offsets the per-segment sample
times to ABSOLUTE recording time, thresholds them into hit intervals
(``scores_to_intervals``), unions the per-region intervals, and stores them as the
job's ``hits``. Flips each job ``queued → running → done`` (+ hits/progress/note) or
``failed`` (+ error).

Follows the ``ExportWorker`` lifecycle EXACTLY (own DB session per cycle; a cancellable
``stop()``; per-cycle transient backoff; BOUNDED concurrency via a semaphore; an atomic
guarded claim so overlapping cycles never double-run a job).

GRACEFUL by construction: a missing segment file / an ffmpeg failure on ONE segment is
noted (``note``) and skipped — the job still returns the hits from the segments that DID
analyze (partial result), never crashing the loop. Only if EVERY segment is missing/
unanalyzable does the job fail.

Runs estate-wide under a platform scope (it services every tenant's queue); each job is
already keyed by its tenant_id, so the worker never serves another tenant's data.
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
from app.vms.models import MotionSearchJob, Recording

from .ffmpeg import (
    MotionFfmpegError,
    analyze_segment,
    scores_to_intervals,
    sensitivity_to_threshold,
)

log = logging.getLogger("vision.motion_search_worker")

_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)

# S3-tiered segments (``s3://`` path) live off-disk — the worker can't analyze them in
# place; it notes + skips them (partial result), same posture as export.
_S3_PREFIX = "s3://"

# A per-segment hit that abuts the next segment's opening hit is merged if the gap is
# within this many seconds (bridges motion crossing a segment boundary).
_CROSS_SEGMENT_MERGE_GAP_SEC = 2.0


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def tick_sec() -> int:
    return max(2, _env_int("VE_MOTION_SEARCH_TICK_SEC", 5))


def concurrency() -> int:
    return max(1, _env_int("VE_MOTION_SEARCH_CONCURRENCY", 2))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class MotionSearchWorker:
    """Estate-wide motion-search job drainer. Started in ``app.main`` lifespan."""

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
            "motion-search worker started (tick=%ss concurrency=%s)",
            tick_sec(), concurrency(),
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
        log.info("motion-search worker stopped")

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
                log.warning("motion-search cycle error (%s) — backing off %ss", exc, backoff)
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
        """Atomically flip up to ``limit`` oldest queued jobs → running; return their ids."""
        claimed: list[str] = []
        async with self._sessionmaker() as db:
            rows = (
                await db.execute(
                    select(MotionSearchJob.id)
                    .where(MotionSearchJob.status == "queued")
                    .order_by(MotionSearchJob.created_at.asc())
                    .limit(limit)
                )
            ).scalars().all()
            for jid in rows:
                res = await db.execute(
                    sa_update(MotionSearchJob)
                    .where(MotionSearchJob.id == jid, MotionSearchJob.status == "queued")
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
                log.warning("motion-search job %s crashed: %s", job_id, exc)
                await self._fail(job_id, f"internal error: {exc}")

    async def _run_job(self, job_id: str) -> None:
        """Resolve segments → per-region ffmpeg VMD → threshold → union hits → done/failed."""
        async with self._sessionmaker() as db:
            job = await db.get(MotionSearchJob, job_id)
            if job is None or job.status != "running":
                return
            from_ = _aware(job.from_time)
            to = _aware(job.to_time)
            regions = list(job.regions or [{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}])
            sensitivity = float(job.sensitivity if job.sensitivity is not None else 0.5)
            sample_fps = float(job.sample_fps or 4.0)
            pre_note = job.note

            recs = (
                await db.execute(
                    select(Recording)
                    .where(Recording.camera_id == job.camera_id)
                    .where(Recording.start_time < to)
                    .where((Recording.end_time.is_(None)) | (Recording.end_time > from_))
                    .order_by(Recording.start_time.asc())
                )
            ).scalars().all()

        if not recs:
            await self._fail(job_id, "no recordings cover the requested window")
            return

        threshold = sensitivity_to_threshold(sensitivity)

        # Analyze each covering segment; collect ABSOLUTE-time (t, score) samples per
        # region across all segments. Skip S3-tiered / missing / ffmpeg-failed segments
        # with a note (partial result). Progress = segments processed / total.
        notes: list[str] = []
        if pre_note:
            notes.append(pre_note)
        analyzed = 0
        skipped = 0
        # region_index -> list[(absolute_seconds, score)]
        per_region: dict[int, list[tuple[float, float]]] = {i: [] for i in range(len(regions))}

        total = len(recs)
        for idx, rec in enumerate(recs):
            path = rec.path or ""
            seg_start = _aware(rec.start_time)
            if path.startswith(_S3_PREFIX):
                skipped += 1
                continue
            if not await LocalBackend.exists(path):
                skipped += 1
                continue

            seg_base = seg_start.timestamp() if seg_start else 0.0
            seg_ok = False
            for ri, region in enumerate(regions):
                try:
                    scores = await analyze_segment(path, region, sample_fps=sample_fps)
                except MotionFfmpegError as exc:
                    # ffmpeg unavailable → abort early with a clear failure (nothing will
                    # analyze); a per-segment decode error → skip this segment.
                    if "not available" in str(exc):
                        await self._fail(job_id, f"ffmpeg unavailable: {exc}")
                        return
                    log.info("motion-search seg analyze failed (%s): %s", path, exc)
                    continue
                seg_ok = True
                for (t, s) in scores:
                    per_region[ri].append((seg_base + t, s))
            if seg_ok:
                analyzed += 1
            else:
                skipped += 1

            # Coarse progress update (best-effort; don't fail the job on a write hiccup).
            await self._set_progress(job_id, int(((idx + 1) / total) * 100))

        if analyzed == 0:
            await self._fail(
                job_id,
                "no recorded segment files were analyzable (missing on disk / tiered / decode error)",
            )
            return

        if skipped:
            notes.append(f"{skipped} of {total} segments skipped (missing/tiered/decode error)")

        # Threshold each region's absolute-time series → intervals, then UNION across
        # regions (a hit in ANY drawn region counts) into merged absolute-time hits.
        all_intervals: list[dict] = []
        for ri in range(len(regions)):
            series = sorted(per_region[ri], key=lambda p: p[0])
            all_intervals.extend(
                scores_to_intervals(
                    series,
                    threshold=threshold,
                    merge_gap_sec=_CROSS_SEGMENT_MERGE_GAP_SEC,
                    sample_fps=sample_fps,
                )
            )

        hits = _union_intervals(all_intervals)
        note = "; ".join(notes) if notes else None
        await self._complete(job_id, hits, note)

    # ── status writers ──────────────────────────────────────────────────
    async def _set_progress(self, job_id: str, progress: int) -> None:
        try:
            async with self._sessionmaker() as db:
                await db.execute(
                    sa_update(MotionSearchJob)
                    .where(MotionSearchJob.id == job_id, MotionSearchJob.status == "running")
                    .values(progress=max(0, min(100, progress)))
                )
                await db.commit()
        except Exception as exc:  # noqa: BLE001 — progress is best-effort
            log.debug("motion-search progress write failed for %s: %s", job_id, exc)

    async def _complete(self, job_id: str, hits: list[dict], note: str | None) -> None:
        async with self._sessionmaker() as db:
            job = await db.get(MotionSearchJob, job_id)
            if job is None:
                return
            job.status = "done"
            job.hits = hits
            job.note = note
            job.error = None
            job.progress = 100
            job.finished_at = _utcnow()
            await db.commit()
        log.info("motion-search job done: %s (%d hits)", job_id, len(hits))

    async def _fail(self, job_id: str, reason: str) -> None:
        async with self._sessionmaker() as db:
            job = await db.get(MotionSearchJob, job_id)
            if job is None:
                return
            job.status = "failed"
            job.error = reason[:2000]
            job.finished_at = _utcnow()
            await db.commit()
        log.info("motion-search job failed: %s — %s", job_id, reason)


def _union_intervals(intervals: list[dict]) -> list[dict]:
    """Merge overlapping/touching absolute-time intervals (seconds) → sorted hit list.

    Each input is ``{start, end, score}`` in absolute epoch seconds. Overlapping or
    touching intervals coalesce; the merged score is the PEAK. Output is ISO-8601 UTC
    ``{start, end, score}`` sorted by start — the shape the frontend plots on the
    timeline + jumps to.
    """
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda iv: iv["start"])
    merged: list[dict] = []
    for iv in ordered:
        if merged and iv["start"] <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], iv["end"])
            merged[-1]["score"] = max(merged[-1]["score"], iv["score"])
        else:
            merged.append(dict(iv))
    out: list[dict] = []
    for iv in merged:
        out.append(
            {
                "start": datetime.fromtimestamp(iv["start"], tz=timezone.utc).isoformat(),
                "end": datetime.fromtimestamp(iv["end"], tz=timezone.utc).isoformat(),
                "score": round(float(iv["score"]), 4),
            }
        )
    return out
