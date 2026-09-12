"""Site routes — permission-gated, tenant-scoped.

Full path mounted by ``create_base_app`` under the api_prefix → ``{prefix}/sites``.
"""

from __future__ import annotations

from typing import Annotated, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.deps import get_current_user, require_permission
from ...auth.permissions import CorePerm
from ...auth.models import User
from ...core.storage import get_storage
from ...core.uploads import read_capped, validate_image
from ...db.base import get_db
from ...tenancy.scope import Scope, get_scope
from .schemas import (
    BuildingFactsUpdate,
    CreateSiteRequest,
    EmissionFactorListResponse,
    EmissionFactorsUpdate,
    SiteListResponse,
    SitePublic,
    TariffSlabListResponse,
    TariffSlabsUpdate,
    ThreatLevelUpdate,
    UpdateSiteRequest,
)
from .service import SiteService

router = APIRouter(prefix="/sites", tags=["Sites"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    user: Annotated[User, Depends(get_current_user)],
) -> SiteService:
    # A super-admin (platform scope) is never site-confined; a tenant user is limited
    # to their User.site_ids (empty = all sites in the tenant).
    site_ids = [] if scope.is_platform else list(user.site_ids or [])
    return SiteService(db, scope, site_ids=site_ids)


@router.get(
    "",
    response_model=SiteListResponse,
    dependencies=[Depends(require_permission(CorePerm.SITES_READ))],
)
async def list_sites(
    svc: Annotated[SiteService, Depends(_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=500),
    search: Optional[str] = Query(None, max_length=100),
    is_active: Optional[bool] = Query(True),
) -> SiteListResponse:
    items, total = await svc.list_(skip=skip, limit=limit, search=search, is_active=is_active)
    return SiteListResponse(items=items, total=total, skip=skip, limit=limit)


@router.post(
    "",
    response_model=SitePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_site(
    body: CreateSiteRequest,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_CREATE)),
) -> SitePublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/tree",
    dependencies=[Depends(require_permission(CorePerm.SITES_READ))],
)
async def get_site_tree(
    svc: Annotated[SiteService, Depends(_service)],
) -> dict:
    tree = await svc.get_tree()
    return {"items": tree, "count": len(tree)}


@router.get(
    "/{site_id}",
    response_model=SitePublic,
    dependencies=[Depends(require_permission(CorePerm.SITES_READ))],
)
async def get_site(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
) -> SitePublic:
    return await svc.get(site_id)


@router.patch(
    "/{site_id}",
    response_model=SitePublic,
)
async def update_site(
    site_id: str,
    body: UpdateSiteRequest,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> SitePublic:
    return await svc.update(site_id, body, actor=actor)


@router.put(
    "/{site_id}/building-facts",
    response_model=SitePublic,
)
async def set_building_facts(
    site_id: str,
    body: BuildingFactsUpdate,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> SitePublic:
    """Record area / tariff / occupancy for this site.

    Its own route rather than a field on PATCH /sites/{id}, which applies
    `exclude_none=True` and so cannot tell a null from "not mentioned". Here the
    four fields are written as a set, so an explicit null means "not recorded" and
    BI Ratings renders "cannot rate — no area recorded". Nothing here infers a
    value.
    """
    return await svc.set_building_facts(site_id, body, actor=actor)


@router.get(
    "/{site_id}/tariff-slabs",
    response_model=TariffSlabListResponse,
    dependencies=[Depends(require_permission(CorePerm.SITES_READ))],
)
async def get_tariff_slabs(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
) -> TariffSlabListResponse:
    items = await svc.get_tariff_slabs(site_id)
    return TariffSlabListResponse(items=items, total=len(items))


@router.put(
    "/{site_id}/tariff-slabs",
    response_model=TariffSlabListResponse,
)
async def set_tariff_slabs(
    site_id: str,
    body: TariffSlabsUpdate,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> TariffSlabListResponse:
    """Replace the site's time-of-use tariff slabs — the whole list, every time.

    A full replace, so an empty list clears the set and the scalar tariff, if
    recorded, is in effect again. When any slab is in effect for a date the slabs
    override the scalar entirely, and an hour no slab covers has no price.
    Coverage is not enforced and no filler slab is invented; the UI warns about
    gaps and overlaps.
    """
    items = await svc.set_tariff_slabs(site_id, body, actor=actor)
    return TariffSlabListResponse(items=items, total=len(items))


@router.get(
    "/{site_id}/emission-factors",
    response_model=EmissionFactorListResponse,
    dependencies=[Depends(require_permission(CorePerm.SITES_READ))],
)
async def get_emission_factors(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
) -> EmissionFactorListResponse:
    items = await svc.get_emission_factors(site_id)
    return EmissionFactorListResponse(items=items, total=len(items))


@router.put(
    "/{site_id}/emission-factors",
    response_model=EmissionFactorListResponse,
)
async def set_emission_factors(
    site_id: str,
    body: EmissionFactorsUpdate,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> EmissionFactorListResponse:
    """Replace the site's emission factors (kg CO2/kWh) — full list, every time.

    Every factor carries a required `source`, because a factor with no citation is
    an invented figure. An empty list clears the set. Nothing here defaults,
    infers or seeds a value.
    """
    items = await svc.set_emission_factors(site_id, body, actor=actor)
    return EmissionFactorListResponse(items=items, total=len(items))


@router.delete(
    "/{site_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_site(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_DELETE)),
) -> Response:
    await svc.delete(site_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{site_id}/restore",
    response_model=SitePublic,
)
async def restore_site(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> SitePublic:
    return await svc.restore(site_id, actor=actor)


@router.put(
    "/{site_id}/threat-level",
)
async def update_threat_level(
    site_id: str,
    body: ThreatLevelUpdate,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> dict:
    return await svc.update_threat_level(site_id, body.threat_level, actor=actor)


@router.post(
    "/{site_id}/image",
    response_model=SitePublic,
)
async def upload_site_image(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
    file: Annotated[UploadFile, File(description="Site image")],
    scope: Annotated[Scope, Depends(get_scope)],
    actor: User = Depends(require_permission(CorePerm.SITES_UPDATE)),
) -> SitePublic:
    # The shared validator adds a magic-number check on top of the whitelist, and
    # read_capped enforces the size cap while streaming rather than after the whole
    # body is in memory. See core/uploads.py.
    content = await read_capped(file, field="Site image")
    content_type, ext = validate_image(content, file.content_type, field="Site image")
    tenant_seg = str(scope.tenant_id) if scope.tenant_id is not None else "platform"
    key = f"{tenant_seg}/sites/{site_id}/image/{uuid4().hex}{ext}"
    await get_storage().put(key, content, content_type)
    url = await get_storage().url(key)
    return await svc.update(site_id, UpdateSiteRequest(image_url=url), actor=actor)
