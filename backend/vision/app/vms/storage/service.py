"""Recording integrity + default-pool bootstrap — tenant-scoped.

The storage DATA-PLANE (StoragePool/TierRule CRUD, per-pool usage, RAID
monitoring, retention + hot→cold tiering) has been RETIRED from this VMS: the
standalone NVR owns all storage/retention/tiering/RAID (it is the recorder that
writes the segments and sits on the disks). Two movers on the same ``/recordings``
volume is a data-loss race, so the VMS keeps only:

  * ``ensure_default_pool`` — seeds/promotes the tenant's default StoragePool so a
    P3-A recording always gets a ``storage_pool_id`` stamped at finalize.
  * recording integrity/lock/verify (``set_lock`` / ``verify``) + the shared
    ``compute_integrity`` helper (checksum-on-finalize + manual re-verify).

Discipline mirrors the camera/group services: every read/by-id goes through
``kernel.auth`` ``assert_owned`` / ``scoped``; new rows are stamped with the
caller's ``tenant_id``.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from app.vms.common.storage_backend import LocalBackend, S3Backend, sha256_file
from app.vms.models import Recording, StoragePool

from .schemas import RecordingIntegrityResult

log = logging.getLogger("vision.storage_service")

# Where the shared MediaMTX `recordings` volume is mounted (same in mediamtx + nvr +
# vision). The default local pool points here so P3-A segments get a pool.
DEFAULT_RECORDINGS_DIR = "/recordings"


def _recordings_dir() -> str:
    return (os.getenv("VE_RECORDINGS_DIR", "").strip() or DEFAULT_RECORDINGS_DIR)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


# S3 object keys are stored on the Recording ``path`` with this scheme prefix so
# verify can tell "this recording lives in S3" from a plain filesystem path.
S3_PATH_PREFIX = "s3://"


class StorageService:
    """Tenant-scoped default-pool bootstrap + recording integrity/lock."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── default-pool bootstrap (called at startup + on first checksum) ──
    async def ensure_default_pool(self) -> StoragePool:
        """Return the tenant's default pool, seeding a local one if none exists.

        The seeded pool points at the shared recordings volume root so P3-A segments
        (already written there by MediaMTX) get a pool assignment. Idempotent.
        """
        existing = await self.db.scalar(
            scoped(select(StoragePool), StoragePool, self.scope).where(
                StoragePool.is_default.is_(True)
            )
        )
        if existing is not None:
            return existing
        # No default yet — is there ANY pool? prefer promoting the first local one.
        any_local = await self.db.scalar(
            scoped(select(StoragePool), StoragePool, self.scope).where(
                StoragePool.pool_type == "local"
            )
        )
        if any_local is not None:
            any_local.is_default = True
            await self.db.commit()
            await self.db.refresh(any_local)
            return any_local
        root = _recordings_dir()
        row = StoragePool(
            tenant_id=self.scope.tenant_id,
            name="default-local",
            pool_type="local",
            path=root,
            priority=0,
            is_default=True,
            is_active=True,
            reachable=await LocalBackend.exists_dir(root),
            mount_state="mounted",
        )
        self.db.add(row)
        try:
            await self.db.commit()
            await self.db.refresh(row)
        except Exception:  # noqa: BLE001 — a racing seed (unique name) is fine
            await self.db.rollback()
            row = await self.db.scalar(
                scoped(select(StoragePool), StoragePool, self.scope).where(
                    StoragePool.name == "default-local"
                )
            )
        return row

    # ── recording integrity / lock ──────────────────────────────────────
    async def _recording(self, rec_id: str) -> Recording:
        row = await self.db.get(Recording, rec_id)
        assert_owned(row, self.scope, message="recording not found")
        return row

    async def set_lock(self, rec_id: str, *, locked: bool, actor, reason: str | None = None):
        row = await self._recording(rec_id)
        row.locked = locked
        if locked:
            row.locked_by = _actor_id(actor)
            row.locked_at = _utcnow()
        else:
            row.locked_by = None
            row.locked_at = None
        await self.db.commit()
        await self.db.refresh(row)
        return RecordingIntegrityResult(
            id=row.id,
            integrity_status=row.integrity_status,
            checksum=row.checksum,
            locked=row.locked,
            locked_by=row.locked_by,
        )

    async def verify(self, rec_id: str) -> RecordingIntegrityResult:
        """Recompute the SHA-256 and compare to the stored checksum.

        → ``missing`` if the file is gone, ``corrupted`` if the hash differs, else
        ``verified`` (and if no checksum was stored yet, this stores + verifies it).
        S3-backed recordings are marked ``verified`` on object-existence (a full
        re-hash would require a download — deferred; existence is the P3-B contract).
        """
        row = await self._recording(rec_id)
        await compute_integrity(self.db, self.scope, row)
        await self.db.commit()
        await self.db.refresh(row)
        return RecordingIntegrityResult(
            id=row.id,
            integrity_status=row.integrity_status,
            checksum=row.checksum,
            locked=row.locked,
            locked_by=row.locked_by,
        )


# ── shared checksum/integrity helpers (used by the recording consumer too) ────
async def compute_integrity(
    db: AsyncSession, scope: Scope, row: Recording, *, missing_as_unchecked: bool = False
) -> str:
    """Recompute + STORE the integrity status of one Recording (in-session, no commit).

    Returns the new ``integrity_status``. Handles filesystem + S3 backing:
      * S3 (path startswith ``s3://``): mark verified iff the object exists.
      * filesystem: missing → ``missing``; hash-mismatch → ``corrupted``; else
        ``verified`` (storing the checksum if none was recorded yet).

    ``missing_as_unchecked``: at FINALIZE time a segment may not be flushed/visible
    yet — treat a missing file as ``unchecked`` (backfilled later) rather than
    the harder ``missing`` verdict a manual verify uses.
    """
    path = row.path or ""
    if path.startswith(S3_PATH_PREFIX):
        pool = await db.get(StoragePool, row.storage_pool_id) if row.storage_pool_id else None
        exists = False
        if pool is not None and pool.pool_type == "s3":
            # path form: s3://<bucket>/<key>; recover the key after the bucket.
            key = _s3_key_from_path(path)
            try:
                exists = await S3Backend(pool).object_exists(key)
            except Exception:  # noqa: BLE001
                exists = False
        row.integrity_status = "verified" if exists else "missing"
        return row.integrity_status

    try:
        digest = await sha256_file(path)
    except FileNotFoundError:
        row.integrity_status = "unchecked" if missing_as_unchecked else "missing"
        return row.integrity_status
    except OSError:
        row.integrity_status = "unchecked"
        return "unchecked"

    if not row.checksum:
        row.checksum = digest
        row.integrity_status = "verified"
    elif digest == row.checksum:
        row.integrity_status = "verified"
    else:
        row.integrity_status = "corrupted"
    return row.integrity_status


def _s3_key_from_path(path: str) -> str:
    """s3://<bucket>/<key...> → <key...> (empty on malformed)."""
    body = path[len(S3_PATH_PREFIX):]
    _, _, key = body.partition("/")
    return key
