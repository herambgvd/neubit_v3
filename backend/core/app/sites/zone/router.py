"""Zone routes — permission-gated, tenant-scoped.

Full path mounted under the api_prefix → ``{prefix}/zones``.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.deps import require_permission
from ...auth.models import User
from ...db.base import get_db
from ...tenancy.scope import get_scope
from .schemas import (
    CreateZoneRequest,
    UpdateZoneRequest,
    ZoneListResponse,
    ZonePublic,
)
from .service import ZoneService

router = APIRouter(prefix="/zones", tags=["Zones"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope=Depends(get_scope),
) -> ZoneService:
    return ZoneService(db, scope)


@router.get(
    "",
    response_model=ZoneListResponse,
    dependencies=[Depends(require_permission("zones.read"))],
)
async def list_zones(
    svc: Annotated[ZoneService, Depends(_service)],
    site_id: Optional[str] = Query(None),
    floor_id: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None, max_length=100),
    is_active: Optional[bool] = Query(None),
) -> ZoneListResponse:
    items, total = await svc.list_(
        site_id=site_id, floor_id=floor_id, skip=skip, limit=limit,
        search=search, is_active=is_active,
    )
    return ZoneListResponse(items=items, total=total, skip=skip, limit=limit)


@router.post(
    "",
    response_model=ZonePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_zone(
    body: CreateZoneRequest,
    svc: Annotated[ZoneService, Depends(_service)],
    actor: User = Depends(require_permission("zones.create")),
) -> ZonePublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/{zone_id}",
    response_model=ZonePublic,
    dependencies=[Depends(require_permission("zones.read"))],
)
async def get_zone(
    zone_id: str,
    svc: Annotated[ZoneService, Depends(_service)],
) -> ZonePublic:
    return await svc.get(zone_id)


@router.patch(
    "/{zone_id}",
    response_model=ZonePublic,
)
async def update_zone(
    zone_id: str,
    body: UpdateZoneRequest,
    svc: Annotated[ZoneService, Depends(_service)],
    actor: User = Depends(require_permission("zones.update")),
) -> ZonePublic:
    return await svc.update(zone_id, body, actor=actor)


@router.delete(
    "/{zone_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_zone(
    zone_id: str,
    svc: Annotated[ZoneService, Depends(_service)],
    actor: User = Depends(require_permission("zones.delete")),
) -> Response:
    await svc.delete(zone_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{zone_id}/restore",
    response_model=ZonePublic,
)
async def restore_zone(
    zone_id: str,
    svc: Annotated[ZoneService, Depends(_service)],
    actor: User = Depends(require_permission("zones.update")),
) -> ZonePublic:
    return await svc.restore(zone_id, actor=actor)
