"""Storage control-plane service (P3-B) — tenant-scoped.

Owns StoragePool + TierRule CRUD, per-pool usage, the default-pool bootstrap (so
P3-A recordings always land on a pool), and the recording integrity/lock/verify
operations. The retention+tiering SWEEP itself lives in ``worker.py`` (a lifespan
task); this service is the request-scoped surface + shared helpers.

Discipline mirrors the camera/group services:
  * every read/by-id goes through ``kernel.auth.scoped`` / ``assert_owned``; new
    rows are stamped with the caller's ``tenant_id``.
  * secrets (SMB password, S3 secret key) are ENCRYPTED via ``common.crypto`` on
    write, never returned in a public read.
  * GRACEFUL: an unreachable pool on create is not fatal — the pool is stored with
    ``reachable=False`` + a mount-error note so the operator can fix it. Only a
    genuinely invalid request (dup name, unknown pool ref) 4xx's.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import AppError, ConflictError

from app.vms.common.crypto import encrypt_secret
from app.vms.common.storage_backend import LocalBackend, S3Backend, S3Unavailable, sha256_file
from app.vms.models import Recording, StoragePool, TierRule

from .schemas import (
    RecordingIntegrityResult,
    StoragePoolCreate,
    StoragePoolPublic,
    StoragePoolUpdate,
    StoragePoolUsage,
    TierRuleCreate,
    TierRulePublic,
    TierRuleUpdate,
)

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


class StorageValidationError(AppError):
    """A request that can't be honoured (bad pool ref for a tier rule, etc.)."""

    code = "STORAGE_INVALID"
    status_code = 400


# S3 object keys are stored on the Recording ``path`` with this scheme prefix so the
# worker/verify can tell "this recording lives in S3" from a plain filesystem path.
S3_PATH_PREFIX = "s3://"


