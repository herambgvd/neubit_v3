"""DB-backed OVERRIDES for the built-in email templates.

The built-in templates live in ``templates.DEFAULT_TEMPLATES`` (code). Admins want
those "ready templates" to be CUSTOMISABLE at runtime without a redeploy — so this
module stores per-name overrides in one small table (``email_templates``).

The contract is a simple fall-back chain: if a row exists for a template ``name``
its ``subject``/``html`` win; otherwise the code default is used (see
``templates.render_with_overrides``). An override's ``name`` may match a built-in
key (customising a ready template) OR be a brand-new custom name.

Only the persistence lives here; the render/fall-back logic stays in ``templates``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Select,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class EmailTemplate(Base):
    """One row per OVERRIDDEN template. Absence of a row = use the code default."""

    __tablename__ = "email_templates"

    # One override per template name PER TENANT, plus one platform-default (NULL).
    __table_args__ = (
        UniqueConstraint("name", "tenant_id", name="uq_email_templates_name_tenant"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Matches a DEFAULT_TEMPLATES key (to customise a built-in) or a custom name.
    # Uniqueness is now (name, tenant_id): each tenant may override a template once,
    # plus one platform-default (tenant_id NULL) row per name.
    name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    # --- multi-tenancy -----------------------------------------------------
    # The tenant this override belongs to. NULL = the PLATFORM-DEFAULT override a
    # tenant falls back to (before the code default).
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    # Jinja2 strings, same as the built-ins: ``{{ placeholders }}`` / ``{% if %}``.
    subject: Mapped[str] = mapped_column(String, nullable=False)
    html: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# --- service functions -------------------------------------------------------
# Multi-tenancy: overrides are per-tenant with a platform-default (tenant_id NULL)
# fall-back. ``get_override`` resolves the caller's tenant row first, else the
# platform-default row. Writes target the caller's OWN scope (a tenant-admin their
# tenant; a super-admin the NULL default).
def _scoped_stmt(name: str, tenant_id: uuid.UUID | None):
    stmt = select(EmailTemplate).where(EmailTemplate.name == name)
    if tenant_id is None:
        return stmt.where(EmailTemplate.tenant_id.is_(None))
    return stmt.where(EmailTemplate.tenant_id == tenant_id)


async def _row_exact(
    db: AsyncSession, name: str, tenant_id: uuid.UUID | None
) -> EmailTemplate | None:
    """The override row for EXACTLY (name, tenant_id) — no fallback."""
    return (await db.execute(_scoped_stmt(name, tenant_id))).scalar_one_or_none()


async def get_override(
    db: AsyncSession, name: str, tenant_id: uuid.UUID | None = None
) -> EmailTemplate | None:
    """Resolve the effective override for ``name``: the caller's tenant row if any,
    else the platform-default (tenant_id NULL) row, else None (use the code default).
    """
    if tenant_id is not None:
        row = await _row_exact(db, name, tenant_id)
        if row is not None:
            return row
    return await _row_exact(db, name, None)


async def upsert_override(
    db: AsyncSession, name: str, subject: str, html: str,
    tenant_id: uuid.UUID | None = None,
) -> EmailTemplate:
    """Create or update the override for (name, caller-scope), then commit."""
    row = await _row_exact(db, name, tenant_id)
    if row is None:
        row = EmailTemplate(name=name, subject=subject, html=html, tenant_id=tenant_id)
        db.add(row)
    else:
        row.subject = subject
        row.html = html
    await db.commit()
    await db.refresh(row)
    return row


async def delete_override(
    db: AsyncSession, name: str, tenant_id: uuid.UUID | None = None
) -> bool:
    """Remove the CALLER'S-scope override for ``name`` (revert to the fallback).

    Only deletes the exact (name, tenant_id) row — a tenant-admin can never delete
    the platform default. Returns True if a row was deleted.
    """
    row = await _row_exact(db, name, tenant_id)
    if row is None:
        return False
    await db.delete(row)
    await db.commit()
    return True


def list_overrides(db: AsyncSession, tenant_id: uuid.UUID | None = None) -> Select:  # noqa: ARG001
    """A Select of overrides in the caller's scope, newest first — for ``paginate``."""
    stmt = select(EmailTemplate).order_by(EmailTemplate.updated_at.desc())
    if tenant_id is None:
        return stmt.where(EmailTemplate.tenant_id.is_(None))
    return stmt.where(EmailTemplate.tenant_id == tenant_id)
