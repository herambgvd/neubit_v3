"""Device-placement service — CRUD + by-floor/by-zone queries, tenant-scoped.

Ported from neubit_v2's ``module/sites/device/service.py`` + ``repository.py`` and
adapted to neubit_v3 conventions (single async ORM, ``app.tenancy.scope`` row
isolation, ``app.core.errors`` + ``app.core.audit``, NATS events via ``sites.events``).

``register`` validates that the referenced floor is visible to the caller (same
tenant, active) and that ``site_id`` matches the floor's site; if ``zone_id`` is
supplied it must belong to that site+floor (v2 semantics). Registering an already
placed ``device_id`` (within the tenant) UPDATES it in place — matching v2's
upsert-by-device_id behaviour.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ConflictError, NotFoundError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..events import emit
from ..floor.models import Floor
from ..zone.models import Zone
from .models import DevicePlacement
from .schemas import (
    DevicePlacementPublic,
    RegisterDeviceRequest,
    UpdateDeviceRequest,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DevicePlacementService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_row(self, device_id: str) -> DevicePlacement:
        stmt = scoped(
            select(DevicePlacement).where(DevicePlacement.device_id == device_id),
            DevicePlacement,
            self.scope,
        )
        row = (await self.db.execute(stmt)).scalars().first()
        if row is None:
            raise NotFoundError("Device placement not found")
        assert_owned(row, self.scope, message="Device placement not found")
        return row

    async def register(
        self, body: RegisterDeviceRequest, *, actor
    ) -> DevicePlacementPublic:
        floor = await self.db.get(Floor, body.floor_id)
        if floor is None or not floor.is_active or (
            not self.scope.is_platform and floor.tenant_id != self.scope.tenant_id
        ):
            raise NotFoundError("Floor not found or inactive")
        if floor.site_id != body.site_id:
            raise ConflictError("site_id does not match the floor's site")

        if body.zone_id:
            zone = await self.db.get(Zone, body.zone_id)
            if zone is None or not zone.is_active or (
                not self.scope.is_platform and zone.tenant_id != self.scope.tenant_id
            ):
                raise NotFoundError("Zone not found or inactive")
            if zone.site_id != body.site_id or zone.floor_id != body.floor_id:
                raise ConflictError(
                    "zone_id does not belong to the provided site_id/floor_id"
                )

        actor_user_id = str(getattr(actor, "id", "")) or None

        # Upsert-by-device_id within the tenant (v2 semantics).
        existing = (
            await self.db.execute(
                scoped(
                    select(DevicePlacement).where(
                        DevicePlacement.device_id == body.device_id
                    ),
                    DevicePlacement,
                    self.scope,
                )
            )
        ).scalars().first()

        pos = body.floor_position.model_dump()
        if existing is not None:
            existing.device_type = body.device_type
            existing.service = body.service
            existing.site_id = body.site_id
            existing.floor_id = body.floor_id
            existing.zone_id = body.zone_id
            existing.floor_position = pos
            existing.placement_metadata = body.metadata
            existing.updated_by = actor_user_id
            existing.updated_at = _utcnow()
            row = existing
            event = "placement_updated"
        else:
            row = DevicePlacement(
                tenant_id=self.scope.tenant_id,
                device_id=body.device_id,
                device_type=body.device_type,
                service=body.service,
                site_id=body.site_id,
                floor_id=body.floor_id,
                zone_id=body.zone_id,
                floor_position=pos,
                placement_metadata=body.metadata,
                created_by=actor_user_id,
                updated_by=actor_user_id,
            )
            self.db.add(row)
            event = "placed"

        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(
            actor,
            event,
            row,
            {
                "device_id": row.device_id,
                "device_type": row.device_type,
                "service": row.service,
                "floor_id": row.floor_id,
                "zone_id": row.zone_id,
            },
        )
        return DevicePlacementPublic.from_row(row)

    async def get(self, device_id: str) -> DevicePlacementPublic:
        row = await self._get_row(device_id)
        return DevicePlacementPublic.from_row(row)

    async def update(
        self, device_id: str, body: UpdateDeviceRequest, *, actor
    ) -> DevicePlacementPublic:
        row = await self._get_row(device_id)

        # If zone_id is being (re)set, validate it belongs to the row's site+floor.
        update = body.model_dump(exclude_unset=True)
        if body.zone_id:
            zone = await self.db.get(Zone, body.zone_id)
            if zone is None or not zone.is_active or (
                not self.scope.is_platform and zone.tenant_id != self.scope.tenant_id
            ):
                raise NotFoundError("Zone not found or inactive")
            if zone.site_id != row.site_id or zone.floor_id != row.floor_id:
                raise ConflictError(
                    "zone_id does not belong to the device's site_id/floor_id"
                )

        if "floor_position" in update and body.floor_position is not None:
            row.floor_position = body.floor_position.model_dump()
        if "zone_id" in update:
            row.zone_id = body.zone_id
        if "metadata" in update:
            row.placement_metadata = body.metadata

        actor_user_id = str(getattr(actor, "id", "")) or None
        if actor_user_id:
            row.updated_by = actor_user_id
        row.updated_at = _utcnow()

        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "placement_updated", row, update)
        return DevicePlacementPublic.from_row(row)

    async def remove(self, device_id: str, *, actor) -> None:
        row = await self._get_row(device_id)
        placement_id, dev_id = row.placement_id, row.device_id
        site_id, tenant_id = row.site_id, row.tenant_id
        await self.db.execute(
            sa_delete(DevicePlacement).where(
                DevicePlacement.placement_id == placement_id
            )
        )
        await self.db.commit()
        await self._emit_ids(
            actor,
            "placement_removed",
            device_id=dev_id,
            site_id=site_id,
            tenant_id=tenant_id,
            after={},
        )

    async def list_by_floor(
        self, floor_id: str, *, device_type: str | None = None
    ) -> list[DevicePlacementPublic]:
        stmt = scoped(
            select(DevicePlacement).where(DevicePlacement.floor_id == floor_id),
            DevicePlacement,
            self.scope,
        )
        if device_type:
            stmt = stmt.where(DevicePlacement.device_type == device_type)
        stmt = stmt.order_by(DevicePlacement.created_at.desc())
        rows = (await self.db.execute(stmt)).scalars().all()
        return [DevicePlacementPublic.from_row(r) for r in rows]

    async def list_by_zone(self, zone_id: str) -> list[DevicePlacementPublic]:
        stmt = scoped(
            select(DevicePlacement).where(DevicePlacement.zone_id == zone_id),
            DevicePlacement,
            self.scope,
        ).order_by(DevicePlacement.created_at.desc())
        rows = (await self.db.execute(stmt)).scalars().all()
        return [DevicePlacementPublic.from_row(r) for r in rows]

    async def _emit(self, actor, event: str, row: DevicePlacement, after: dict) -> None:
        await self._emit_ids(
            actor,
            event,
            device_id=row.device_id,
            site_id=row.site_id,
            tenant_id=row.tenant_id,
            after=after,
        )

    async def _emit_ids(
        self, actor, event, *, device_id, site_id, tenant_id, after
    ) -> None:
        await emit(
            tenant_id,
            "device_placement",
            event,
            {"device_id": device_id, "site_id": site_id, **after},
        )
        await audit_record(
            self.db,
            actor=actor,
            action=f"device_placement.{event}",
            target_type="device_placement",
            target_id=device_id,
            meta={"site_id": site_id, **after},
        )
