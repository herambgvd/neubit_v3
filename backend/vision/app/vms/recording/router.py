"""Recording router — permission-gated, tenant-scoped (P3-A).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix:
  * ``PUT    /vms/cameras/{id}/recording``          → set mode/schedule/retention.
  * ``GET    /vms/cameras/{id}/recording``          → current config.
  * ``POST   /vms/cameras/{id}/recording/start``    → manual start (→ nvr).
  * ``POST   /vms/cameras/{id}/recording/stop``     → manual stop (→ nvr).
  * ``GET    /vms/cameras/{id}/recordings``         → browse (filter from/to/trigger).
  * ``GET    /vms/recordings/{rec_id}``             → one recording.

Writes (config / start / stop) gate on ``vms.recording.control``; reads (config
get / browse) on ``vms.playback.view`` (``*`` wildcard grants either). The caller's
JWT is forwarded to the Go ``nvr`` for the start/stop service call.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission
from kernel.auth import _bearer

from app.db import get_db

from .schemas import (
    RecordingConfigBody,
    RecordingConfigPublic,
    RecordingControlResult,
    RecordingListResponse,
    RecordingPublic,
)
from .service import RecordingService

PERM_CONTROL = "vms.recording.control"
PERM_VIEW = "vms.playback.view"

router = APIRouter(prefix="/vms", tags=["VMS Recording"])


def _bearer_token(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    return cred.credentials if cred else None


async def get_recording_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    bearer: Annotated[Optional[str], Depends(_bearer_token)],
) -> RecordingService:
    return RecordingService(db, scope, bearer=bearer)


# ── config ──────────────────────────────────────────────────────────────


@router.put("/cameras/{camera_id}/recording", response_model=RecordingConfigPublic)
async def set_recording_config(
    camera_id: str,
    body: RecordingConfigBody,
    svc: Annotated[RecordingService, Depends(get_recording_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> RecordingConfigPublic:
    return await svc.set_config(camera_id, body, actor=actor)


@router.get(
    "/cameras/{camera_id}/recording",
    response_model=RecordingConfigPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_recording_config(
    camera_id: str,
    svc: Annotated[RecordingService, Depends(get_recording_service)],
) -> RecordingConfigPublic:
    return await svc.get_config(camera_id)


# ── manual start / stop ─────────────────────────────────────────────────


@router.post(
    "/cameras/{camera_id}/recording/start", response_model=RecordingControlResult
)
async def start_recording(
    camera_id: str,
    svc: Annotated[RecordingService, Depends(get_recording_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> RecordingControlResult:
    return RecordingControlResult(**await svc.start(camera_id, actor=actor))


@router.post(
    "/cameras/{camera_id}/recording/stop", response_model=RecordingControlResult
)
async def stop_recording(
    camera_id: str,
    svc: Annotated[RecordingService, Depends(get_recording_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> RecordingControlResult:
    return RecordingControlResult(**await svc.stop(camera_id, actor=actor))


# ── browse ──────────────────────────────────────────────────────────────


@router.get(
    "/cameras/{camera_id}/recordings",
    response_model=RecordingListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_recordings(
    camera_id: str,
    svc: Annotated[RecordingService, Depends(get_recording_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None),
    trigger: str | None = Query(None, max_length=16),
) -> RecordingListResponse:
    return await svc.list_(
        camera_id, skip=skip, limit=limit, from_=from_, to=to, trigger=trigger
    )


@router.get(
    "/recordings/{rec_id}",
    response_model=RecordingPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_recording(
    rec_id: str,
    svc: Annotated[RecordingService, Depends(get_recording_service)],
) -> RecordingPublic:
    return await svc.get(rec_id)
