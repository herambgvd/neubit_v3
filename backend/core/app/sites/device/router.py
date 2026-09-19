"""Device-placement routes — permission-gated, tenant-scoped.

Mounted under the api_prefix → ``{prefix}/device-placements``. Paths match the
neubit_v2 frontend contract exactly:

  * ``POST   /device-placements/register``  (the floor-plan editor's write)
  * ``GET    /device-placements/{device_id}``
  * ``PATCH  /device-placements/{device_id}``
  * ``DELETE /device-placements/{device_id}``
  * ``GET    /device-placements/by-floor/{floor_id}``
  * ``GET    /device-placements/by-zone/{zone_id}``
  * ``GET    /device-placements/index``  (estate-wide, for the map)

One route is NOT from v2, because v2 could not express what it writes:

  * ``POST   /device-placements/assign``  — start from the DEVICES and name the
    site they are in, for an explicit list of them, with or without a pin.
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
    AssignDevicesRequest,
    AssignDevicesResponse,
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
    status_code=status.HTTP_201_CREATED,
)
async def register_device(
    body: RegisterDeviceRequest,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: Annotated[User, Depends(require_permission("devices.create"))],
) -> DevicePlacementPublic:
    return await svc.register(body, actor=actor)


@router.post(
    "/assign",
    status_code=status.HTTP_200_OK,
)
async def assign_devices(
    body: AssignDevicesRequest,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: Annotated[User, Depends(require_permission("devices.create"))],
) -> AssignDevicesResponse:
    """Assign a NAMED LIST of devices to a site — the reverse of the floor plan.

    `devices.create`, not a permission of its own: this creates placements, which
    is what that permission has always meant here, and `POST /register` upserts
    under exactly the same gate. A second permission for the same write would be
    a permission an existing role does not have and cannot be told it needs.

    200 rather than 201 because a call can create some placements and move
    others; the per-device answer is in `items[].created`.
    """
    return await svc.assign(body, actor=actor)


@router.get(
    "/by-floor/{floor_id}",
    dependencies=[Depends(require_permission("devices.read"))],
)
async def list_by_floor(
    floor_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    device_type: Annotated[Optional[str], Query()] = None,
) -> DeviceListResponse:
    items = await svc.list_by_floor(floor_id, device_type=device_type)
    return DeviceListResponse(items=items, count=len(items))


@router.get(
    "/index",
    dependencies=[Depends(require_permission("devices.read"))],
)
async def estate_index(
    svc: Annotated[DevicePlacementService, Depends(_service)],
    limit: Annotated[int, Query(ge=1, le=20000)] = 5000,
) -> dict:
    """Flat placement index for the whole tenant — what the estate map joins on.

    Declared BEFORE `/{device_id}`, or "index" is read as a device id and this
    route is never reached.
    """
    items = await svc.estate_index(limit=limit)
    return {"items": items, "count": len(items)}


@router.get(
    "/by-zone/{zone_id}",
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
    dependencies=[Depends(require_permission("devices.read"))],
)
async def get_device_placement(
    device_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
) -> DevicePlacementPublic:
    return await svc.get(device_id)


@router.patch(
    "/{device_id}",
)
async def update_device_placement(
    device_id: str,
    body: UpdateDeviceRequest,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: Annotated[User, Depends(require_permission("devices.update"))],
) -> DevicePlacementPublic:
    return await svc.update(device_id, body, actor=actor)


@router.delete(
    "/{device_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_device_placement(
    device_id: str,
    svc: Annotated[DevicePlacementService, Depends(_service)],
    actor: Annotated[User, Depends(require_permission("devices.delete"))],
) -> Response:
    await svc.remove(device_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
