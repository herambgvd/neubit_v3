"""System settings API — public read (safe subset) + gated read/write.

  GET  /settings/public   → PUBLIC: announcement banner, support email, flags — so
                            the UI can theme/announce before (and after) auth.
  GET  /settings          → SETTINGS_MANAGE: full catalog + effective values.
  PUT  /settings          → SETTINGS_MANAGE: persist overrides (audited).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import require_permission
from ..auth.models import User
from ..auth.permissions import CorePerm
from ..core.audit import record as audit_record
from ..db.base import get_db
from ..tenancy.deps import optional_tenant_id
from . import catalog
from .schemas import SettingsOut, UpdateSettingsIn
from .service import SettingsService

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/public")
async def public_settings(
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(optional_tenant_id),
) -> dict:
    """PUBLIC — the safe subset of settings the frontend needs everywhere.

    Resolves the caller's tenant values when a (valid) bearer token is present,
    else the platform default. Never raises on a missing/invalid token — the login
    page and unauthenticated screens must always get a sane answer.
    """
    return await SettingsService(db, tenant_id).public_values()


@router.get("", response_model=SettingsOut)
async def get_settings_config(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> SettingsOut:
    # A tenant-admin sees their effective settings (tenant override ← platform
    # default); a super-admin (tenant_id None) sees/edits the platform default.
    return SettingsOut(
        catalog=catalog.CATALOG,
        values=await SettingsService(db, actor.tenant_id).all_values(),
    )


@router.put("", response_model=SettingsOut)
async def update_settings_config(
    data: UpdateSettingsIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> SettingsOut:
    # Writes upsert the caller's own scope: tenant-admin → their tenant rows;
    # super-admin → the platform-default (NULL) rows.
    values = await SettingsService(db, actor.tenant_id).update(data.values)
    await audit_record(
        db, actor=actor, action="settings.update", target_type="settings",
        target_id="system", meta={"keys": sorted(data.values.keys())},
    )
    return SettingsOut(catalog=catalog.CATALOG, values=values)
