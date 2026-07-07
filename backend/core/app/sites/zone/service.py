"""Zone service — CRUD + soft-delete/restore, tenant-scoped.

Create validates that the referenced floor is visible to the caller (same tenant,
active) and that ``site_id`` matches the floor's site. New zones inherit the
caller's ``tenant_id``. Delete is a HARD delete (matching neubit_v2's zone
semantics); restore re-activates a soft-deleted zone.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ConflictError, NotFoundError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..events import emit
from ..floor.models import Floor
from .models import Zone
from .schemas import CreateZoneRequest, UpdateZoneRequest, ZonePublic


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ZoneService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_row(self, zone_id: str) -> Zone:
        row = await self.db.get(Zone, zone_id)
        assert_owned(row, self.scope, message="Zone not found")
        return row

    async def create(self, body: CreateZoneRequest, *, actor) -> ZonePublic:
        floor = await self.db.get(Floor, body.floor_id)
        if floor is None or not floor.is_active or (
            not self.scope.is_platform and floor.tenant_id != self.scope.tenant_id
        ):
            raise NotFoundError("Floor not found or inactive")
        if floor.site_id != body.site_id:
            raise ConflictError("site_id does not match the floor's site")

        actor_user_id = str(getattr(actor, "id", "")) or None
        row = Zone(
            tenant_id=self.scope.tenant_id,
            site_id=body.site_id,
            floor_id=body.floor_id,
            name=body.name,
            description=body.description,
            zone_type=body.zone_type,
            threat_level=body.threat_level,
            color=body.color,
            alert_on_entry=body.alert_on_entry,
            alert_on_exit=body.alert_on_exit,
            max_occupancy=body.max_occupancy,
            polygon=body.polygon,
            geo_polygon=body.geo_polygon,
            created_by=actor_user_id,
            updated_by=actor_user_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "created", row, {"name": row.name, "floor_id": row.floor_id})
        return ZonePublic.from_row(row)

    async def list_(
        self,
        *,
        site_id: str | None = None,
        floor_id: str | None = None,
        skip: int = 0,
        limit: int = 20,
        search: str | None = None,
        is_active: bool | None = None,
    ) -> tuple[list[ZonePublic], int]:
        stmt = scoped(select(Zone), Zone, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Zone), Zone, self.scope)
        clauses = []
        if site_id:
            clauses.append(Zone.site_id == site_id)
        if floor_id:
            clauses.append(Zone.floor_id == floor_id)
        if search:
            clauses.append(Zone.name.ilike(f"%{search}%"))
        if is_active is not None:
            clauses.append(Zone.is_active.is_(is_active))
        for c in clauses:
            stmt = stmt.where(c)
            count_stmt = count_stmt.where(c)
        stmt = stmt.order_by(Zone.name.asc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return [ZonePublic.from_row(r) for r in rows], total

    async def get(self, zone_id: str) -> ZonePublic:
        row = await self._get_row(zone_id)
        return ZonePublic.from_row(row)

    async def update(self, zone_id: str, body: UpdateZoneRequest, *, actor) -> ZonePublic:
        row = await self._get_row(zone_id)
        update = body.model_dump(exclude_none=True)
        actor_user_id = str(getattr(actor, "id", "")) or None
        if actor_user_id:
            update["updated_by"] = actor_user_id
        update["updated_at"] = _utcnow()
        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "updated", row, body.model_dump(exclude_none=True))
        return ZonePublic.from_row(row)

    async def delete(self, zone_id: str, *, actor) -> None:
        row = await self._get_row(zone_id)
        site_id, tenant_id = row.site_id, row.tenant_id
        await self.db.execute(sa_delete(Zone).where(Zone.zone_id == zone_id))
        await self.db.commit()
        await self._emit_ids(
            actor, "deleted", zone_id=zone_id, site_id=site_id, tenant_id=tenant_id, after={}
        )

    async def restore(self, zone_id: str, *, actor) -> ZonePublic:
        row = await self._get_row(zone_id)
        actor_user_id = str(getattr(actor, "id", "")) or None
        row.is_active = True
        row.updated_by = actor_user_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "restored", row, {})
        return ZonePublic.from_row(row)

    async def _emit(self, actor, event: str, row: Zone, after: dict) -> None:
        await self._emit_ids(
            actor,
            event,
            zone_id=row.zone_id,
            site_id=row.site_id,
            tenant_id=row.tenant_id,
            after=after,
        )

    async def _emit_ids(self, actor, event, *, zone_id, site_id, tenant_id, after) -> None:
        await emit(tenant_id, "zone", event, {"zone_id": zone_id, "site_id": site_id, **after})
        await audit_record(
            self.db,
            actor=actor,
            action=f"zone.{event}",
            target_type="zone",
            target_id=zone_id,
            meta={"site_id": site_id, **after},
        )
