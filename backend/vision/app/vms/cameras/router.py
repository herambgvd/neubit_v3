"""Camera-onboarding router — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with a ``/vms`` domain prefix,
so paths are ``/api/v1/vms/...``. Every endpoint is gated by a ``vms.*`` permission
via ``kernel.auth.require_permission`` and runs inside the caller's tenant scope
(``get_scope``) — mirroring the access service's router. The permission keys are
added to core's catalog in P1-G; until then the tenant-admin ``*`` wildcard grants
everything, so testing works.

Camera side only (NVR onboarding = the ``nvr`` package; groups + per-camera ACL =
the ``groups`` package). Discovery / probe / snapshot degrade gracefully against
unreachable hosts — they NEVER 500 (empty result / 502 on a snapshot with no frame).
Explicit operator actions (ptz / imaging / io writes) surface a driver failure as a
clean 502.

Endpoints:
  * Cameras: ``GET/POST /cameras``, ``GET/PATCH/DELETE /cameras/{id}``,
    ``POST /cameras/bulk``, ``POST /cameras/reorder``.
  * Discovery: ``POST /cameras/onvif/{discover|probe|channels|bulk-add|snapshot}``.
  * Config: ``{id}/ptz``, ``{id}/imaging``, ``{id}/io``, ``{id}/motion-config``,
    ``{id}/privacy-masks``, ``{id}/motion-zones``, ``{id}/onvif-events``, ``{id}/snapshot``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from app.vms.drivers import DriverError, PtzCommand
from .schemas import (
    BulkAddBody,
    BulkResult,
    CameraBulkBody,
    CameraCreate,
    CameraListResponse,
    CameraPublic,
    CameraReorderBody,
    CameraUpdate,
    ChannelsBody,
    ChannelsResponse,
    ConfigResult,
    DiscoverBody,
    DiscoverResponse,
    ImagingBody,
    IoBody,
    MotionConfigBody,
    MotionZonesBody,
    OnvifEventsBody,
    PrivacyMasksBody,
    ProbeBody,
    ProbeResponse,
    PtzBody,
    ReorderResult,
    SnapshotBody,
)
from .service import CameraService

# Permission keys this service gates on (added to core's catalog in P1-G; the
# tenant-admin "*" wildcard already grants them today).
PERM_READ = "vms.camera.read"
PERM_MANAGE = "vms.camera.manage"
PERM_CONFIG = "vms.config.manage"
PERM_PTZ = "vms.ptz.control"

router = APIRouter(prefix="/vms", tags=["VMS Cameras"])


async def get_camera_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> CameraService:
    return CameraService(db, scope)


def _driver_err(exc: DriverError) -> HTTPException:
    """Translate a driver failure (an explicit operator action) into a clean 502."""
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


# ── Camera CRUD ────────────────────────────────────────────────────────


@router.get(
    "/cameras",
    response_model=CameraListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_cameras(
    svc: Annotated[CameraService, Depends(get_camera_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    status_: str | None = Query(None, alias="status", max_length=16),
    brand: str | None = Query(None, max_length=64),
    site_id: str | None = Query(None, max_length=36),
    group_id: str | None = Query(None, max_length=36),
    q: str | None = Query(None, max_length=255),
) -> CameraListResponse:
    return await svc.list_(
        skip=skip, limit=limit, status=status_, brand=brand,
        site_id=site_id, group_id=group_id, q=q,
    )


@router.post(
    "/cameras",
    response_model=CameraPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_camera(
    body: CameraCreate,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/cameras/{camera_id}",
    response_model=CameraPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_camera(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> CameraPublic:
    return await svc.get(camera_id)


@router.patch("/cameras/{camera_id}", response_model=CameraPublic)
async def update_camera(
    camera_id: str,
    body: CameraUpdate,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraPublic:
    return await svc.update(camera_id, body, actor=actor)


@router.delete("/cameras/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_camera(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(camera_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Bulk + reorder ─────────────────────────────────────────────────────


@router.post("/cameras/bulk", response_model=BulkResult)
async def bulk_cameras(
    body: CameraBulkBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> BulkResult:
    result = await svc.bulk(
        body.camera_ids, body.action,
        group_id=body.group_id, retention_days=body.retention_days, actor=actor,
    )
    return BulkResult(affected=result["affected"])


@router.post("/cameras/reorder", response_model=ReorderResult)
async def reorder_cameras(
    body: CameraReorderBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ReorderResult:
    result = await svc.reorder(body.items)
    return ReorderResult(reordered=result["reordered"])


# ── Discovery / onboarding (driver-backed, graceful) ───────────────────


@router.post("/cameras/onvif/discover", response_model=DiscoverResponse)
async def discover_cameras(
    body: DiscoverBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> DiscoverResponse:
    items = await svc.discover(brand=body.brand, network=body.network)
    return DiscoverResponse(items=items, total=len(items))


@router.post("/cameras/onvif/probe", response_model=ProbeResponse)
async def probe_camera(
    body: ProbeBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ProbeResponse:
    return ProbeResponse(
        **await svc.probe(
            host=body.host, port=body.port, username=body.username,
            password=body.password, brand=body.brand,
        )
    )


@router.post("/cameras/onvif/channels", response_model=ChannelsResponse)
async def enumerate_channels(
    body: ChannelsBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ChannelsResponse:
    items = await svc.enumerate_channels(
        host=body.host, port=body.port, username=body.username,
        password=body.password, brand=body.brand,
    )
    return ChannelsResponse(items=items, total=len(items))


@router.post(
    "/cameras/onvif/bulk-add",
    response_model=CameraListResponse,
    status_code=status.HTTP_201_CREATED,
)
async def bulk_add_cameras(
    body: BulkAddBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraListResponse:
    return await svc.bulk_add(
        host=body.host, port=body.port, username=body.username,
        password=body.password, brand=body.brand, channels=body.channels, actor=actor,
    )


@router.post("/cameras/onvif/snapshot")
async def snapshot_host(
    body: SnapshotBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    jpeg = await svc.snapshot(
        host=body.host, port=body.port, username=body.username,
        password=body.password, brand=body.brand,
    )
    if jpeg is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="snapshot unavailable (device unreachable)"
        )
    return Response(content=jpeg, media_type="image/jpeg")


@router.get("/cameras/{camera_id}/snapshot")
async def snapshot_camera(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_READ)),
) -> Response:
    jpeg = await svc.snapshot_for(camera_id)
    if jpeg is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="snapshot unavailable (device unreachable)"
        )
    return Response(content=jpeg, media_type="image/jpeg")


# ── Config sub-resources (driver-backed; explicit ops MAY 502) ─────────


@router.post("/cameras/{camera_id}/ptz")
async def ptz_camera(
    camera_id: str,
    body: PtzBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> dict:
    cmd = PtzCommand(
        action=body.action, pan=body.pan, tilt=body.tilt, zoom=body.zoom,
        speed=body.speed, preset_token=body.preset_token,
        preset_name=body.preset_name, profile_token=body.profile_token,
    )
    try:
        result = await svc.ptz(camera_id, cmd)
    except DriverError as exc:
        raise _driver_err(exc)
    return {"result": result}


@router.patch("/cameras/{camera_id}/imaging", response_model=ConfigResult)
async def configure_imaging(
    camera_id: str,
    body: ImagingBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_CONFIG)),
) -> ConfigResult:
    try:
        return ConfigResult(**await svc.configure(camera_id, "imaging", body.model_dump()))
    except DriverError as exc:
        raise _driver_err(exc)


@router.patch("/cameras/{camera_id}/io", response_model=ConfigResult)
async def configure_io(
    camera_id: str,
    body: IoBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_CONFIG)),
) -> ConfigResult:
    try:
        return ConfigResult(**await svc.configure(camera_id, "io", body.model_dump()))
    except DriverError as exc:
        raise _driver_err(exc)


@router.get(
    "/cameras/{camera_id}/motion-config",
    response_model=ConfigResult,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_motion_config(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> ConfigResult:
    return ConfigResult(**await svc.get_local_config(camera_id, "motion_config"))


@router.put("/cameras/{camera_id}/motion-config", response_model=ConfigResult)
async def put_motion_config(
    camera_id: str,
    body: MotionConfigBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_CONFIG)),
) -> ConfigResult:
    return ConfigResult(**await svc.put_local_config(camera_id, "motion_config", body.model_dump()))


@router.get(
    "/cameras/{camera_id}/privacy-masks",
    response_model=ConfigResult,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_privacy_masks(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> ConfigResult:
    return ConfigResult(**await svc.get_local_config(camera_id, "privacy_masks"))


@router.put("/cameras/{camera_id}/privacy-masks", response_model=ConfigResult)
async def put_privacy_masks(
    camera_id: str,
    body: PrivacyMasksBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_CONFIG)),
) -> ConfigResult:
    return ConfigResult(**await svc.put_local_config(camera_id, "privacy_masks", body.masks))


@router.get(
    "/cameras/{camera_id}/motion-zones",
    response_model=ConfigResult,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_motion_zones(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> ConfigResult:
    return ConfigResult(**await svc.get_local_config(camera_id, "motion_zones"))


@router.put("/cameras/{camera_id}/motion-zones", response_model=ConfigResult)
async def put_motion_zones(
    camera_id: str,
    body: MotionZonesBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_CONFIG)),
) -> ConfigResult:
    return ConfigResult(**await svc.put_local_config(camera_id, "motion_zones", body.zones))


@router.get(
    "/cameras/{camera_id}/onvif-events",
    response_model=ConfigResult,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_onvif_events(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> ConfigResult:
    return ConfigResult(**await svc.get_local_config(camera_id, "onvif_events"))


@router.put("/cameras/{camera_id}/onvif-events", response_model=ConfigResult)
async def put_onvif_events(
    camera_id: str,
    body: OnvifEventsBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_CONFIG)),
) -> ConfigResult:
    return ConfigResult(
        **await svc.put_local_config(camera_id, "onvif_events", body.model_dump())
    )
