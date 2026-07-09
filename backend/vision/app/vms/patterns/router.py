"""Video-wall Pattern router — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with a ``/vms`` domain prefix,
so paths are ``/api/v1/vms/patterns...``. Reads gate on ``vms.live.view`` (the
video-wall viewer permission); writes gate on ``vms.config.manage`` (the config
admin permission). Every endpoint runs inside the caller's tenant scope.

Endpoints:
  * ``GET  /patterns``          — list (optional ``?is_active=`` filter).
  * ``POST /patterns``          — create.
  * ``GET  /patterns/{id}``     — fetch one.
  * ``PATCH /patterns/{id}``    — partial update.
  * ``DELETE /patterns/{id}``   — delete.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    PatternCreate,
    PatternListResponse,
    PatternPublic,
    PatternUpdate,
)
from .service import PatternService

PERM_VIEW = "vms.live.view"
PERM_MANAGE = "vms.config.manage"

router = APIRouter(prefix="/vms", tags=["VMS Patterns"])


async def get_pattern_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> PatternService:
    return PatternService(db, scope)


@router.get(
    "/patterns",
    response_model=PatternListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_patterns(
    svc: Annotated[PatternService, Depends(get_pattern_service)],
    is_active: Optional[bool] = None,
) -> PatternListResponse:
    items = await svc.list_(is_active=is_active)
    return PatternListResponse(items=items, total=len(items))


@router.post(
    "/patterns",
    response_model=PatternPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_pattern(
    body: PatternCreate,
    svc: Annotated[PatternService, Depends(get_pattern_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> PatternPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/patterns/{pattern_id}",
    response_model=PatternPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_pattern(
    pattern_id: str,
    svc: Annotated[PatternService, Depends(get_pattern_service)],
) -> PatternPublic:
    return await svc.get(pattern_id)


@router.patch("/patterns/{pattern_id}", response_model=PatternPublic)
async def update_pattern(
    pattern_id: str,
    body: PatternUpdate,
    svc: Annotated[PatternService, Depends(get_pattern_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> PatternPublic:
    return await svc.update(pattern_id, body, actor=actor)


@router.delete("/patterns/{pattern_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pattern(
    pattern_id: str,
    svc: Annotated[PatternService, Depends(get_pattern_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(pattern_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
