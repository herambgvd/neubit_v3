"""Floor service — CRUD + soft-delete/restore, tenant-scoped.

A floor's parent site must be visible to the caller (same tenant, active) at create
time; new floors inherit the caller's ``tenant_id``. Delete is a HARD delete of the
floor + its zones (matching neubit_v2's floor semantics), restore re-activates the
floor and its zones.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, func, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import NotFoundError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..events import emit
from ..site.models import Site
from ..zone.models import Zone
from .models import Floor
from .schemas import CreateFloorRequest, FloorPublic, UpdateFloorRequest


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class FloorService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_row(self, floor_id: str) -> Floor:
        row = await self.db.get(Floor, floor_id)
        assert_owned(row, self.scope, message="Floor not found")
        return row

    async def _zone_count(self, floor_id: str) -> int:
        return int(
            await self.db.scalar(
                select(func.count())
                .select_from(Zone)
                .where(Zone.floor_id == floor_id, Zone.is_active.is_(True))
            )
            or 0
        )

    async def create(self, body: CreateFloorRequest, *, actor) -> FloorPublic:
        site = await self.db.get(Site, body.site_id)
        if site is None or not site.is_active or (
            not self.scope.is_platform and site.tenant_id != self.scope.tenant_id
        ):
            raise NotFoundError("Site not found or inactive")

        actor_user_id = str(getattr(actor, "id", "")) or None
        row = Floor(
            tenant_id=self.scope.tenant_id,
            site_id=body.site_id,
            name=body.name,
            floor_number=body.floor_number,
            description=body.description,
            floorplan_url=body.floorplan_url,
            total_area=body.total_area,
            created_by=actor_user_id,
            updated_by=actor_user_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "created", row, {"name": row.name, "site_id": row.site_id})
        return FloorPublic.from_row(row, zone_count=0)

    async def list_(
        self,
        *,
        site_id: str | None = None,
        skip: int = 0,
        limit: int = 20,
        search: str | None = None,
        is_active: bool | None = None,
    ) -> tuple[list[FloorPublic], int]:
        stmt = scoped(select(Floor), Floor, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Floor), Floor, self.scope)
        clauses = []
        if site_id:
            clauses.append(Floor.site_id == site_id)
        if search:
            clauses.append(Floor.name.ilike(f"%{search}%"))
        if is_active is not None:
            clauses.append(Floor.is_active.is_(is_active))
        for c in clauses:
            stmt = stmt.where(c)
            count_stmt = count_stmt.where(c)
        stmt = stmt.order_by(
            Floor.floor_number.asc().nulls_last(), Floor.name.asc()
        ).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        out = [FloorPublic.from_row(r, zone_count=await self._zone_count(r.floor_id)) for r in rows]
        return out, total

    async def get(self, floor_id: str) -> FloorPublic:
        row = await self._get_row(floor_id)
        return FloorPublic.from_row(row, zone_count=await self._zone_count(floor_id))

    async def update(self, floor_id: str, body: UpdateFloorRequest, *, actor) -> FloorPublic:
        row = await self._get_row(floor_id)
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
        return FloorPublic.from_row(row, zone_count=await self._zone_count(floor_id))

    async def delete(self, floor_id: str, *, actor) -> None:
        row = await self._get_row(floor_id)
        site_id, tenant_id = row.site_id, row.tenant_id
        await self.db.execute(sa_delete(Zone).where(Zone.floor_id == floor_id))
        await self.db.execute(sa_delete(Floor).where(Floor.floor_id == floor_id))
        await self.db.commit()
        await self._emit_ids(
            actor, "deleted", floor_id=floor_id, site_id=site_id, tenant_id=tenant_id, after={}
        )

    async def restore(self, floor_id: str, *, actor) -> FloorPublic:
        row = await self._get_row(floor_id)
        actor_user_id = str(getattr(actor, "id", "")) or None
        now = _utcnow()
        row.is_active = True
        row.updated_by = actor_user_id
        row.updated_at = now
        await self.db.execute(
            sa_update(Zone).where(Zone.floor_id == floor_id).values(is_active=True, updated_at=now)
        )
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "restored", row, {})
        return FloorPublic.from_row(row, zone_count=await self._zone_count(floor_id))

    async def _emit(self, actor, event: str, row: Floor, after: dict) -> None:
        await self._emit_ids(
            actor,
            event,
            floor_id=row.floor_id,
            site_id=row.site_id,
            tenant_id=row.tenant_id,
            after=after,
        )

    async def _emit_ids(self, actor, event, *, floor_id, site_id, tenant_id, after) -> None:
        await emit(tenant_id, "floor", event, {"floor_id": floor_id, "site_id": site_id, **after})
        await audit_record(
            self.db,
            actor=actor,
            action=f"floor.{event}",
            target_type="floor",
            target_id=floor_id,
            meta={"site_id": site_id, **after},
        )
