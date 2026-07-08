"""Device-placement routes — permission-gated, tenant-scoped.

Mounted under the api_prefix → ``{prefix}/device-placements``. Paths match the
neubit_v2 frontend contract exactly:

  * ``POST   /device-placements/register``
  * ``GET    /device-placements/{device_id}``
  * ``PATCH  /device-placements/{device_id}``
  * ``DELETE /device-placements/{device_id}``
  * ``GET    /device-placements/by-floor/{floor_id}``
  * ``GET    /device-placements/by-zone/{zone_id}``
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
    DeviceListResponse,
    DevicePlacementPublic,
    RegisterDeviceRequest,
    UpdateDeviceRequest,
)
from .service import DevicePlacementService

router = APIRouter(prefix="/device-placements", tags=["Device Placements"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope=Depends(get_scope),
) -> DevicePlacementService:
    return DevicePlacementService(db, scope)


@router.post(
    "/register",
    response_model=DevicePlacementPublic,
    status_code=status.HTTP_201_CREATED,
)
async def register_device(
    body: RegisterDeviceRequest,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: User = Depends(require_permission("devices.create")),
) -> DevicePlacementPublic:
    return await svc.register(body, actor=actor)


@router.get(
    "/by-floor/{floor_id}",
    response_model=DeviceListResponse,
    dependencies=[Depends(require_permission("devices.read"))],
)
async def list_by_floor(
    floor_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    device_type: Optional[str] = Query(None),
) -> DeviceListResponse:
    items = await svc.list_by_floor(floor_id, device_type=device_type)
    return DeviceListResponse(items=items, count=len(items))


@router.get(
    "/by-zone/{zone_id}",
    response_model=DeviceListResponse,
    dependencies=[Depends(require_permission("devices.read"))],
)
async def list_by_zone(
    zone_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
) -> DeviceListResponse:
    items = await svc.list_by_zone(zone_id)
    return DeviceListResponse(items=items, count=len(items))


@router.get(
    "/{device_id}",
    response_model=DevicePlacementPublic,
    dependencies=[Depends(require_permission("devices.read"))],
)
async def get_device_placement(
    device_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
) -> DevicePlacementPublic:
    return await svc.get(device_id)


@router.patch(
    "/{device_id}",
    response_model=DevicePlacementPublic,
)
async def update_device_placement(
    device_id: str,
    body: UpdateDeviceRequest,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: User = Depends(require_permission("devices.update")),
) -> DevicePlacementPublic:
    return await svc.update(device_id, body, actor=actor)


@router.delete(
    "/{device_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_device_placement(
    device_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: User = Depends(require_permission("devices.delete")),
) -> Response:
    await svc.remove(device_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
