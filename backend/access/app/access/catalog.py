"""LOCAL access-group + schedule catalogs — faithful v2 port (NOT DDS).

Ported from ``neubit_v2/backend/gates/app/module/access_groups`` (``repositories.py``
+ ``routes.py``): these two are LOCAL, instance-scoped catalogs managed by plain
repository CRUD — they are NOT DDS write-through (unlike cardholders/cards, which
stay in ``writethrough.py``). The operator UI's *Access Groups* tab binds directly
to this surface (``GET/POST /access-groups?instance_id=`` etc.).

Tenant + instance scoping lives here:
  * The target ``instance_id`` is fetched through ``assert_owned`` → an instance in
    another tenant reads as 404, so a caller can never operate on another tenant's
    catalog.
  * Every list/by-id query is additionally constrained by ``scoped`` (tenant) AND
    ``instance_id`` (v2 was instance-scoped; v3 adds the tenant dimension).
  * New rows are stamped with the caller's ``tenant_id`` + the instance ``id``.

Faithful to v2: field names, defaults ("Door" / "Asia/Kolkata"), list ordering
(groups by ``created_at``; schedules by ``name``), and the ``group_not_found`` /
``schedule_not_found`` error codes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from .models import AccessGroup, Instance, Schedule


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _norm_windows(value: Any) -> list[dict[str, Any]]:
    """Coerce a list of TimeWindow models / dicts → plain JSON dicts (v2 shape)."""
    if not value:
        return []
    return [w.model_dump() if hasattr(w, "model_dump") else dict(w) for w in value]


class AccessGroupCatalog:
    """Tenant- + instance-scoped LOCAL access-group CRUD (v2 AccessGroupRepository)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _assert_instance(self, instance_id: str) -> Instance:
        """Validate the instance is owned by the caller's tenant (else 404)."""
        row = await self.db.get(Instance, instance_id)
        assert_owned(row, self.scope, message="Instance not found")
        return row

    async def _get_owned(self, instance_id: str, group_id: str) -> AccessGroup | None:
        stmt = scoped(select(AccessGroup), AccessGroup, self.scope).where(
            AccessGroup.id == group_id,
            AccessGroup.instance_id == instance_id,
        )
        return await self.db.scalar(stmt)

    async def list_(self, instance_id: str) -> list[AccessGroup]:
        await self._assert_instance(instance_id)
        stmt = (
            scoped(select(AccessGroup), AccessGroup, self.scope)
            .where(AccessGroup.instance_id == instance_id)
            .order_by(AccessGroup.created_at.asc())
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def get(self, instance_id: str, group_id: str) -> AccessGroup | None:
        await self._assert_instance(instance_id)
        return await self._get_owned(instance_id, group_id)

    async def create(self, instance_id: str, payload: dict[str, Any]) -> AccessGroup:
        inst = await self._assert_instance(instance_id)
        row = AccessGroup(
            tenant_id=inst.tenant_id,
            instance_id=inst.id,
            name=payload["name"],
            description=payload.get("description"),
            access_group_type=payload.get("access_group_type") or "Door",
            api_key=payload.get("api_key"),
            door_ids=list(payload.get("door_ids") or []),
            schedule_id=payload.get("schedule_id"),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def update(
        self, instance_id: str, group_id: str, fields: dict[str, Any]
    ) -> AccessGroup | None:
        await self._assert_instance(instance_id)
        row = await self._get_owned(instance_id, group_id)
        if row is None:
            return None
        for key in ("name", "description", "access_group_type", "api_key",
                    "door_ids", "schedule_id"):
            if key in fields:
                setattr(row, key, fields[key])
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete(self, instance_id: str, group_id: str) -> bool:
        await self._assert_instance(instance_id)
        row = await self._get_owned(instance_id, group_id)
        if row is None:
            return False
        await self.db.delete(row)
        await self.db.commit()
        return True


class ScheduleCatalog:
    """Tenant- + instance-scoped LOCAL schedule CRUD (v2 ScheduleRepository)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _assert_instance(self, instance_id: str) -> Instance:
        row = await self.db.get(Instance, instance_id)
        assert_owned(row, self.scope, message="Instance not found")
        return row

    async def _get_owned(self, instance_id: str, schedule_id: str) -> Schedule | None:
        stmt = scoped(select(Schedule), Schedule, self.scope).where(
            Schedule.id == schedule_id,
            Schedule.instance_id == instance_id,
        )
        return await self.db.scalar(stmt)

    async def list_(self, instance_id: str) -> list[Schedule]:
        await self._assert_instance(instance_id)
        stmt = (
            scoped(select(Schedule), Schedule, self.scope)
            .where(Schedule.instance_id == instance_id)
            .order_by(Schedule.name.asc())
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def get(self, instance_id: str, schedule_id: str) -> Schedule | None:
        await self._assert_instance(instance_id)
        return await self._get_owned(instance_id, schedule_id)

    async def create(self, instance_id: str, payload: dict[str, Any]) -> Schedule:
        inst = await self._assert_instance(instance_id)
        row = Schedule(
            tenant_id=inst.tenant_id,
            instance_id=inst.id,
            name=payload["name"],
            description=payload.get("description"),
            timezone=payload.get("timezone") or "Asia/Kolkata",
            windows=_norm_windows(payload.get("windows")),
            holidays=list(payload.get("holidays") or []),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def update(
        self, instance_id: str, schedule_id: str, fields: dict[str, Any]
    ) -> Schedule | None:
        await self._assert_instance(instance_id)
        row = await self._get_owned(instance_id, schedule_id)
        if row is None:
            return None
        if "name" in fields:
            row.name = fields["name"]
        if "description" in fields:
            row.description = fields["description"]
        if "timezone" in fields:
            row.timezone = fields["timezone"]
        if "windows" in fields:
            row.windows = _norm_windows(fields["windows"])
        if "holidays" in fields:
            row.holidays = list(fields["holidays"] or [])
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete(self, instance_id: str, schedule_id: str) -> bool:
        await self._assert_instance(instance_id)
        row = await self._get_owned(instance_id, schedule_id)
        if row is None:
            return False
        await self.db.delete(row)
        await self.db.commit()
        return True
