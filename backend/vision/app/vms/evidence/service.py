"""Evidence-lock / legal-hold service (G3) — tenant-scoped CRUD + the retention seam.

Two responsibilities:

  1. The tenant-scoped CRUD surface over ``evidence_locks`` (create a hold on a camera +
     time-range, list, soft-release, hard-delete, check).

  2. The **retention seam**: ``active_locks_for_camera`` + the module-level
     ``recording_is_locked`` / ``is_locked`` helpers the retention worker
     (``storage/worker.py``) calls to decide whether a candidate recording is protected.
     A recording is protected iff an ACTIVE (``is_active``) lock for its camera overlaps
     the recording's ``[start_time, end_time]`` interval. These helpers are scope-agnostic
     (they take an explicit ``tenant_id`` / query all active locks for the camera) because
     the sweep runs estate-wide, not for one caller — but they still filter by the
     recording's own ``tenant_id`` so a lock never protects another tenant's footage.

Mirrors the PTZ / camera services for the CRUD path: every camera fetch goes through
``assert_owned`` (cross-tenant → NotFound → 404); every lock by-id is fetched via ``scoped``.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import NotFoundError, ValidationError

from app.vms.models import Camera, EvidenceLock, Recording

from .schemas import EvidenceLockCreate, EvidenceLockPublic


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


def _aware(dt: datetime | None) -> datetime | None:
    """Coerce a possibly-naive datetime (SQLite read-back) to aware-UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _overlaps(
    a_start: datetime, a_end: datetime | None, b_start: datetime, b_end: datetime
) -> bool:
    """Do intervals [a_start, a_end] and [b_start, b_end] overlap?

    A None ``a_end`` (a still-open recording segment) is treated as extending to +inf,
    so an open segment overlaps any lock that starts at/after its start.
    """
    a_s = _aware(a_start)
    a_e = _aware(a_end)
    b_s = _aware(b_start)
    b_e = _aware(b_end)
    if a_e is None:
        return a_s < b_e  # open interval: overlaps if it starts before the lock ends
    return a_s < b_e and a_e > b_s


# ── retention seam (called by storage/worker.py) ────────────────────────────
async def active_locks_for_camera(
    db: AsyncSession, camera_id: str, tenant_id
) -> list[EvidenceLock]:
    """All ACTIVE evidence locks for a camera within the recording's tenant.

    Filtered by the recording's own ``tenant_id`` so a lock only ever protects footage of
    its own tenant. Not ``scoped()`` — the retention sweep is estate-wide; the tenant
    filter here is explicit + per-recording.
    """
    stmt = (
        select(EvidenceLock)
        .where(EvidenceLock.camera_id == camera_id)
        .where(EvidenceLock.is_active.is_(True))
        .where(EvidenceLock.tenant_id == tenant_id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def recording_is_locked(db: AsyncSession, rec: Recording) -> bool:
    """True iff an ACTIVE evidence lock covers this recording's camera + time-range.

    This is the helper the retention worker calls before deleting a segment — a covered
    recording is a legal hold and is NEVER auto-deleted. Also honours the per-recording
    ``locked`` boolean (the P3-B single-recording lock) as a fast path.
    """
    if getattr(rec, "locked", False):
        return True
    locks = await active_locks_for_camera(db, rec.camera_id, rec.tenant_id)
    for lk in locks:
        if _overlaps(rec.start_time, rec.end_time, lk.start_ts, lk.end_ts):
            return True
    return False


async def is_locked(
    db: AsyncSession,
    *,
    camera_id: str,
    tenant_id,
    at: datetime | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
) -> bool:
    """Whether an active lock covers a point (``at``) or a range (``start``/``end``).

    Used by the ``GET /vms/evidence/check`` badge endpoint and available to any caller
    that needs a range test without materialising a Recording row.
    """
    if at is not None:
        start, end = at, at
    if start is None or end is None:
        raise ValidationError("provide either 'at' or both 'start' and 'end'")
    locks = await active_locks_for_camera(db, camera_id, tenant_id)
    for lk in locks:
        if _overlaps(start, end, lk.start_ts, lk.end_ts):
            return True
    return False


class EvidenceService:
    """Tenant-scoped evidence-lock CRUD over ``evidence_locks``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── resolution ───────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    async def _row(self, lock_id: str) -> EvidenceLock:
        stmt = scoped(select(EvidenceLock), EvidenceLock, self.scope).where(
            EvidenceLock.id == lock_id
        )
        row = await self.db.scalar(stmt)
        if row is None:
            raise NotFoundError("Evidence lock not found")
        return row

    # ── list ─────────────────────────────────────────────────────────────
    async def list_(
        self,
        *,
        camera_id: str | None = None,
        active_only: bool = False,
        skip: int = 0,
        limit: int = 100,
    ) -> tuple[list[EvidenceLockPublic], int]:
        stmt = scoped(select(EvidenceLock), EvidenceLock, self.scope)
        if camera_id is not None:
            await self._camera(camera_id)
            stmt = stmt.where(EvidenceLock.camera_id == camera_id)
        if active_only:
            stmt = stmt.where(EvidenceLock.is_active.is_(True))
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(EvidenceLock.created_at.desc())
                    .offset(skip)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return [EvidenceLockPublic.from_row(r) for r in rows], len(rows)

    async def get(self, lock_id: str) -> EvidenceLockPublic:
        return EvidenceLockPublic.from_row(await self._row(lock_id))

    # ── create / release / delete ────────────────────────────────────────
    async def create(self, body: EvidenceLockCreate, *, actor) -> EvidenceLockPublic:
        await self._camera(body.camera_id)
        if body.end_ts <= body.start_ts:
            raise ValidationError("end_ts must be after start_ts")
        row = EvidenceLock(
            tenant_id=self.scope.tenant_id,
            camera_id=body.camera_id,
            start_ts=body.start_ts,
            end_ts=body.end_ts,
            reason=body.reason,
            case_ref=body.case_ref,
            is_active=True,
            created_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return EvidenceLockPublic.from_row(row)

    async def release(self, lock_id: str, *, actor) -> EvidenceLockPublic:
        """Soft-release: flip is_active False + stamp released_by/at. Row is KEPT."""
        row = await self._row(lock_id)
        if row.is_active:
            row.is_active = False
            row.released_by = _actor_id(actor)
            row.released_at = _utcnow()
            await self.db.commit()
            await self.db.refresh(row)
        return EvidenceLockPublic.from_row(row)

    async def delete(self, lock_id: str) -> None:
        """Hard-remove (for a mistaken lock). Prefer ``release`` for the audit trail."""
        row = await self._row(lock_id)
        await self.db.delete(row)
        await self.db.commit()

    async def check(
        self, camera_id: str, *, at: datetime | None, start: datetime | None, end: datetime | None
    ) -> bool:
        await self._camera(camera_id)
        return await is_locked(
            self.db,
            camera_id=camera_id,
            tenant_id=self.scope.tenant_id,
            at=at,
            start=start,
            end=end,
        )
