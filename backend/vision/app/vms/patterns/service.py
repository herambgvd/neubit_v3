"""Pattern service — thin tenant-scoped CRUD over ``camera_patterns``.

Mirrors ``CameraGroupService`` discipline: every read goes through ``scoped``; every
by-id fetch through ``assert_owned``; new rows stamped with the caller's ``tenant_id``.
``name`` is unique per tenant (409 on collision). Ported from neubit_v2's
``PatternRepository`` + pattern routes.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError

from app.vms.models import CameraPattern

from .schemas import PatternCreate, PatternPublic, PatternUpdate


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class PatternService:
    """Thin tenant-scoped CRUD over ``camera_patterns`` (video-wall sequences)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, pattern_id: str) -> CameraPattern:
        row = await self.db.get(CameraPattern, pattern_id)
        assert_owned(row, self.scope, message="Pattern not found")
        return row

    async def get(self, pattern_id: str) -> PatternPublic:
        return PatternPublic.from_row(await self._row(pattern_id))

    async def list_(self, *, is_active: bool | None = None) -> list[PatternPublic]:
        stmt = scoped(select(CameraPattern), CameraPattern, self.scope)
        if is_active is not None:
            stmt = stmt.where(CameraPattern.is_active == is_active)
        stmt = stmt.order_by(CameraPattern.name)
        rows = (await self.db.execute(stmt)).scalars().all()
        return [PatternPublic.from_row(r) for r in rows]

    async def create(self, body: PatternCreate, *, actor) -> PatternPublic:
        dup = await self.db.scalar(
            scoped(select(CameraPattern), CameraPattern, self.scope).where(
                CameraPattern.name == body.name
            )
        )
        if dup is not None:
            raise ConflictError("a pattern with this name already exists")
        actor_id = _actor_id(actor)
        row = CameraPattern(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            camera_group_ids=list(body.camera_group_ids or []),
            seconds=body.seconds,
            is_active=body.is_active,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return PatternPublic.from_row(row)

    async def update(self, pattern_id: str, body: PatternUpdate, *, actor) -> PatternPublic:
        row = await self._row(pattern_id)
        data = body.model_dump(exclude_unset=True)
        if "name" in data and data["name"] is not None and data["name"] != row.name:
            dup = await self.db.scalar(
                scoped(select(CameraPattern), CameraPattern, self.scope).where(
                    CameraPattern.name == data["name"], CameraPattern.id != row.id
                )
            )
            if dup is not None:
                raise ConflictError("a pattern with this name already exists")
        for k in ("name", "description", "camera_group_ids", "seconds", "is_active"):
            if k in data and data[k] is not None:
                setattr(row, k, data[k])
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return PatternPublic.from_row(row)

    async def delete(self, pattern_id: str) -> None:
        row = await self._row(pattern_id)
        await self.db.delete(row)
        await self.db.commit()
