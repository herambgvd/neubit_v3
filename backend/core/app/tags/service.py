"""Tags service — CRUD + assign/unassign + reverse lookups, tenant-scoped.

Folds neubit_v2's repository + service into one scope-aware service (the v3 house
style: a service that holds the ``AsyncSession`` and routes every read through
``scoped`` and every by-id fetch through ``assert_owned``). New rows are stamped
with the caller's ``tenant_id``.

Emits domain events on the NATS spine and writes audit entries on every mutation.
``usage_count`` is derived on read (a COUNT over ``tag_links``), so it never drifts.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import record as audit_record
from ..core.errors import ConflictError
from ..tenancy.scope import Scope, assert_owned, scoped
from .events import emit
from .models import Tag, TagLink
from .schemas import (
    CreateTagRequest,
    TagAssignRequest,
    TagLinkPublic,
    TagPublic,
    UpdateTagRequest,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TagService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── internal fetch (scoped) ────────────────────────────────────

    async def _get_row(self, tag_id: str) -> Tag:
        row = await self.db.get(Tag, tag_id)
        assert_owned(row, self.scope, message="Tag not found")
        return row

    async def _usage_count(self, tag_id: str) -> int:
        return int(
            await self.db.scalar(
                select(func.count()).select_from(TagLink).where(TagLink.tag_id == tag_id)
            )
            or 0
        )

    async def _find_by_name(self, name: str) -> Tag | None:
        """Case-insensitive uniqueness check within the caller's scope."""
        stmt = scoped(
            select(Tag).where(func.lower(Tag.name) == name.strip().lower()),
            Tag,
            self.scope,
        )
        return (await self.db.execute(stmt)).scalars().first()

    # ── Public: CRUD ───────────────────────────────────────────────

    async def create(self, body: CreateTagRequest, *, actor) -> TagPublic:
        if await self._find_by_name(body.name):
            raise ConflictError(
                "A tag with this name already exists", code="TAG_NAME_TAKEN"
            )
        actor_user_id = str(getattr(actor, "id", "")) or None
        row = Tag(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            color=body.color,
            description=body.description,
            is_active=body.is_active,
            created_by=actor_user_id,
            updated_by=actor_user_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "created", row, {"name": row.name, "color": row.color})
        return TagPublic.from_row(row, usage_count=0)

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        search: str | None = None,
        is_active: bool | None = None,
    ) -> tuple[list[TagPublic], int]:
        stmt = scoped(select(Tag), Tag, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Tag), Tag, self.scope)
        if search:
            term = f"%{search.strip()}%"
            cond = Tag.name.ilike(term)
            stmt = stmt.where(cond)
            count_stmt = count_stmt.where(cond)
        if is_active is not None:
            stmt = stmt.where(Tag.is_active.is_(is_active))
            count_stmt = count_stmt.where(Tag.is_active.is_(is_active))
        stmt = stmt.order_by(Tag.name.asc(), Tag.tag_id.asc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        out = [
            TagPublic.from_row(r, usage_count=await self._usage_count(r.tag_id))
            for r in rows
        ]
        return out, total

    async def get(self, tag_id: str) -> TagPublic:
        row = await self._get_row(tag_id)
        return TagPublic.from_row(row, usage_count=await self._usage_count(tag_id))

    async def update(self, tag_id: str, body: UpdateTagRequest, *, actor) -> TagPublic:
        row = await self._get_row(tag_id)

        update = body.model_dump(exclude_none=True)
        new_name = update.get("name")
        if new_name and new_name.strip().lower() != row.name.strip().lower():
            clash = await self._find_by_name(new_name)
            if clash and clash.tag_id != tag_id:
                raise ConflictError(
                    "A tag with this name already exists", code="TAG_NAME_TAKEN"
                )

        actor_user_id = str(getattr(actor, "id", "")) or None
        if actor_user_id:
            update["updated_by"] = actor_user_id
        update["updated_at"] = _utcnow()

        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "updated", row, body.model_dump(exclude_none=True))
        return TagPublic.from_row(row, usage_count=await self._usage_count(tag_id))

    async def delete(self, tag_id: str, *, actor) -> None:
        row = await self._get_row(tag_id)
        # Remove the tag AND all of its links (the FK is ON DELETE CASCADE, but we
        # delete links explicitly so SQLite — no FK enforcement — stays consistent).
        await self.db.execute(sa_delete(TagLink).where(TagLink.tag_id == tag_id))
        await self.db.delete(row)
        await self.db.commit()
        await self._emit(actor, "deleted", row, {})

    # ── Public: assign / unassign + reverse lookups ────────────────

    async def assign(self, tag_id: str, body: TagAssignRequest, *, actor) -> TagPublic:
        row = await self._get_row(tag_id)
        actor_user_id = str(getattr(actor, "id", "")) or None
        # Idempotent: skip if the link already exists (scoped).
        existing = (
            await self.db.execute(
                scoped(select(TagLink), TagLink, self.scope).where(
                    TagLink.tag_id == tag_id,
                    TagLink.entity_type == body.entity_type,
                    TagLink.entity_id == body.entity_id,
                )
            )
        ).scalars().first()
        if existing is None:
            self.db.add(
                TagLink(
                    tenant_id=self.scope.tenant_id,
                    tag_id=tag_id,
                    entity_type=body.entity_type,
                    entity_id=body.entity_id,
                    created_by=actor_user_id,
                )
            )
            await self.db.commit()
            await self._emit(
                actor,
                "assigned",
                row,
                {"entity_type": body.entity_type, "entity_id": body.entity_id},
            )
        return TagPublic.from_row(row, usage_count=await self._usage_count(tag_id))

    async def unassign(self, tag_id: str, body: TagAssignRequest, *, actor) -> TagPublic:
        row = await self._get_row(tag_id)
        stmt = scoped(sa_delete(TagLink), TagLink, self.scope).where(
            TagLink.tag_id == tag_id,
            TagLink.entity_type == body.entity_type,
            TagLink.entity_id == body.entity_id,
        )
        result = await self.db.execute(stmt)
        await self.db.commit()
        if (result.rowcount or 0) > 0:
            await self._emit(
                actor,
                "unassigned",
                row,
                {"entity_type": body.entity_type, "entity_id": body.entity_id},
            )
        return TagPublic.from_row(row, usage_count=await self._usage_count(tag_id))

    async def tags_for_entity(
        self, entity_type: str, entity_id: str
    ) -> list[TagPublic]:
        """Every tag attached to one entity (scoped)."""
        stmt = (
            scoped(select(Tag), Tag, self.scope)
            .join(TagLink, TagLink.tag_id == Tag.tag_id)
            .where(
                TagLink.entity_type == entity_type.strip(),
                TagLink.entity_id == entity_id.strip(),
            )
            .order_by(Tag.name.asc())
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        return [TagPublic.from_row(r) for r in rows]

    async def entities_for_tag(self, tag_id: str) -> list[TagLinkPublic]:
        """Every entity a tag is attached to (scoped)."""
        await self._get_row(tag_id)  # ownership check
        stmt = (
            scoped(select(TagLink), TagLink, self.scope)
            .where(TagLink.tag_id == tag_id)
            .order_by(TagLink.entity_type.asc(), TagLink.entity_id.asc())
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        return [TagLinkPublic.from_row(r) for r in rows]

    # ── Helpers ────────────────────────────────────────────────────

    async def _emit(self, actor, event: str, row: Tag, after: dict) -> None:
        await emit(row.tenant_id, event, {"tag_id": row.tag_id, **after})
        await audit_record(
            self.db,
            actor=actor,
            action=f"tag.{event}",
            target_type="tag",
            target_id=row.tag_id,
            meta=after,
        )
