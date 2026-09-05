"""Threat-level service — read and set the deployment / site threat posture."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, scoped

from ..core.actor import actor_id as _actor_id
from ..core.primitives import utcnow
from ..runtime.events import emit
from .models import ThreatLevel


# ── Threat level ───────────────────────────────────────────────────────


class ThreatLevelService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def get_current(self, *, site_id: str | None = None) -> ThreatLevel | None:
        stmt = scoped(select(ThreatLevel), ThreatLevel, self.scope)
        if site_id is None:
            stmt = stmt.where(ThreatLevel.site_id.is_(None))
        else:
            stmt = stmt.where(ThreatLevel.site_id == site_id)
        return (await self.db.execute(stmt.limit(1))).scalars().first()

    async def list_(self) -> list[ThreatLevel]:
        stmt = scoped(select(ThreatLevel), ThreatLevel, self.scope).order_by(ThreatLevel.set_at.desc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def set_level(self, body, *, actor) -> ThreatLevel:
        row = await self.get_current(site_id=body.site_id)
        now = utcnow()
        prev = row.level if row else "normal"
        if row is None:
            row = ThreatLevel(
                tenant_id=self.scope.tenant_id, site_id=body.site_id, level=body.level.value,
                reason=body.reason, set_by=_actor_id(actor), set_at=now, history=[],
            )
            self.db.add(row)
        else:
            row.level = body.level.value
            row.reason = body.reason
            row.set_by = _actor_id(actor)
            row.set_at = now
            row.history = (row.history or []) + [{
                "from_level": prev, "to_level": body.level.value,
                "reason": body.reason, "set_by": _actor_id(actor), "set_at": now.isoformat(),
            }]
            row.updated_at = now
        await self.db.commit()
        await self.db.refresh(row)
        # Distinct event so the correlation engine can match posture changes.
        await emit(row.tenant_id, "threat_level", "changed",
                   {"site_id": body.site_id, "from_level": prev, "to_level": body.level.value})
        return row


