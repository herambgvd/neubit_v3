"""Site routes — permission-gated, tenant-scoped.

Full path mounted by ``create_base_app`` under the api_prefix → ``{prefix}/sites``.
"""

from __future__ import annotations

from typing import Annotated, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.deps import require_permission
from ...auth.models import User
from ...core.errors import ValidationError
from ...core.storage import get_storage
from ...db.base import get_db
from ...tenancy.scope import Scope, get_scope
from .schemas import (
    CreateSiteRequest,
    SiteListResponse,
    SitePublic,
    ThreatLevelUpdate,
    UpdateSiteRequest,
)
from .service import SiteService

router = APIRouter(prefix="/sites", tags=["Sites"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope=Depends(get_scope),
) -> SiteService:
    return SiteService(db, scope)


@router.get(
    "",
    response_model=SiteListResponse,
    dependencies=[Depends(require_permission("sites.read"))],
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
    actor: User = Depends(require_permission("sites.create")),
) -> SitePublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/tree",
    dependencies=[Depends(require_permission("sites.read"))],
)
async def get_site_tree(
    svc: Annotated[SiteService, Depends(_service)],
) -> dict:
    tree = await svc.get_tree()
    return {"items": tree, "count": len(tree)}


@router.get(
    "/{site_id}",
    response_model=SitePublic,
    dependencies=[Depends(require_permission("sites.read"))],
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
    actor: User = Depends(require_permission("sites.update")),
) -> SitePublic:
    return await svc.update(site_id, body, actor=actor)


@router.delete(
    "/{site_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_site(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission("sites.delete")),
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
    actor: User = Depends(require_permission("sites.update")),
) -> SitePublic:
    return await svc.restore(site_id, actor=actor)


@router.put(
    "/{site_id}/threat-level",
)
async def update_threat_level(
    site_id: str,
    body: ThreatLevelUpdate,
    svc: Annotated[SiteService, Depends(_service)],
    actor: User = Depends(require_permission("sites.update")),
) -> dict:
    return await svc.update_threat_level(site_id, body.threat_level, actor=actor)


_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
}


@router.post(
    "/{site_id}/image",
    response_model=SitePublic,
)
async def upload_site_image(
    site_id: str,
    svc: Annotated[SiteService, Depends(_service)],
    file: Annotated[UploadFile, File(description="Site image")],
    scope: Annotated[Scope, Depends(get_scope)],
    actor: User = Depends(require_permission("sites.update")),
) -> SitePublic:
    content_type = (file.content_type or "").lower()
    if content_type not in _IMAGE_TYPES:
        raise ValidationError(
            "Site image must be PNG, JPEG, WEBP, or SVG",
            code="UNSUPPORTED_MEDIA_TYPE",
            status_code=415,
        )
    content = await file.read()
    if len(content) > 8 * 1024 * 1024:
        raise ValidationError(
            "Site image must be 8 MiB or smaller",
            code="FILE_TOO_LARGE",
            status_code=413,
        )
    ext = _IMAGE_TYPES[content_type]
    tenant_seg = str(scope.tenant_id) if scope.tenant_id is not None else "platform"
    key = f"{tenant_seg}/sites/{site_id}/image/{uuid4().hex}{ext}"
    await get_storage().put(key, content, content_type)
    url = await get_storage().url(key)
    return await svc.update(site_id, UpdateSiteRequest(image_url=url), actor=actor)
