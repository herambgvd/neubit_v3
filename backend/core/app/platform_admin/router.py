"""Super-admin PLATFORM endpoints — manage the platform-default rows + cross-tenant
audit view. Full paths under ``{api_prefix}/admin/platform/...`` and
``{api_prefix}/admin/audit``.

Everything here is gated by ``require_superadmin`` (403 otherwise).

  * GET/PATCH /admin/platform/settings — edit the platform-DEFAULT app_settings
    (tenant_id NULL) row all tenants fall back to. Reuses SettingsService with the
    platform (None) scope.
  * GET/PATCH /admin/platform/branding — edit the platform-DEFAULT branding
    (tenant_id NULL) row. Reuses branding.service with tenant_id=None.
  * GET /admin/audit — cross-tenant audit trail with an optional ?tenant_id filter
    and pagination. (The normal /audit already lets a super-admin see everything;
    this is the explicit admin view with an EXPLICIT per-tenant filter.)
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..branding import service as branding_service
from ..branding.router import _to_out as branding_to_out
from ..branding.schemas import BrandingOut, UpdateBrandingIn
from ..core.audit import AuditLog, AuditLogOut
from ..core.audit import record as audit_record
from ..core.pagination import Page, PageParams, page_params, paginate
from ..db.base import get_db
from ..settings import catalog as settings_catalog
from ..settings.schemas import SettingsOut, UpdateSettingsIn
from ..settings.service import SettingsService
from ..tenancy.deps import require_superadmin

# Mounted by create_app under the app's api_prefix, so full paths are
# {api_prefix}/admin/platform/... and {api_prefix}/admin/audit.
router = APIRouter(prefix="/admin", tags=["admin", "platform"])


# --- Platform-default settings ----------------------------------------------
@router.get("/platform/settings", response_model=SettingsOut)
async def get_platform_settings(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> SettingsOut:
    """The platform-DEFAULT (tenant_id NULL) settings all tenants fall back to.

    Scope None → the SettingsService reads/writes only the platform-default rows.
    """
    return SettingsOut(
        catalog=settings_catalog.CATALOG,
        values=await SettingsService(db, None).all_values(),
    )


@router.patch("/platform/settings", response_model=SettingsOut)
async def update_platform_settings(
    data: UpdateSettingsIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> SettingsOut:
    """Update the platform-DEFAULT settings (the fallback for every tenant)."""
    values = await SettingsService(db, None).update(data.values)
    await audit_record(
        db, actor=actor, action="platform.settings.update", target_type="settings",
        target_id="platform", meta={"keys": sorted(data.values.keys())},
    )
    return SettingsOut(catalog=settings_catalog.CATALOG, values=values)


# --- Platform-default branding ----------------------------------------------
@router.get("/platform/branding", response_model=BrandingOut)
async def get_platform_branding(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> BrandingOut:
    """The platform-DEFAULT (tenant_id NULL) branding — the default theme."""
    branding = await branding_service.get_or_create_default(db)
    return await branding_to_out(branding)


@router.patch("/platform/branding", response_model=BrandingOut)
async def update_platform_branding(
    data: UpdateBrandingIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> BrandingOut:
    """Update the platform-DEFAULT branding (name / colours / header flag).

    Logo upload uses the existing POST /branding/logo (as a super-admin, tenant_id
    None → it targets the platform-default row).
    """
    branding = await branding_service.update(db, data, tenant_id=None)
    await audit_record(
        db, actor=actor, action="platform.branding.update", target_type="branding",
        target_id="platform", meta=data.model_dump(exclude_unset=True),
    )
    return await branding_to_out(branding)


# --- Cross-tenant audit view -------------------------------------------------
@router.get("/audit", response_model=Page[AuditLogOut])
async def cross_tenant_audit(
    params: PageParams = Depends(page_params),
    tenant_id: uuid.UUID | None = Query(
        None, description="Filter to one tenant's entries; omit for all tenants."
    ),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> Page[AuditLogOut]:
    """Cross-tenant audit trail (super-admin), newest first.

    With no ``tenant_id`` filter this returns EVERY tenant's entries (plus the
    platform/system tenant_id NULL rows). With ``?tenant_id=<uuid>`` it narrows to
    that one tenant. Paginated with the standard ``?page=&page_size=`` params.
    """
    stmt = select(AuditLog).order_by(AuditLog.ts.desc())
    if tenant_id is not None:
        stmt = stmt.where(AuditLog.tenant_id == tenant_id)
    return await paginate(db, stmt, params, item_model=AuditLogOut)
