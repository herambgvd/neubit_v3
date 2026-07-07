"""BrandingService logic — per-tenant branding with a platform-default fallback.

Resolution: the caller's TENANT branding row if it exists, else the PLATFORM-DEFAULT
row (tenant_id NULL). Writes upsert the caller's OWN scope — a tenant-admin edits
their tenant's row (created on first write from the platform default), a super-admin
(tenant_id None) edits the platform default.

``resolve`` is read-only and NEVER creates a tenant row (so a public GET for a
tenant user that hasn't customised branding just returns the platform default).
``get_or_create_default`` guarantees the single platform-default row exists — used
by internal callers (invite email, template preview) that always want a branding.

As elsewhere, the session does NOT auto-commit — mutating helpers commit explicitly.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Branding
from .schemas import UpdateBrandingIn


async def _row_for(db: AsyncSession, tenant_id: uuid.UUID | None) -> Branding | None:
    """The branding row for one scope (tenant_id, which may be NULL), or None."""
    if tenant_id is None:
        stmt = select(Branding).where(Branding.tenant_id.is_(None))
    else:
        stmt = select(Branding).where(Branding.tenant_id == tenant_id)
    return (await db.execute(stmt)).scalars().first()


async def get_or_create_default(db: AsyncSession) -> Branding:
    """Return the single PLATFORM-DEFAULT branding row, creating it if absent.

    The model column defaults (app_name, colours) apply on insert so a fresh
    deployment gets sensible branding out of the box.
    """
    row = await _row_for(db, None)
    if row is None:
        row = Branding()  # tenant_id defaults to NULL → the platform default
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def resolve(db: AsyncSession, tenant_id: uuid.UUID | None) -> Branding:
    """Read-only: the caller's tenant branding, else the platform default.

    Never creates a tenant row. Falls back to (and creates, if missing) the
    platform default so the public GET always has something to return.
    """
    if tenant_id is not None:
        row = await _row_for(db, tenant_id)
        if row is not None:
            return row
    return await get_or_create_default(db)


async def update(
    db: AsyncSession, data: UpdateBrandingIn, tenant_id: uuid.UUID | None = None
) -> Branding:
    """Apply a partial update to the CALLER'S scope branding row.

    A tenant-admin (tenant_id set) edits their own row — created on first write,
    seeded from the platform default's current values so partial edits are sane.
    A super-admin (tenant_id None) edits the platform default.
    """
    row = await _get_or_create_for_scope(db, tenant_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    await db.commit()
    await db.refresh(row)
    return row


async def set_logo(
    db: AsyncSession, logo_key: str, tenant_id: uuid.UUID | None = None
) -> Branding:
    """Point the caller's scope branding row at a newly uploaded logo (a key)."""
    row = await _get_or_create_for_scope(db, tenant_id)
    row.logo_key = logo_key
    await db.commit()
    await db.refresh(row)
    return row


async def _get_or_create_for_scope(
    db: AsyncSession, tenant_id: uuid.UUID | None
) -> Branding:
    """Fetch (or lazily create) the branding row a write should target.

    For the platform default (tenant_id None) this is get_or_create_default. For a
    tenant, the row is created on first write by COPYING the platform default's
    current field values, so a tenant that only tweaks one field keeps sane values
    for the rest instead of resetting to bare column defaults.
    """
    if tenant_id is None:
        return await get_or_create_default(db)
    row = await _row_for(db, tenant_id)
    if row is not None:
        return row
    default = await get_or_create_default(db)
    row = Branding(
        tenant_id=tenant_id,
        app_name=default.app_name,
        logo_key=default.logo_key,
        primary_color=default.primary_color,
        accent_color=default.accent_color,
        name_in_header=default.name_in_header,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
