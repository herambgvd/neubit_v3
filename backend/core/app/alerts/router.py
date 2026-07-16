"""Platform alert inbox API — ``{api_prefix}/admin/alerts/...``.

Gated by ``require_superadmin``. Alerts are derived live; read/dismiss state is
persisted per super-admin.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..db.base import get_db
from ..tenancy.deps import require_superadmin
from . import service
from .models import AlertState
from .schemas import AlertListOut, AlertOut

router = APIRouter(prefix="/admin/alerts", tags=["admin", "alerts"])


class AlertKeyIn(BaseModel):
    key: str


async def _states_for(db: AsyncSession, actor_id) -> dict[str, AlertState]:
    rows = (
        await db.execute(select(AlertState).where(AlertState.actor_id == actor_id))
    ).scalars().all()
    return {s.alert_key: s for s in rows}


async def _upsert_state(db: AsyncSession, actor_id, key: str, *, read=None, dismissed=None) -> None:
    state = await db.scalar(
        select(AlertState).where(AlertState.alert_key == key, AlertState.actor_id == actor_id)
    )
    if state is None:
        state = AlertState(alert_key=key, actor_id=actor_id)
        db.add(state)
    if read is not None:
        state.read = read
    if dismissed is not None:
        state.dismissed = dismissed
    state.updated_at = datetime.now(timezone.utc)


@router.get("", response_model=AlertListOut)
async def list_alerts(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> AlertListOut:
    """Current alerts (dismissed ones excluded), with per-admin read state + unread count."""
    computed = await service.compute_alerts(db)
    states = await _states_for(db, actor.id)
    items: list[AlertOut] = []
    unread = 0
    for a in computed:
        st = states.get(a["key"])
        if st is not None and st.dismissed:
            continue
        read = bool(st.read) if st is not None else False
        if not read:
            unread += 1
        items.append(AlertOut(**a, read=read))
    return AlertListOut(items=items, total=len(items), unread=unread)


@router.post("/read", status_code=204)
async def mark_read(
    body: AlertKeyIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    await _upsert_state(db, actor.id, body.key, read=True)
    await db.commit()


@router.post("/dismiss", status_code=204)
async def dismiss(
    body: AlertKeyIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    await _upsert_state(db, actor.id, body.key, read=True, dismissed=True)
    await db.commit()


@router.post("/read-all", status_code=204)
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    """Mark every currently-active alert as read for this admin."""
    computed = await service.compute_alerts(db)
    for a in computed:
        await _upsert_state(db, actor.id, a["key"], read=True)
    await db.commit()
