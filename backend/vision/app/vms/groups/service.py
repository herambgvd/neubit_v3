"""Camera-group service — thin tenant-scoped CRUD over ``camera_groups``.

A LOCAL grouping catalog (membership is a JSON id-list on the group row). Mirrors the
camera service discipline: every read goes through ``kernel.auth.scoped``; every by-id
fetch through ``assert_owned``; new rows are stamped with the caller's ``tenant_id``.

The per-camera ACL itself lives on ``CameraService`` (keyed on the camera target); this
module owns only the group catalog.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError

from app.vms.models import CameraGroup

from .schemas import CameraGroupCreate, CameraGroupPublic


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class CameraGroupService:
    """Thin tenant-scoped CRUD over ``camera_groups`` (LOCAL grouping catalog)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, group_id: str) -> CameraGroup:
        row = await self.db.get(CameraGroup, group_id)
        assert_owned(row, self.scope, message="Camera group not found")
        return row

    async def create(self, body: CameraGroupCreate, *, actor) -> CameraGroupPublic:
        dup = await self.db.scalar(
            scoped(select(CameraGroup), CameraGroup, self.scope).where(CameraGroup.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a camera group with this name already exists")
        actor_id = _actor_id(actor)
        row = CameraGroup(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            color=body.color,
            description=body.description,
            camera_ids=list(body.camera_ids or []),
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return CameraGroupPublic.from_row(row)

    async def list_(self) -> list[CameraGroupPublic]:
        stmt = scoped(select(CameraGroup), CameraGroup, self.scope).order_by(CameraGroup.name)
        rows = (await self.db.execute(stmt)).scalars().all()
        return [CameraGroupPublic.from_row(r) for r in rows]

    async def update(self, group_id: str, body, *, actor) -> CameraGroupPublic:
        row = await self._row(group_id)
        data = body.model_dump(exclude_unset=True)
        if "name" in data and data["name"] != row.name:
            dup = await self.db.scalar(
                scoped(select(CameraGroup), CameraGroup, self.scope).where(
                    CameraGroup.name == data["name"], CameraGroup.id != row.id
                )
            )
            if dup is not None:
                raise ConflictError("a camera group with this name already exists")
        for k in ("name", "color", "description", "camera_ids"):
            if k in data and data[k] is not None:
                setattr(row, k, data[k])
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return CameraGroupPublic.from_row(row)

    async def delete(self, group_id: str) -> None:
        row = await self._row(group_id)
        await self.db.delete(row)
        await self.db.commit()
