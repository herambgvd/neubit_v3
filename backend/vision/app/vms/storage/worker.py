"""Retention + tiering sweep worker (P3-B) — background task in ``app.main`` lifespan.

A periodic, tenant-aware, bounded sweep that keeps the recording store within policy:

  * RETENTION — delete recordings older than the owning camera's ``retention_days``
    (fallback ``VE_DEFAULT_RETENTION_DAYS``); when a pool exceeds ``max_size_bytes``,
    delete oldest-first until under. **Locked recordings are NEVER deleted.**
  * TIERING   — for each enabled ``TierRule``, move recordings older than
    ``after_age_hours`` from the source pool → target pool (local→S3/MinIO): copy the
    file to the target, verify, re-point ``storage_pool_id`` + ``path``, delete the
    source. Locked recordings are TIERED (re-pointed) but their bytes move too — a
    lock protects against DELETION, not against relocation.

GRACEFUL by construction: an unreachable pool, a missing file, or a failed S3 op is
logged + skipped — one bad recording/pool never crashes the sweep. Follows the
``HealthSampler`` lifecycle exactly (own DB session per cycle, cancellable ``stop()``,
per-cycle transient backoff).
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.common.storage_backend import LocalBackend, S3Backend, S3Unavailable
from app.vms.models import Camera, Recording, StoragePool, TierRule

from .service import S3_PATH_PREFIX, _s3_key_from_path

log = logging.getLogger("vision.storage_worker")

# A platform scope for the sweep (it runs estate-wide, not for one caller). Never
# used to serve another tenant's data — only to enumerate + mutate rows the policy
# targets. Reads are still filtered per-recording by the owning tenant implicitly
# (retention_days is read off the owning camera).
_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def tick_sec() -> int:
    return max(30, _env_int("VE_RETENTION_TICK_SEC", 300))


def default_retention_days() -> int:
    return max(0, _env_int("VE_DEFAULT_RETENTION_DAYS", 30))


def sweep_batch_limit() -> int:
    # Bound each cycle so a huge backlog is chipped away over several ticks.
    return max(1, _env_int("VE_RETENTION_BATCH_LIMIT", 500))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RetentionTieringWorker:
    """Estate-wide retention + tiering sweep. Started in ``app.main`` lifespan."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info(
            "retention+tiering worker started (tick=%ss default_retention=%sd batch=%s)",
            tick_sec(), default_retention_days(), sweep_batch_limit(),
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
        log.info("retention+tiering worker stopped")

    async def _loop(self) -> None:
        try:
            await asyncio.sleep(min(15, tick_sec()))
        except asyncio.CancelledError:
            return
        backoff = tick_sec()
        while self._running:
            try:
                await self.run_cycle()
                backoff = tick_sec()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                backoff = min(backoff * 2, 1800)
                log.warning("retention cycle error (%s) — backing off %ss", exc, backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                return

    async def run_cycle(self) -> dict:
        """One full pass: tier (rules) → retention (age) → capacity. Returns counts."""
        stats = {"tiered": 0, "retention_deleted": 0, "capacity_deleted": 0}
        async with self._sessionmaker() as db:
            stats["tiered"] = await self._run_tiering(db)
            stats["retention_deleted"] = await self._run_age_retention(db)
            stats["capacity_deleted"] = await self._run_capacity_retention(db)
        if any(stats.values()):
            log.info("retention cycle: %s", stats)
        return stats

    # ── tiering ─────────────────────────────────────────────────────────
    async def _run_tiering(self, db: AsyncSession) -> int:
        rules = (
            await db.execute(select(TierRule).where(TierRule.enabled.is_(True)))
        ).scalars().all()
        moved = 0
        for rule in rules:
            src = await db.get(StoragePool, rule.source_pool_id)
            dst = await db.get(StoragePool, rule.target_pool_id)
            if src is None or dst is None:
                log.info("tier rule %s skipped: pool ref missing", rule.name)
                continue
            cutoff = _utcnow() - timedelta(hours=rule.after_age_hours)
            # Recordings in the source pool older than the cutoff, still on the source
            # (a filesystem path — already-tiered s3:// rows are excluded).
            stmt = (
                select(Recording)
                .where(
                    Recording.storage_pool_id == src.id,
                    Recording.start_time <= cutoff,
                    Recording.path.notlike(f"{S3_PATH_PREFIX}%"),
                )
                .order_by(Recording.start_time)
                .limit(sweep_batch_limit())
            )
            rows = (await db.execute(stmt)).scalars().all()
            for rec in rows:
                if await self._tier_one(db, rec, src, dst):
                    moved += 1
            rule.last_run_at = _utcnow()
            await db.commit()
        return moved

    async def _tier_one(
        self, db: AsyncSession, rec: Recording, src: StoragePool, dst: StoragePool
    ) -> bool:
        """Copy one recording src→dst, re-point, delete the source. Graceful."""
        local_path = rec.path
        if not await LocalBackend.exists(local_path):
            # Source file already gone — mark missing, don't crash.
            rec.integrity_status = "missing"
            log.info("tier skip (source missing): %s", local_path)
            return False

        if dst.pool_type == "s3":
            rel = _relative_key(local_path)
            backend = S3Backend(dst)
            try:
                key = await backend.put_file(local_path, rel)
                if not await backend.object_exists(key):
                    log.info("tier verify failed (object absent) for %s", local_path)
                    return False
            except S3Unavailable as exc:
                log.info("tier to s3 pool %s failed for %s: %s", dst.name, local_path, exc)
                return False
            new_path = f"{S3_PATH_PREFIX}{dst.s3_bucket}/{key}"
        else:
            # local/nfs/smb target — a copy into the target root is out of P3-B scope
            # for the dev path (MinIO is the tier target); only re-point if the file
            # already resides under the target root. Keep it simple + graceful.
            log.info("tier to non-s3 pool %s not supported in P3-B; skipping", dst.name)
            return False

        # Re-point the row + drop the source file. A locked recording is TIERED
        # (relocated) but we still remove the now-duplicate source — the bytes are
        # preserved in the target; the lock protects against DELETION of the record.
        old_path = rec.path
        rec.storage_pool_id = dst.id
        rec.path = new_path
        rec.integrity_status = "verified"
        await db.commit()
        await LocalBackend.delete(old_path)
        log.info("tiered recording %s → %s", rec.id, new_path)
        return True

    # ── age-based retention ─────────────────────────────────────────────
    async def _run_age_retention(self, db: AsyncSession) -> int:
        """Delete recordings past their camera's retention window. Skips locked."""
        # Join to the owning camera to read its retention_days; fall back to global.
        stmt = (
            select(Recording, Camera.retention_days)
            .join(Camera, Camera.id == Recording.camera_id, isouter=True)
            .where(Recording.locked.is_(False))
            .order_by(Recording.start_time)
            .limit(sweep_batch_limit())
        )
        rows = (await db.execute(stmt)).all()
        now = _utcnow()
        deleted = 0
        for rec, cam_retention in rows:
            days = cam_retention if cam_retention is not None else default_retention_days()
            if days <= 0:
                continue  # 0 = keep forever
            age_cutoff = now - timedelta(days=days)
            start = rec.start_time
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            if start > age_cutoff:
                continue
            if await self._delete_recording(db, rec):
                deleted += 1
        if deleted:
            await db.commit()
        return deleted

    # ── capacity-based retention ────────────────────────────────────────
    async def _run_capacity_retention(self, db: AsyncSession) -> int:
        """For each capped pool over max_size, delete oldest-first until under."""
        pools = (
            await db.execute(
                select(StoragePool).where(StoragePool.max_size_bytes.isnot(None))
            )
        ).scalars().all()
        deleted = 0
        for pool in pools:
            cap = pool.max_size_bytes or 0
            if cap <= 0:
                continue
            used = await self._pool_bytes(db, pool.id)
            if used <= cap:
                continue
            # P5-A system event: a pool over its cap is a ``storage_low`` VmsEvent
            # (published on ``tenant.<id>.vms.storage.>``… no — on the camera-event
            # stream ``tenant.<id>.vms.camera.storage_low``, which workflow correlation
            # consumes via ``tenant.*.vms.>``). Best-effort; deduped per window so a
            # persistently-full pool emits once per bucket, not every tick.
            try:
                from app.vms.events.service import emit_system_event

                await emit_system_event(
                    self._sessionmaker,
                    tenant_id=pool.tenant_id,
                    event_type="storage_low",
                    title=f"Storage pool over capacity: {pool.name}",
                    severity="warning",
                    raw={"pool_id": pool.id, "used_bytes": int(used), "cap_bytes": int(cap)},
                    description=f"Pool '{pool.name}' is over its {cap}-byte cap ({used} used)",
                )
            except Exception as exc:  # noqa: BLE001 — event emit must not break retention
                log.debug("storage_low event emit failed for pool %s: %s", pool.id, exc)
            # Oldest-first, unlocked only — delete until under cap (bounded per cycle).
            stmt = (
                select(Recording)
                .where(
                    Recording.storage_pool_id == pool.id,
                    Recording.locked.is_(False),
                )
                .order_by(Recording.start_time)
                .limit(sweep_batch_limit())
            )
            rows = (await db.execute(stmt)).scalars().all()
            for rec in rows:
                if used <= cap:
                    break
                size = rec.file_size or 0
                if await self._delete_recording(db, rec):
                    used -= size
                    deleted += 1
            await db.commit()
        return deleted

    async def _pool_bytes(self, db: AsyncSession, pool_id: str) -> int:
        from sqlalchemy import func

        stmt = select(func.coalesce(func.sum(Recording.file_size), 0)).where(
            Recording.storage_pool_id == pool_id
        )
        return int((await db.execute(stmt)).scalar() or 0)

    # ── shared delete ───────────────────────────────────────────────────
    async def _delete_recording(self, db: AsyncSession, rec: Recording) -> bool:
        """Delete the file (fs or s3) + the row. Locked rows are protected upstream."""
        if rec.locked:  # defense-in-depth: never delete a locked recording.
            return False
        path = rec.path or ""
        try:
            if path.startswith(S3_PATH_PREFIX):
                pool = await db.get(StoragePool, rec.storage_pool_id) if rec.storage_pool_id else None
                if pool is not None and pool.pool_type == "s3":
                    await S3Backend(pool).delete_object(_s3_key_from_path(path))
            elif path:
                await LocalBackend.delete(path)
        except Exception as exc:  # noqa: BLE001 — file delete is best-effort
            log.info("file delete failed for %s (%s) — removing row anyway", path, exc)
        await db.delete(rec)
        return True


def _relative_key(local_path: str) -> str:
    """Turn a mounted recordings path into an object key relative to the recordings root.

    ``/recordings/cameras/<t>/<cam>/main/seg.mp4`` → ``cameras/<t>/<cam>/main/seg.mp4``.
    Falls back to the basename if the path is outside the known root.
    """
    root = (os.getenv("VE_RECORDINGS_DIR", "").strip() or "/recordings").rstrip("/")
    if local_path.startswith(root + "/"):
        return local_path[len(root) + 1:]
    return os.path.basename(local_path)
