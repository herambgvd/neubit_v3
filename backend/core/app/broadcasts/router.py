"""Broadcast API.

Two surfaces:
  * ``{api_prefix}/admin/broadcasts`` — super-admin CRUD (gated by require_superadmin).
  * ``{api_prefix}/broadcasts/active`` — tenant-facing read of currently active
    broadcasts for the caller's tenant (resolved from the bearer token, if any).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.audit import record as audit_record
from ..core.errors import NotFoundError, ValidationError
from ..db.base import get_db
from ..tenancy.deps import optional_tenant_id, require_superadmin
from .models import BROADCAST_SEVERITIES, BROADCAST_TARGETS, Broadcast
from .schemas import (
    ActiveBroadcastOut,
    BroadcastOut,
    CreateBroadcastIn,
    UpdateBroadcastIn,
)

# Super-admin management surface.
router = APIRouter(prefix="/admin/broadcasts", tags=["admin", "broadcasts"])
# Tenant-facing read surface.
public_router = APIRouter(prefix="/broadcasts", tags=["broadcasts"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _validate(severity: str | None, target_type: str | None) -> None:
    if severity is not None and severity not in BROADCAST_SEVERITIES:
        raise ValidationError(f"severity must be one of {BROADCAST_SEVERITIES}")
    if target_type is not None and target_type not in BROADCAST_TARGETS:
        raise ValidationError(f"target_type must be one of {BROADCAST_TARGETS}")


@router.get("", response_model=list[BroadcastOut])
async def list_broadcasts(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> list[BroadcastOut]:
    rows = (
        await db.execute(select(Broadcast).order_by(Broadcast.created_at.desc()))
    ).scalars().all()
    return [BroadcastOut.model_validate(b) for b in rows]


@router.post("", response_model=BroadcastOut, status_code=201)
async def create_broadcast(
    data: CreateBroadcastIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> BroadcastOut:
    _validate(data.severity, data.target_type)
    b = Broadcast(
        title=data.title,
        body=data.body,
        severity=data.severity,
        target_type=data.target_type,
        target_tenant_ids=[str(t) for t in data.target_tenant_ids],
        starts_at=data.starts_at,
        ends_at=data.ends_at,
        is_active=data.is_active,
        created_by=actor.id,
    )
    db.add(b)
    await db.commit()
    await db.refresh(b)
    await audit_record(
        db, actor=actor, action="broadcast.create", target_type="broadcast",
        target_id=str(b.id), meta={"title": b.title, "target": b.target_type},
    )
    return BroadcastOut.model_validate(b)


@router.patch("/{broadcast_id}", response_model=BroadcastOut)
async def update_broadcast(
    broadcast_id: uuid.UUID,
    data: UpdateBroadcastIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> BroadcastOut:
    b = await db.get(Broadcast, broadcast_id)
    if b is None:
        raise NotFoundError("broadcast not found")
    _validate(data.severity, data.target_type)
    fields = data.model_dump(exclude_unset=True)
    if "target_tenant_ids" in fields and fields["target_tenant_ids"] is not None:
        fields["target_tenant_ids"] = [str(t) for t in fields["target_tenant_ids"]]
    for k, v in fields.items():
        setattr(b, k, v)
    b.updated_at = _now()
    await db.commit()
    await db.refresh(b)
    await audit_record(
        db, actor=actor, action="broadcast.update", target_type="broadcast",
        target_id=str(b.id), meta={"keys": sorted(fields.keys())},
    )
    return BroadcastOut.model_validate(b)


@router.delete("/{broadcast_id}", status_code=204)
async def delete_broadcast(
    broadcast_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    b = await db.get(Broadcast, broadcast_id)
    if b is None:
        raise NotFoundError("broadcast not found")
    await db.delete(b)
    await db.commit()
    await audit_record(
        db, actor=actor, action="broadcast.delete", target_type="broadcast",
        target_id=str(broadcast_id), meta={"title": b.title},
    )


@public_router.get("/active", response_model=list[ActiveBroadcastOut])
async def active_broadcasts(
    db: AsyncSession = Depends(get_db),
    tenant_id: uuid.UUID | None = Depends(optional_tenant_id),
) -> list[ActiveBroadcastOut]:
    """Currently active broadcasts targeted at the caller's tenant (or all)."""
    now = _now()
    stmt = (
        select(Broadcast)
        .where(Broadcast.is_active.is_(True))
        .where(or_(Broadcast.starts_at.is_(None), Broadcast.starts_at <= now))
        .where(or_(Broadcast.ends_at.is_(None), Broadcast.ends_at >= now))
        .order_by(Broadcast.created_at.desc())
    )
    rows = (await db.execute(stmt)).scalars().all()
    tid = str(tenant_id) if tenant_id is not None else None
    out = []
    for b in rows:
        if b.target_type == "all" or (tid is not None and tid in (b.target_tenant_ids or [])):
            out.append(ActiveBroadcastOut.model_validate(b))
    return out
