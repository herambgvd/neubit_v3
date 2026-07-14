"""Camera-group + per-camera ACL router — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with a ``/vms`` domain prefix,
so paths are ``/api/v1/vms/...``. Every endpoint is gated by a ``vms.*`` permission
via ``kernel.auth.require_permission`` and runs inside the caller's tenant scope
(``get_scope``) — mirroring the camera router.

Endpoints:
  * Groups: ``GET/POST /camera-groups``, ``PATCH/DELETE /camera-groups/{id}``.
  * Per-camera ACL: ``GET/PUT /cameras/{id}/acl`` (VMS-owned; keyed on core subject ids —
    served by ``CameraService`` since the ACL rows hang off the camera target).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from app.vms.cameras.router import PERM_MANAGE, PERM_READ, get_camera_service
from app.vms.cameras.service import CameraService
from .schemas import (
    CameraACLListResponse,
    CameraACLPutBody,
    CameraGroupCreate,
    CameraGroupListResponse,
    CameraGroupPublic,
    CameraGroupUpdate,
)
from .service import CameraGroupService

router = APIRouter(prefix="/vms", tags=["VMS Camera Groups"])


async def get_group_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> CameraGroupService:
    return CameraGroupService(db, scope)


# ── Camera groups (thin CRUD) ──────────────────────────────────────────


@router.get(
    "/camera-groups",
    response_model=CameraGroupListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_groups(
    svc: Annotated[CameraGroupService, Depends(get_group_service)],
) -> CameraGroupListResponse:
    items = await svc.list_()
    return CameraGroupListResponse(items=items, total=len(items))


@router.post(
    "/camera-groups",
    response_model=CameraGroupPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_group(
    body: CameraGroupCreate,
    svc: Annotated[CameraGroupService, Depends(get_group_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraGroupPublic:
    return await svc.create(body, actor=actor)


@router.patch("/camera-groups/{group_id}", response_model=CameraGroupPublic)
async def update_group(
    group_id: str,
    body: CameraGroupUpdate,
    svc: Annotated[CameraGroupService, Depends(get_group_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraGroupPublic:
    return await svc.update(group_id, body, actor=actor)


@router.delete("/camera-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: str,
    svc: Annotated[CameraGroupService, Depends(get_group_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(group_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Per-camera ACL (VMS-owned; keyed on core subject ids) ──────────────


@router.get(
    "/cameras/{camera_id}/acl",
    response_model=CameraACLListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_camera_acl(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> CameraACLListResponse:
    items = await svc.get_acl(camera_id)
    return CameraACLListResponse(items=items, total=len(items))


@router.put("/cameras/{camera_id}/acl", response_model=CameraACLListResponse)
async def put_camera_acl(
    camera_id: str,
    body: CameraACLPutBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraACLListResponse:
    items = await svc.put_acl(camera_id, body.entries, actor=actor)
    return CameraACLListResponse(items=items, total=len(items))
