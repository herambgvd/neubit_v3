"""VMS events router (P5-A) — permission-gated (``vms.camera.read``), tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix →
paths ``/api/v1/vms/events`` etc. Mirrors the recording/health routers: every
endpoint gated via ``kernel.auth.require_permission`` and run inside the caller's
tenant scope. Reads + ack are all ``vms.camera.read`` (ack is an operator read-side
acknowledgement, not a device/config write).

Endpoints:
  * ``GET  /vms/events``                    — the camera device-events feed (filters).
  * ``GET  /vms/cameras/{id}/events``       — one camera's events.
  * ``POST /vms/events/{id}/ack``           — acknowledge one event.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission

from app.db import get_db

from .schemas import VmsEventListResponse, VmsEventPublic
from .service import VmsEventService

# Same permission key the camera/health reads gate on (the tenant-admin "*" wildcard
# already grants it today).
PERM_READ = "vms.camera.read"

router = APIRouter(prefix="/vms", tags=["VMS Events"])


async def get_event_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> VmsEventService:
    return VmsEventService(db, scope)


@router.get(
    "/events",
    response_model=VmsEventListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_events(
    svc: Annotated[VmsEventService, Depends(get_event_service)],
    camera_id: str | None = Query(None, max_length=36),
    event_type: str | None = Query(None, max_length=32),
    severity: str | None = Query(None, max_length=16),
    acknowledged: bool | None = Query(None),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> VmsEventListResponse:
    """The camera device-events feed (newest first); camera/type/severity/ack/time filters."""
    return await svc.list_(
        camera_id=camera_id,
        event_type=event_type,
        severity=severity,
        acknowledged=acknowledged,
        from_=from_,
        to=to,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/cameras/{camera_id}/events",
    response_model=VmsEventListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_camera_events(
    camera_id: str,
    svc: Annotated[VmsEventService, Depends(get_event_service)],
    event_type: str | None = Query(None, max_length=32),
    severity: str | None = Query(None, max_length=16),
    acknowledged: bool | None = Query(None),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> VmsEventListResponse:
    """One camera's device-events (ownership-checked)."""
    return await svc.list_for_camera(
        camera_id,
        event_type=event_type,
        severity=severity,
        acknowledged=acknowledged,
        from_=from_,
        to=to,
        skip=skip,
        limit=limit,
    )


@router.post(
    "/events/{event_id}/ack",
    response_model=VmsEventPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def ack_event(
    event_id: str,
    svc: Annotated[VmsEventService, Depends(get_event_service)],
    principal: Annotated[Principal, Depends(get_principal)],
) -> VmsEventPublic:
    """Acknowledge one event (idempotent; stamps ``acknowledged_by`` / ``_at``)."""
    return await svc.ack(event_id, actor=principal)
