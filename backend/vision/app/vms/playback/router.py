"""Recorded-playback router — permission-gated, tenant-scoped (P4-A).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix:
  * ``POST /vms/cameras/{id}/playback {from, to, profile?}`` → issue a recorded session.
  * ``GET  /vms/cameras/{id}/timeline?day=|from=&to=``       → scrub-bar coverage + gaps.

Both gate on ``vms.playback.view`` (``*`` wildcard grants it) and run in the caller's
tenant scope. The caller's JWT is forwarded to the Go ``nvr`` for the playback-URL
resolve (shared-JWT service-to-service).

Graceful: a window with no recordings → 404 (clean empty); a down nvr / MediaMTX
playback server → 502.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission
from kernel.auth import _bearer
from kernel.errors import ValidationError

from app.db import get_db

from .schemas import PlaybackStartBody, RecordedPlaybackPublic, TimelineResponse
from .service import PlaybackService, day_window

PERM_VIEW = "vms.playback.view"

router = APIRouter(prefix="/vms", tags=["VMS Playback"])


def _bearer_token(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    return cred.credentials if cred else None


async def get_playback_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    bearer: Annotated[Optional[str], Depends(_bearer_token)],
) -> PlaybackService:
    return PlaybackService(db, scope, bearer=bearer)


@router.post(
    "/cameras/{camera_id}/playback",
    response_model=RecordedPlaybackPublic,
    status_code=status.HTTP_201_CREATED,
)
async def start_playback(
    camera_id: str,
    body: PlaybackStartBody,
    svc: Annotated[PlaybackService, Depends(get_playback_service)],
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> RecordedPlaybackPublic:
    return await svc.start_playback(
        camera_id, body.from_, body.to, body.profile, actor=actor
    )


@router.get(
    "/cameras/{camera_id}/timeline",
    response_model=TimelineResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_timeline(
    camera_id: str,
    svc: Annotated[PlaybackService, Depends(get_playback_service)],
    day: Optional[str] = Query(None, description="YYYY-MM-DD (whole-day window, UTC)"),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None),
    profile: str | None = Query(None, max_length=16),
) -> TimelineResponse:
    """Coverage + gaps for a whole ``day`` OR an explicit ``from``/``to`` window."""
    if day:
        try:
            d = datetime.strptime(day, "%Y-%m-%d")
        except ValueError as exc:
            raise ValidationError("invalid 'day' — expected YYYY-MM-DD") from exc
        window_from, window_to = day_window(d)
    elif from_ is not None and to is not None:
        window_from, window_to = from_, to
    else:
        raise ValidationError("provide either 'day' or both 'from' and 'to'")
    return await svc.timeline(camera_id, window_from, window_to, profile)
