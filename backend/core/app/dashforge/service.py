"""Registry operations, tenant-scoped.

Every read goes through ``app.tenancy.scope.scoped`` and every by-id fetch through
``assert_owned``, so a tenant boundary is one helper call rather than a WHERE
clause each handler has to remember. ``assert_owned`` raises NOT_FOUND rather
than FORBIDDEN on purpose (see its docstring): a tenant admin must not be able to
probe which registration ids exist in another tenant.
"""

from __future__ import annotations

import uuid

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ConflictError
from ..tenancy.scope import Scope, assert_owned, scoped
from .models import DashForgeEmbed
from .schemas import EmbedCreate, EmbedUpdate


class EmbedRegistryService:
    def __init__(self, db: AsyncSession, scope: Scope, *, actor: uuid.UUID | None = None) -> None:
        self.db = db
        self.scope = scope
        self.actor = actor

    async def list_(self, *, search: str | None = None) -> tuple[list[DashForgeEmbed], int]:
        stmt = scoped(select(DashForgeEmbed), DashForgeEmbed, self.scope)
        if search:
            like = f"%{search}%"
            stmt = stmt.where(
                or_(DashForgeEmbed.name.ilike(like), DashForgeEmbed.description.ilike(like))
            )
        stmt = stmt.order_by(DashForgeEmbed.name)
        rows = list((await self.db.execute(stmt)).scalars().all())
        return rows, len(rows)

    async def get(self, embed_id: str) -> DashForgeEmbed:
        row = await self.db.get(DashForgeEmbed, embed_id)
        assert_owned(row, self.scope, message="embed registration not found")
        return row

    async def create(self, body: EmbedCreate) -> DashForgeEmbed:
        row = DashForgeEmbed(
            # A super-admin registering without a tenant creates a platform row
            # (tenant_id NULL). That row is visible to super-admins only, on BOTH
            # the list and the by-id paths. It used to be listed to no one and
            # fetchable by anyone, because `scoped()` excluded NULL while `owns()`
            # returned True for it; they now agree. If a platform-wide embed that
            # every tenant can open is wanted, it needs a real shared flag and a
            # read path of its own — not an absent tenant_id.
            tenant_id=self.scope.tenant_id,
            name=body.name.strip(),
            description=(body.description or None),
            workspace_ref=body.workspace_ref.strip(),
            dashboard_ref=body.dashboard_ref.strip(),
            scope=body.scope,
            created_by=self.actor,
        )
        self.db.add(row)
        try:
            await self.db.commit()
        except IntegrityError:
            # The unique index, surfaced as the thing it means. Letting a raw
            # constraint name reach the operator would be a 500 that reads like a
            # platform fault instead of a duplicate registration.
            await self.db.rollback()
            raise ConflictError(
                "that DashForge dashboard is already registered in this tenant"
            ) from None
        await self.db.refresh(row)
        return row

    async def update(self, embed_id: str, body: EmbedUpdate) -> DashForgeEmbed:
        row = await self.get(embed_id)
        fields = body.model_fields_set
        if "name" in fields and body.name is not None:
            row.name = body.name.strip()
        if "description" in fields:
            row.description = body.description or None
        if "workspace_ref" in fields and body.workspace_ref is not None:
            row.workspace_ref = body.workspace_ref.strip()
        if "dashboard_ref" in fields and body.dashboard_ref is not None:
            row.dashboard_ref = body.dashboard_ref.strip()
        # `scope: {}` REMOVES the lock and is a real edit; only an absent key
        # means "leave it alone". See EmbedUpdate.
        if "scope" in fields and body.scope is not None:
            row.scope = body.scope
        try:
            await self.db.commit()
        except IntegrityError:
            await self.db.rollback()
            raise ConflictError(
                "that DashForge dashboard is already registered in this tenant"
            ) from None
        await self.db.refresh(row)
        return row

    async def delete(self, embed_id: str) -> None:
        row = await self.get(embed_id)
        await self.db.delete(row)
        await self.db.commit()
