"""Camera-health router — permission-gated (``vms.camera.read``), tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix,
so paths are ``/api/v1/vms/cameras/health...``. Mirrors the camera/nvr routers:
every endpoint is gated via ``kernel.auth.require_permission`` and runs inside the
caller's tenant scope (``get_scope``). Reads are all ``vms.camera.read``; the
on-demand refresh is a read-side re-check (also ``vms.camera.read`` — it triggers a
probe but no operator-facing config write).

Endpoints:
  * ``GET  /cameras/health``                    — latest snapshot per camera.
  * ``GET  /cameras/{id}/health/history``       — paginated time-series for one camera.
  * ``POST /cameras/{id}/health/refresh``       — on-demand re-check one camera.

NVR health lives in the ``nvr`` domain (``GET /nvrs/{id}/health``) and is left there;
the background sampler still keeps NVR reachability fresh estate-wide.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    CameraHealthHistoryResponse,
    CameraHealthListResponse,
    CameraHealthPublic,
)
from .service import HealthService

# Same permission key the camera reads gate on (added to core's catalog in P1-G; the
# tenant-admin "*" wildcard already grants it today).
PERM_READ = "vms.camera.read"

router = APIRouter(prefix="/vms", tags=["VMS Health"])


async def get_health_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> HealthService:
    return HealthService(db, scope)


@router.get(
    "/cameras/health",
    response_model=CameraHealthListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def latest_health(
    svc: Annotated[HealthService, Depends(get_health_service)],
    camera_id: str | None = Query(None, max_length=36),
) -> CameraHealthListResponse:
    """Latest health snapshot per camera (health-dashboard / Cameras-table column).

    Optional ``camera_id`` narrows to a single camera's latest sample.
    """
    return await svc.latest(camera_id=camera_id)


@router.get(
    "/cameras/{camera_id}/health/history",
    response_model=CameraHealthHistoryResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def health_history(
    camera_id: str,
    svc: Annotated[HealthService, Depends(get_health_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None),
) -> CameraHealthHistoryResponse:
    """Paginated health time-series for one camera (newest first; from/to filter)."""
    return await svc.history(camera_id, skip=skip, limit=limit, from_=from_, to=to)


@router.post(
    "/cameras/{camera_id}/health/refresh",
    response_model=CameraHealthPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def refresh_health(
    camera_id: str,
    svc: Annotated[HealthService, Depends(get_health_service)],
) -> CameraHealthPublic:
    """On-demand re-check one camera → write + return a fresh health sample."""
    return await svc.refresh(camera_id)
