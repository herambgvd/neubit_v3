"""Video-wall router — permission-gated, tenant-scoped (VW-A).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix, so
paths are ``/api/v1/vms/walls/...`` (gateway-routed via the existing vision prefix — no
routes.yml change). Every endpoint is gated by a ``vms.wall.*`` permission and runs inside
the caller's tenant scope — mirroring the camera router.

Perm tiers:
  * ``vms.wall.manage``  — wall + monitor + preset + tour CRUD (config).
  * ``vms.wall.control`` — live state: push a camera to a cell, clear, apply/save preset,
    start/stop a tour (the operator cockpit).
  * ``vms.wall.view``    — read walls / monitors / current state / presets / tours.

Every state mutation publishes ``tenant.<id>.vms.wall.<wall_id>.state`` (in the service)
with the NEW FULL state → the core ``realtime_wall.py`` SSE bridge → all operator UIs +
display-clients. VW-B (decoder push) hooks the service's state mutations; VW-C (alarm auto-
display) calls ``push_cell`` from a linkage action; VW-D builds the three frontend surfaces.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    ClearCellBody,
    MonitorCreate,
    MonitorListResponse,
    MonitorPublic,
    MonitorUpdate,
    PresetCreate,
    PresetListResponse,
    PresetPublic,
    PresetUpdate,
    PushCellBody,
    TourCreate,
    TourListResponse,
    TourPublic,
    TourUpdate,
    WallCreate,
    WallListResponse,
    WallPublic,
    WallStateResponse,
    WallUpdate,
)
from .service import VideoWallService

# Permission keys (registered in core's catalog — group "VMS").
PERM_VIEW = "vms.wall.view"
PERM_CONTROL = "vms.wall.control"
PERM_MANAGE = "vms.wall.manage"

router = APIRouter(prefix="/vms", tags=["VMS Video Wall"])


async def get_wall_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> VideoWallService:
    return VideoWallService(db, scope)


# ── wall CRUD ──────────────────────────────────────────────────────────


@router.get(
    "/walls",
    response_model=WallListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_walls(
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    site_id: str | None = Query(None, max_length=36),
) -> WallListResponse:
    return await svc.list_walls(skip=skip, limit=limit, site_id=site_id)


@router.post("/walls", response_model=WallPublic, status_code=status.HTTP_201_CREATED)
async def create_wall(
    body: WallCreate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> WallPublic:
    return await svc.create_wall(body, actor=actor)


@router.get(
    "/walls/{wall_id}",
    response_model=WallPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_wall(
    wall_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
) -> WallPublic:
    return await svc.get_wall(wall_id)


@router.patch("/walls/{wall_id}", response_model=WallPublic)
async def update_wall(
    wall_id: str,
    body: WallUpdate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> WallPublic:
    return await svc.update_wall(wall_id, body, actor=actor)


@router.delete("/walls/{wall_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wall(
    wall_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_wall(wall_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── monitor CRUD ───────────────────────────────────────────────────────


@router.get(
    "/walls/{wall_id}/monitors",
    response_model=MonitorListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_monitors(
    wall_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
) -> MonitorListResponse:
    return await svc.list_monitors(wall_id)


@router.post(
    "/walls/{wall_id}/monitors",
    response_model=MonitorPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_monitor(
    wall_id: str,
    body: MonitorCreate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> MonitorPublic:
    return await svc.create_monitor(wall_id, body, actor=actor)


@router.patch("/walls/{wall_id}/monitors/{monitor_id}", response_model=MonitorPublic)
async def update_monitor(
    wall_id: str,
    monitor_id: str,
    body: MonitorUpdate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> MonitorPublic:
    return await svc.update_monitor(wall_id, monitor_id, body)


@router.delete(
    "/walls/{wall_id}/monitors/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_monitor(
    wall_id: str,
    monitor_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_monitor(wall_id, monitor_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── live state (control) ───────────────────────────────────────────────


@router.get(
    "/walls/{wall_id}/state",
    response_model=WallStateResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_state(
    wall_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
) -> WallStateResponse:
    return await svc.get_state(wall_id)


@router.post("/walls/{wall_id}/state/push", response_model=WallStateResponse)
async def push_cell(
    wall_id: str,
    body: PushCellBody,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> WallStateResponse:
    return await svc.push_cell(
        wall_id, body.monitor_id, body.cell_index, body.camera_id, actor=actor
    )


@router.post("/walls/{wall_id}/state/clear", response_model=WallStateResponse)
async def clear_cell(
    wall_id: str,
    body: ClearCellBody,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> WallStateResponse:
    return await svc.clear_cell(wall_id, body.monitor_id, body.cell_index, actor=actor)


@router.post("/walls/{wall_id}/presets/{preset_id}/apply", response_model=WallStateResponse)
async def apply_preset(
    wall_id: str,
    preset_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> WallStateResponse:
    return await svc.apply_preset(wall_id, preset_id, actor=actor)


# ── presets ────────────────────────────────────────────────────────────


@router.get(
    "/walls/{wall_id}/presets",
    response_model=PresetListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_presets(
    wall_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
) -> PresetListResponse:
    return await svc.list_presets(wall_id)


@router.post(
    "/walls/{wall_id}/presets",
    response_model=PresetPublic,
    status_code=status.HTTP_201_CREATED,
)
async def save_preset(
    wall_id: str,
    body: PresetCreate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> PresetPublic:
    return await svc.save_preset(wall_id, body, actor=actor)


@router.patch("/walls/{wall_id}/presets/{preset_id}", response_model=PresetPublic)
async def update_preset(
    wall_id: str,
    preset_id: str,
    body: PresetUpdate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    _actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> PresetPublic:
    return await svc.update_preset(wall_id, preset_id, body)


@router.delete(
    "/walls/{wall_id}/presets/{preset_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_preset(
    wall_id: str,
    preset_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_preset(wall_id, preset_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── tours ──────────────────────────────────────────────────────────────


@router.get(
    "/walls/{wall_id}/tours",
    response_model=TourListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_tours(
    wall_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
) -> TourListResponse:
    return await svc.list_tours(wall_id)


@router.post(
    "/walls/{wall_id}/tours",
    response_model=TourPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_tour(
    wall_id: str,
    body: TourCreate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> TourPublic:
    return await svc.create_tour(wall_id, body, actor=actor)


@router.patch("/walls/{wall_id}/tours/{tour_id}", response_model=TourPublic)
async def update_tour(
    wall_id: str,
    tour_id: str,
    body: TourUpdate,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> TourPublic:
    return await svc.update_tour(wall_id, tour_id, body)


@router.delete(
    "/walls/{wall_id}/tours/{tour_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_tour(
    wall_id: str,
    tour_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_tour(wall_id, tour_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/walls/{wall_id}/tours/{tour_id}/start", response_model=TourPublic)
async def start_tour(
    wall_id: str,
    tour_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> TourPublic:
    return await svc.set_tour_running(wall_id, tour_id, True, actor=actor)


@router.post("/walls/{wall_id}/tours/{tour_id}/stop", response_model=TourPublic)
async def stop_tour(
    wall_id: str,
    tour_id: str,
    svc: Annotated[VideoWallService, Depends(get_wall_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> TourPublic:
    return await svc.set_tour_running(wall_id, tour_id, False, actor=actor)
