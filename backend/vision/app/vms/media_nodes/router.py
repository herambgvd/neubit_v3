"""Media-node registry router — permission-gated, tenant-scoped (MN-1a).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix, so
paths are ``/api/v1/vms/media-nodes...``. Mirrors the NVR router: every endpoint is gated
via ``kernel.auth.require_permission`` and runs inside the caller's tenant scope
(``get_scope``). Node onboarding is infrastructure/config, so it gates on the existing
``vms.config.manage`` permission (no new perm needed — the tenant-admin ``*`` wildcard
grants it today).

Endpoints:
  * ``GET    /media-nodes``        — list (tenant-scoped).
  * ``POST   /media-nodes``        — register (probes reachability; never hard-fails).
  * ``GET    /media-nodes/{id}``   — detail.
  * ``PATCH  /media-nodes/{id}``   — edit (name/api_url/bases/label/capacity/status).
  * ``DELETE /media-nodes/{id}``   — remove (blocked while cameras are still assigned).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    MediaNodeCreate,
    MediaNodeListResponse,
    MediaNodePublic,
    MediaNodeUpdate,
)
from .service import MediaNodeService

# Node onboarding is an infrastructure/config write — gate on the existing config-manage
# permission (added to core's catalog already; the tenant-admin "*" wildcard grants it).
PERM_MANAGE = "vms.config.manage"

router = APIRouter(prefix="/vms", tags=["VMS Media Nodes"])


async def get_media_node_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> MediaNodeService:
    return MediaNodeService(db, scope)


@router.get(
    "/media-nodes",
    response_model=MediaNodeListResponse,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def list_media_nodes(
    svc: Annotated[MediaNodeService, Depends(get_media_node_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    status_: str | None = Query(None, alias="status", max_length=16),
    q: str | None = Query(None, max_length=255),
) -> MediaNodeListResponse:
    return await svc.list_(skip=skip, limit=limit, status=status_, q=q)


@router.post(
    "/media-nodes",
    response_model=MediaNodePublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def register_media_node(
    body: MediaNodeCreate,
    svc: Annotated[MediaNodeService, Depends(get_media_node_service)],
) -> MediaNodePublic:
    return await svc.create(body)


@router.get(
    "/media-nodes/{node_id}",
    response_model=MediaNodePublic,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def get_media_node(
    node_id: str,
    svc: Annotated[MediaNodeService, Depends(get_media_node_service)],
) -> MediaNodePublic:
    return await svc.get(node_id)


@router.patch(
    "/media-nodes/{node_id}",
    response_model=MediaNodePublic,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def update_media_node(
    node_id: str,
    body: MediaNodeUpdate,
    svc: Annotated[MediaNodeService, Depends(get_media_node_service)],
) -> MediaNodePublic:
    return await svc.update(node_id, body)


@router.delete(
    "/media-nodes/{node_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def delete_media_node(
    node_id: str,
    svc: Annotated[MediaNodeService, Depends(get_media_node_service)],
) -> Response:
    await svc.delete(node_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
