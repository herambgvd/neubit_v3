"""Two-way-audio (talk) router — permission-gated, tenant-scoped (G6).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix.
Endpoint:
  * ``POST /vms/cameras/{id}/talk/session`` → issue a TalkSession (push-to-talk creds).

Gates on ``vms.live.view`` (the same perm as live viewing — a talk operator is a live
operator; the ``*`` wildcard grants it). Runs inside the caller's tenant scope. The
caller's JWT is captured for parity with the live router (media-plane forwarding), even
though the talk-session issue itself is a control-plane-only op.

A non-backchannel camera → 409 (``TalkNotSupported``); an unreachable device that IS
capability-flagged still issues a session (the on-wire push is # LIVE-VALIDATE).
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission
from kernel.auth import _bearer

from app.db import get_db

from .schemas import TalkSessionBody, TalkSessionPublic
from .service import AudioTalkService

PERM_VIEW = "vms.live.view"

router = APIRouter(prefix="/vms", tags=["VMS Audio"])


def _bearer_token(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    return cred.credentials if cred else None


async def get_talk_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    bearer: Annotated[Optional[str], Depends(_bearer_token)],
) -> AudioTalkService:
    return AudioTalkService(db, scope, bearer=bearer)


@router.post(
    "/cameras/{camera_id}/talk/session",
    response_model=TalkSessionPublic,
    status_code=status.HTTP_201_CREATED,
)
async def start_talk(
    camera_id: str,
    svc: Annotated[AudioTalkService, Depends(get_talk_service)],
    body: TalkSessionBody | None = None,
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> TalkSessionPublic:
    profile = (body.profile if body else None) or "main"
    return await svc.start_talk(camera_id, profile, actor=actor)
