"""VMS NVR-onboarding router — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix,
so paths are ``/api/v1/vms/nvrs...``. Every endpoint is gated by a ``vms.*`` permission
via ``kernel.auth.require_permission`` and runs inside the caller's tenant scope
(``get_scope``) — mirroring the camera router. Reads gate on ``vms.nvr.manage`` (writes
too); ``*`` wildcard grants everything today (the keys land in core's catalog in P1-G).

Discovery / channel-enum / probe degrade gracefully against unreachable hosts — they
NEVER 500 (empty result on failure). Only nothing here is an "explicit device write"
that must surface a 502; NVR onboarding is read/detect + local persistence.

Endpoints:
  * CRUD: ``GET/POST /nvrs``, ``GET/PATCH/DELETE /nvrs/{id}``.
  * Discovery: ``POST /nvrs/discover``.
  * Channels: ``GET /nvrs/{id}/channels`` (saved), ``POST /nvrs/channels`` (unsaved host).
  * Map: ``POST /nvrs/{id}/map-channels`` (channels → channel-cameras, idempotent).
  * Health: ``GET /nvrs/{id}/health``, ``POST /nvrs/{id}/refresh``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .nvr_service import NvrService
from .schemas import (
    ChannelsResponse,
    MapChannelsBody,
    MapChannelsResult,
    NvrChannelsBody,
    NvrCreate,
    NvrDiscoverBody,
    NvrHealthResponse,
    NvrListResponse,
    NvrPublic,
    NvrUpdate,
    DiscoverResponse,
)

# NVR reads + writes gate on vms.nvr.manage (camera.read also acceptable per plan; the
# tenant-admin "*" wildcard grants both today). Kept simple: manage covers everything.
PERM_MANAGE = "vms.nvr.manage"

router = APIRouter(prefix="/vms", tags=["VMS NVR"])


async def _nvr_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> NvrService:
    return NvrService(db, scope)


# ── NVR CRUD ───────────────────────────────────────────────────────────


@router.get(
    "/nvrs",
    response_model=NvrListResponse,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def list_nvrs(
    svc: Annotated[NvrService, Depends(_nvr_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    status_: str | None = Query(None, alias="status", max_length=16),
    brand: str | None = Query(None, max_length=64),
    q: str | None = Query(None, max_length=255),
) -> NvrListResponse:
    return await svc.list_(skip=skip, limit=limit, status=status_, brand=brand, q=q)


@router.post(
    "/nvrs",
    response_model=NvrPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_nvr(
    body: NvrCreate,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> NvrPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/nvrs/{nvr_id}",
    response_model=NvrPublic,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def get_nvr(
    nvr_id: str,
    svc: Annotated[NvrService, Depends(_nvr_service)],
) -> NvrPublic:
    return await svc.get(nvr_id)


@router.patch("/nvrs/{nvr_id}", response_model=NvrPublic)
async def update_nvr(
    nvr_id: str,
    body: NvrUpdate,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> NvrPublic:
    return await svc.update(nvr_id, body, actor=actor)


@router.delete("/nvrs/{nvr_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_nvr(
    nvr_id: str,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(nvr_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Discovery (NVR-filtered, graceful) ─────────────────────────────────


@router.post("/nvrs/discover", response_model=DiscoverResponse)
async def discover_nvrs(
    body: NvrDiscoverBody,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> DiscoverResponse:
    items = await svc.discover(brand=body.brand, network=body.network)
    return DiscoverResponse(items=items, total=len(items))


# ── Channel enumeration (saved NVR + unsaved host) ─────────────────────


@router.get(
    "/nvrs/{nvr_id}/channels",
    response_model=ChannelsResponse,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def enumerate_nvr_channels(
    nvr_id: str,
    svc: Annotated[NvrService, Depends(_nvr_service)],
) -> ChannelsResponse:
    items = await svc.enumerate_channels(nvr_id)
    return ChannelsResponse(items=items, total=len(items))


@router.post("/nvrs/channels", response_model=ChannelsResponse)
async def enumerate_host_channels(
    body: NvrChannelsBody,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ChannelsResponse:
    items = await svc.enumerate_channels_host(
        host=body.host, port=body.port, username=body.username,
        password=body.password, brand=body.brand,
    )
    return ChannelsResponse(items=items, total=len(items))


# ── Map channels → cameras (idempotent) ────────────────────────────────


@router.post(
    "/nvrs/{nvr_id}/map-channels",
    response_model=MapChannelsResult,
    status_code=status.HTTP_201_CREATED,
)
async def map_nvr_channels(
    nvr_id: str,
    body: MapChannelsBody,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> MapChannelsResult:
    return await svc.map_channels(nvr_id, body.channels, actor=actor)


# ── Health + refresh ───────────────────────────────────────────────────


@router.get(
    "/nvrs/{nvr_id}/health",
    response_model=NvrHealthResponse,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def nvr_health(
    nvr_id: str,
    svc: Annotated[NvrService, Depends(_nvr_service)],
) -> NvrHealthResponse:
    return await svc.health(nvr_id)


@router.post("/nvrs/{nvr_id}/refresh", response_model=NvrPublic)
async def refresh_nvr(
    nvr_id: str,
    svc: Annotated[NvrService, Depends(_nvr_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> NvrPublic:
    return await svc.refresh(nvr_id, actor=actor)


# Router list appended to the vms routers export (mounted by app.main).
nvr_routers = [router]
