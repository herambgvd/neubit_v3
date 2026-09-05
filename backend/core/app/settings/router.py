"""System settings API — public read (safe subset) + gated read/write.

  GET  /settings/public   → PUBLIC: announcement banner, support email, flags — so
                            the UI can theme/announce before (and after) auth.
  GET  /settings          → SETTINGS_MANAGE: full catalog + effective values.
  PUT  /settings          → SETTINGS_MANAGE: persist overrides (audited).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user, require_permission
from ..auth.models import User
from ..auth.permissions import CorePerm
from ..core.audit import record as audit_record
from ..db.base import get_db
from ..tenancy.deps import optional_tenant_id
from . import catalog
from .schemas import MapsConfigOut, SettingsOut, UpdateSettingsIn
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


@router.get("/maps", response_model=MapsConfigOut)
async def get_maps_config(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> MapsConfigOut:
    """Sites Map config for the browser — any AUTHENTICATED user.

    Resolves the CALLER'S EFFECTIVE values (their tenant's override ← the
    platform default), so a tenant-admin who enables Maps and saves a key under
    Settings → Google Maps lights up their own Sites Map and the site form's
    address→coordinates lookup. A super-admin (tenant_id None) reads the
    platform default, as before. The api_key is intentionally returned to the
    browser (the Maps JavaScript API loader needs it); restrict it by HTTP referrer
    in Google Cloud Console. Not part of the unauthenticated /public subset.

    This is the ONLY route that reads the key unmasked, and it is deliberate: the
    loader cannot use "***". `GET /settings` masks it. The value is encrypted at
    rest either way — the `"secret": True` flag in the catalog is now enforced
    rather than merely declared.

    With ``google_maps_enabled`` off — the default — the browser draws the map
    from the self-hosted PMTiles archive at ``tiles_url`` instead, which needs no
    key and no internet.
    """
    values = await SettingsService(db, actor.tenant_id).all_values()
    return MapsConfigOut(
        enabled=bool(values.get("google_maps_enabled", False)),
        api_key=str(values.get("google_maps_api_key") or ""),
        tiles_url=str(values.get("maps_tiles_url") or "/tiles/planet.pmtiles"),
        default_lat=float(values.get("google_maps_default_lat") or 0.0),
        default_lng=float(values.get("google_maps_default_lng") or 0.0),
        default_zoom=int(values.get("google_maps_default_zoom") or 5),
    )


@router.get("", response_model=SettingsOut)
async def get_settings_config(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> SettingsOut:
    # A tenant-admin sees their effective settings (tenant override ← platform
    # default); a super-admin (tenant_id None) sees/edits the platform default.
    # display_values, not all_values: secret-flagged keys come back as "***". The
    # settings screen never needed the real credential, and this route used to hand
    # it to every holder of settings.manage on every page load.
    return SettingsOut(
        catalog=catalog.CATALOG,
        values=await SettingsService(db, actor.tenant_id).display_values(),
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
