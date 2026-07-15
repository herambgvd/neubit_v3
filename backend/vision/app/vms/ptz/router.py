"""PTZ operator-control router (G1) — perm-gated, tenant-scoped.

Mounted under ``/vms`` (paths ``/api/v1/vms/cameras/{id}/ptz/...``). Move / zoom / focus /
preset-CRUD / patrol endpoints. Every write is gated by ``vms.ptz.control``; reads (list
presets/patrols) accept the lighter ``vms.live.view`` (an operator viewing a camera can see
its presets/patrols without full PTZ-control rights).

Paths are deeper than the camera ``/cameras/{camera_id}`` catch-all and distinct from the
camera router's ``POST /cameras/{camera_id}/ptz`` (the low-level single-command endpoint —
kept for compatibility). Driver failures on explicit operator actions surface as a clean 502.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from app.vms.drivers import DriverError
from app.vms.groups.acl import enforce_camera_privilege

from .schemas import (
    PatrolCreate,
    PatrolListResponse,
    PatrolPublic,
    PatrolUpdate,
    PresetCreate,
    PresetListResponse,
    PresetPublic,
    PtzFocusBody,
    PtzMoveBody,
    PtzResult,
    PtzZoomBody,
)
from .service import PtzService

PERM_PTZ = "vms.ptz.control"
PERM_VIEW = "vms.live.view"

router = APIRouter(prefix="/vms", tags=["VMS PTZ"])


async def get_ptz_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> PtzService:
    return PtzService(db, scope)


def _driver_err(exc: DriverError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


# ── Move / zoom / focus / stop ─────────────────────────────────────────
@router.post("/cameras/{camera_id}/ptz/move", response_model=PtzResult)
async def ptz_move(
    camera_id: str,
    body: PtzMoveBody,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PtzResult:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="ptz"
    )
    try:
        result = await svc.move(
            camera_id, mode=body.mode, pan=body.pan, tilt=body.tilt, zoom=body.zoom, speed=body.speed
        )
    except DriverError as exc:
        raise _driver_err(exc)
    return PtzResult(ok=True, result=result)


@router.post("/cameras/{camera_id}/ptz/stop", response_model=PtzResult)
async def ptz_stop(
    camera_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PtzResult:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="ptz"
    )
    try:
        result = await svc.stop(camera_id)
    except DriverError as exc:
        raise _driver_err(exc)
    return PtzResult(ok=True, result=result)


@router.post("/cameras/{camera_id}/ptz/zoom", response_model=PtzResult)
async def ptz_zoom(
    camera_id: str,
    body: PtzZoomBody,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PtzResult:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="ptz"
    )
    try:
        result = await svc.zoom(camera_id, direction=body.direction, speed=body.speed)
    except DriverError as exc:
        raise _driver_err(exc)
    return PtzResult(ok=True, result=result)


@router.post("/cameras/{camera_id}/ptz/focus", response_model=PtzResult)
async def ptz_focus(
    camera_id: str,
    body: PtzFocusBody,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PtzResult:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="ptz"
    )
    try:
        result = await svc.focus(camera_id, direction=body.direction, speed=body.speed)
    except DriverError as exc:
        raise _driver_err(exc)
    return PtzResult(ok=True, result=result)


# ── Presets ─────────────────────────────────────────────────────────────
@router.get(
    "/cameras/{camera_id}/ptz/presets",
    response_model=PresetListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_presets(
    camera_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
) -> PresetListResponse:
    items = await svc.list_presets(camera_id)
    return PresetListResponse(items=items, total=len(items))


@router.post(
    "/cameras/{camera_id}/ptz/presets",
    response_model=PresetPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_preset(
    camera_id: str,
    body: PresetCreate,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PresetPublic:
    try:
        return await svc.create_preset(camera_id, body, actor=actor)
    except DriverError as exc:
        raise _driver_err(exc)


@router.post("/cameras/{camera_id}/ptz/presets/{preset_id}/goto", response_model=PtzResult)
async def goto_preset(
    camera_id: str,
    preset_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PtzResult:
    try:
        result = await svc.goto_preset(camera_id, preset_id)
    except DriverError as exc:
        raise _driver_err(exc)
    return PtzResult(ok=True, result=result)


@router.delete(
    "/cameras/{camera_id}/ptz/presets/{preset_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_preset(
    camera_id: str,
    preset_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> Response:
    await svc.delete_preset(camera_id, preset_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Patrols ──────────────────────────────────────────────────────────────
@router.get(
    "/cameras/{camera_id}/ptz/patrols",
    response_model=PatrolListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_patrols(
    camera_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
) -> PatrolListResponse:
    items = await svc.list_patrols(camera_id)
    return PatrolListResponse(items=items, total=len(items))


@router.post(
    "/cameras/{camera_id}/ptz/patrols",
    response_model=PatrolPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_patrol(
    camera_id: str,
    body: PatrolCreate,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PatrolPublic:
    return await svc.create_patrol(camera_id, body, actor=actor)


@router.patch("/cameras/{camera_id}/ptz/patrols/{patrol_id}", response_model=PatrolPublic)
async def update_patrol(
    camera_id: str,
    patrol_id: str,
    body: PatrolUpdate,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PatrolPublic:
    return await svc.update_patrol(camera_id, patrol_id, body)


@router.delete(
    "/cameras/{camera_id}/ptz/patrols/{patrol_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_patrol(
    camera_id: str,
    patrol_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> Response:
    await svc.delete_patrol(camera_id, patrol_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/cameras/{camera_id}/ptz/patrols/{patrol_id}/start", response_model=PatrolPublic)
async def start_patrol(
    camera_id: str,
    patrol_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PatrolPublic:
    return await svc.start_patrol(camera_id, patrol_id)


@router.post("/cameras/{camera_id}/ptz/patrols/{patrol_id}/stop", response_model=PatrolPublic)
async def stop_patrol(
    camera_id: str,
    patrol_id: str,
    svc: Annotated[PtzService, Depends(get_ptz_service)],
    _actor: Principal = Depends(require_permission(PERM_PTZ)),
) -> PatrolPublic:
    return await svc.stop_patrol(camera_id, patrol_id)
