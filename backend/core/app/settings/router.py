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

#: `GET /settings/public` must answer without a credential — the login page and the
#: other unauthenticated screens read it. Separate router for the same reason as
#: branding's: app/app.py guards whole routers, and the guard resolves an actor.
public_router = APIRouter(prefix="/settings", tags=["settings"])


@public_router.get("/public")
async def public_settings(
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(optional_tenant_id),
) -> dict:
    """Public: the safe subset of settings the frontend needs everywhere.

    Resolves the caller's tenant values when a valid bearer token is present, else
    the platform default. Never raises on a missing or invalid token — the login
    page has to get an answer.
    """
    return await SettingsService(db, tenant_id).public_values()


@router.get("/maps")
async def get_maps_config(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> MapsConfigOut:
    """Sites Map config for the browser; any authenticated user.

    Resolves the caller's effective values (their tenant's override, else the
    platform default). The api_key is deliberately returned unmasked because the
    Maps JavaScript API loader cannot use "***" — this is the only route that does
    so, and `GET /settings` masks it. Restrict the key by HTTP referrer in Google
    Cloud Console; it is not in the unauthenticated /public subset.

    With ``google_maps_enabled`` off (the default) the browser draws the map from
    the self-hosted PMTiles archive at ``tiles_url``, which needs no key and no
    internet.
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


@router.get("")
async def get_settings_config(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> SettingsOut:
    # A tenant-admin sees their effective settings (tenant override, else platform
    # default); a super-admin (tenant_id None) sees the platform default.
    # display_values, not all_values: secret keys must come back as "***" here, the
    # settings screen never needs the real credential.
    return SettingsOut(
        catalog=catalog.CATALOG,
        values=await SettingsService(db, actor.tenant_id).display_values(),
    )


@router.put("")
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