class StorageService:
    """Tenant-scoped StoragePool + TierRule CRUD + recording integrity/lock."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── pool row helpers ────────────────────────────────────────────────
    async def _pool(self, pool_id: str) -> StoragePool:
        row = await self.db.get(StoragePool, pool_id)
        assert_owned(row, self.scope, message="storage pool not found")
        return row

    async def _rule(self, rule_id: str) -> TierRule:
        row = await self.db.get(TierRule, rule_id)
        assert_owned(row, self.scope, message="tier rule not found")
        return row

    # ── StoragePool CRUD ────────────────────────────────────────────────
    async def create_pool(self, body: StoragePoolCreate, *, actor) -> StoragePoolPublic:
        dup = await self.db.scalar(
            scoped(select(StoragePool), StoragePool, self.scope).where(
                StoragePool.name == body.name
            )
        )
        if dup is not None:
            raise ConflictError("a storage pool with this name already exists")

        actor_id = _actor_id(actor)
        row = StoragePool(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            pool_type=body.pool_type,
            path=body.path,
            priority=body.priority,
            max_size_bytes=body.max_size_bytes,
            is_default=body.is_default,
            is_active=body.is_active,
            nas_server=body.nas_server,
            nas_share=body.nas_share,
            nas_protocol=body.nas_protocol,
            nas_username=body.nas_username,
            nas_enc_password=encrypt_secret(body.nas_password) if body.nas_password else None,
            nas_domain=body.nas_domain,
            nas_mount_options=body.nas_mount_options,
            s3_endpoint=body.s3_endpoint,
            s3_bucket=body.s3_bucket,
            s3_region=body.s3_region,
            s3_access_key=body.s3_access_key,
            s3_enc_secret_key=encrypt_secret(body.s3_secret_key) if body.s3_secret_key else None,
            s3_use_ssl=body.s3_use_ssl,
            raid_level=body.raid_level,
            raid_device=body.raid_device,
            created_by=actor_id,
            updated_by=actor_id,
        )
        # Validate reachability (graceful — never blocks create). For s3 also ensure
        # the bucket exists so tiering can put objects straight away.
        await self._validate_reachability(row, ensure_bucket=True)

        if row.is_default:
            await self._clear_other_defaults(exclude_id=None)
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return StoragePoolPublic.from_row(row)

    async def list_pools(self) -> list[StoragePoolPublic]:
        stmt = scoped(select(StoragePool), StoragePool, self.scope).order_by(
            StoragePool.priority.desc(), StoragePool.name
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        return [StoragePoolPublic.from_row(r) for r in rows]

    async def get_pool(self, pool_id: str) -> StoragePoolPublic:
        return StoragePoolPublic.from_row(await self._pool(pool_id))

    # ── RAID health (software-RAID / mdadm) ─────────────────────────────
    async def raid_status(self):
        """Latest software-RAID array health (unhealthy first). Node-global infra —
        the ``RaidMonitor`` worker upserts ``raid_arrays`` every poll; this just reads
        the stored snapshot + reports host availability."""
        from app.vms.common.raid_service import raid_service
        from app.vms.models import RaidArray

        from .schemas import RaidArrayOut, RaidStatusResponse

        probe = raid_service.probe_available()
        rows = (await self.db.execute(select(RaidArray))).scalars().all()
        rows = sorted(rows, key=lambda r: (r.health == "healthy", r.device))
        return RaidStatusResponse(
            available=bool(probe.get("available")),
            reason=probe.get("reason"),
            arrays=[RaidArrayOut.from_row(r) for r in rows],
        )

    async def raid_devices(self):
        """Live physical-disk list (lsblk) — candidate members for a new array."""
        from app.vms.common.raid_service import raid_service

        from .schemas import RaidDeviceOut

        return [RaidDeviceOut.model_validate(d) for d in await raid_service.list_block_devices()]

    async def update_pool(self, pool_id: str, body: StoragePoolUpdate, *, actor) -> StoragePoolPublic:
        row = await self._pool(pool_id)
        data = body.model_dump(exclude_unset=True)

        if "name" in data and data["name"] and data["name"] != row.name:
            dup = await self.db.scalar(
                scoped(select(StoragePool), StoragePool, self.scope).where(
                    StoragePool.name == data["name"], StoragePool.id != row.id
                )
            )
            if dup is not None:
                raise ConflictError("a storage pool with this name already exists")

        # Encrypt secret fields; drop the plaintext aliases from the apply set.
        if "nas_password" in data:
            pw = data.pop("nas_password")
            row.nas_enc_password = encrypt_secret(pw) if pw else None
        if "s3_secret_key" in data:
            sk = data.pop("s3_secret_key")
            row.s3_enc_secret_key = encrypt_secret(sk) if sk else None

        for k, v in data.items():
            setattr(row, k, v)

        await self._validate_reachability(row, ensure_bucket=(row.pool_type == "s3"))

        if row.is_default:
            await self._clear_other_defaults(exclude_id=row.id)

        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return StoragePoolPublic.from_row(row)

    async def delete_pool(self, pool_id: str) -> None:
        row = await self._pool(pool_id)
        # Guard: a pool still holding recordings can't be silently dropped.
        in_use = await self.db.scalar(
            scoped(select(func.count(Recording.id)), Recording, self.scope).where(
                Recording.storage_pool_id == row.id
            )
        )
        if in_use:
            raise ConflictError(
                f"storage pool holds {int(in_use)} recording(s); re-tier or delete them first"
            )
        await self.db.delete(row)
        await self.db.commit()

    async def _clear_other_defaults(self, *, exclude_id: str | None) -> None:
        """Only one default pool per tenant — clear the flag on the others."""
        stmt = scoped(
            update(StoragePool).values(is_default=False), StoragePool, self.scope
        ).where(StoragePool.is_default.is_(True))
        if exclude_id is not None:
            stmt = stmt.where(StoragePool.id != exclude_id)
        await self.db.execute(stmt)

    async def _validate_reachability(self, pool: StoragePool, *, ensure_bucket: bool) -> None:
        """Set ``reachable`` / ``mount_state`` (graceful — never raises)."""
        try:
            if pool.pool_type in ("local", "nfs", "smb"):
                root = pool.path or _recordings_dir()
                pool.path = pool.path or root
                ok = await LocalBackend.exists_dir(root)
                pool.reachable = ok
                pool.mount_state = "mounted" if ok else "error"
                pool.last_mount_error = None if ok else f"path not present/reachable: {root}"
            elif pool.pool_type == "s3":
                backend = S3Backend(pool)
                if ensure_bucket:
                    try:
                        await backend.ensure_bucket()
                    except S3Unavailable as exc:
                        log.info("s3 ensure_bucket failed for pool %s: %s", pool.name, exc)
                ok = await backend.head()
                pool.reachable = ok
                pool.last_mount_error = None if ok else "s3 endpoint/bucket unreachable"
        except Exception as exc:  # noqa: BLE001 — validation is best-effort
            log.info("pool reachability check failed for %s: %s", pool.name, exc)
            pool.reachable = False

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

    # ── pool usage ──────────────────────────────────────────────────────
    async def pool_usage(self, pool_id: str) -> StoragePoolUsage:
        pool = await self._pool(pool_id)
        count_stmt = scoped(
            select(func.count(Recording.id)), Recording, self.scope
        ).where(Recording.storage_pool_id == pool.id)
        bytes_stmt = scoped(
            select(func.coalesce(func.sum(Recording.file_size), 0)), Recording, self.scope
        ).where(Recording.storage_pool_id == pool.id)
        count = int((await self.db.execute(count_stmt)).scalar() or 0)
        used = int((await self.db.execute(bytes_stmt)).scalar() or 0)
        pct = None
        if pool.max_size_bytes:
            pct = round(used / pool.max_size_bytes * 100.0, 2)

        # Real volume stats — cross-platform (Windows drive letters + Linux mounts).
        # This is the true free/used signal for the operator, independent of RAID type;
        # on a Windows hardware-RAID node (mdadm N/A) it is the primary storage-health
        # surface. Best-effort: an unreachable path / remote pool yields no disk stats.
        disk_total = disk_used = disk_free = None
        disk_pct = None
        disk_ok = False
        path = (pool.path or "").strip()
        if path:
            try:
                import shutil

                du = await asyncio.to_thread(shutil.disk_usage, path)
                disk_total, disk_used, disk_free = du.total, du.used, du.free
                disk_pct = round(du.used / du.total * 100.0, 2) if du.total else None
                disk_ok = True
            except Exception as exc:  # noqa: BLE001 — path gone / remote / permission
                log.info("pool_usage disk stat failed for %s (%s): %s", pool.id, path, exc)

        return StoragePoolUsage(
            pool_id=pool.id,
            pool_type=pool.pool_type,
            recording_count=count,
            bytes_used=used,
            max_size_bytes=pool.max_size_bytes,
            percent_used=pct,
            disk_total_bytes=disk_total,
            disk_used_bytes=disk_used,
            disk_free_bytes=disk_free,
            disk_percent_used=disk_pct,
            disk_reachable=disk_ok,
        )

    # ── TierRule CRUD ───────────────────────────────────────────────────
    async def create_rule(self, body: TierRuleCreate, *, actor) -> TierRulePublic:
        dup = await self.db.scalar(
            scoped(select(TierRule), TierRule, self.scope).where(TierRule.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a tier rule with this name already exists")
        # Both referenced pools must exist + be owned.
        await self._pool(body.source_pool_id)
        await self._pool(body.target_pool_id)
        if body.source_pool_id == body.target_pool_id:
            raise StorageValidationError("source and target pool must differ")

        actor_id = _actor_id(actor)
        row = TierRule(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            source_pool_id=body.source_pool_id,
            target_pool_id=body.target_pool_id,
            after_age_hours=body.after_age_hours,
            enabled=body.enabled,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return TierRulePublic.from_row(row)

    async def list_rules(self) -> list[TierRulePublic]:
        stmt = scoped(select(TierRule), TierRule, self.scope).order_by(TierRule.name)
        rows = (await self.db.execute(stmt)).scalars().all()
        return [TierRulePublic.from_row(r) for r in rows]

    async def update_rule(self, rule_id: str, body: TierRuleUpdate, *, actor) -> TierRulePublic:
        row = await self._rule(rule_id)
        data = body.model_dump(exclude_unset=True)
        if "name" in data and data["name"] and data["name"] != row.name:
            dup = await self.db.scalar(
                scoped(select(TierRule), TierRule, self.scope).where(
                    TierRule.name == data["name"], TierRule.id != row.id
                )
            )
            if dup is not None:
                raise ConflictError("a tier rule with this name already exists")
        for pool_field in ("source_pool_id", "target_pool_id"):
            if pool_field in data and data[pool_field]:
                await self._pool(data[pool_field])  # ownership check
        for k, v in data.items():
            setattr(row, k, v)
        if row.source_pool_id == row.target_pool_id:
            raise StorageValidationError("source and target pool must differ")
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return TierRulePublic.from_row(row)

    async def delete_rule(self, rule_id: str) -> None:
        row = await self._rule(rule_id)
        await self.db.delete(row)
        await self.db.commit()

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


# ── shared checksum/integrity helpers (used by the consumer + worker too) ─────
async def compute_integrity(
    db: AsyncSession, scope: Scope, row: Recording, *, missing_as_unchecked: bool = False
) -> str:
    """Recompute + STORE the integrity status of one Recording (in-session, no commit).

    Returns the new ``integrity_status``. Handles filesystem + S3 backing:
      * S3 (path startswith ``s3://``): mark verified iff the object exists.
      * filesystem: missing → ``missing``; hash-mismatch → ``corrupted``; else
        ``verified`` (storing the checksum if none was recorded yet).

    ``missing_as_unchecked``: at FINALIZE time a segment may not be flushed/visible
    yet — treat a missing file as ``unchecked`` (the worker backfills) rather than
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
