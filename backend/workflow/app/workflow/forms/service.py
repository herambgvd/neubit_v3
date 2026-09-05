"""Dynamic-form service — CRUD over form definitions."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from ..core.actor import actor_id as _actor_id
from ..core.primitives import utcnow
from .models import Form


# ── Form ───────────────────────────────────────────────────────────────


class FormService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, form_id: str) -> Form:
        row = await self.db.get(Form, form_id)
        assert_owned(row, self.scope, message="Form not found")
        return row

    async def create(self, body, *, actor) -> Form:
        row = Form(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            fields=[f.model_dump(mode="json") for f in body.fields],
            is_active=body.is_active,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_(self, *, skip=0, limit=50, is_active=None):
        stmt = scoped(select(Form), Form, self.scope)
        count = scoped(select(func.count()).select_from(Form), Form, self.scope)
        if is_active is not None:
            stmt = stmt.where(Form.is_active.is_(is_active))
            count = count.where(Form.is_active.is_(is_active))
        stmt = stmt.order_by(Form.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, form_id: str) -> Form:
        return await self._row(form_id)

    async def update(self, form_id: str, body, *, actor) -> Form:
        row = await self._row(form_id)
        data = body.model_dump(exclude_none=True)
        if "fields" in data and body.fields is not None:
            data["fields"] = [f.model_dump(mode="json") for f in body.fields]
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete(self, form_id: str) -> None:
        row = await self._row(form_id)
        row.is_active = False
        row.updated_at = utcnow()
        await self.db.commit()


