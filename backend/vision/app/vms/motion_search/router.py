"""Forensic motion-search router — permission-gated, tenant-scoped (G4).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix:
  * ``POST /vms/cameras/{id}/motion-search {from, to, regions[], sensitivity?, sample_fps?}``
        → queue a motion-search job → ``{job_id, status:"queued"}``.
  * ``GET  /vms/motion-search/{job_id}`` → the job status/result (hits when done).

Both gate on ``vms.playback.view`` (``*`` wildcard grants it) and run in the caller's
tenant scope. The ``MotionSearchWorker`` (not this router) does the ffmpeg VMD analysis.

Graceful: a window with no recordings → 404 (clean empty). Region rects are NORMALIZED
0..1 of the frame (resolution-independent).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import MotionSearchJobPublic, MotionSearchStartBody
from .service import MotionSearchService

PERM_VIEW = "vms.playback.view"

router = APIRouter(prefix="/vms", tags=["VMS Motion Search"])


async def get_motion_search_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> MotionSearchService:
    return MotionSearchService(db, scope)


@router.post(
    "/cameras/{camera_id}/motion-search",
    response_model=MotionSearchJobPublic,
    status_code=status.HTTP_201_CREATED,
)
async def start_motion_search(
    camera_id: str,
    body: MotionSearchStartBody,
    svc: Annotated[MotionSearchService, Depends(get_motion_search_service)],
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> MotionSearchJobPublic:
    row = await svc.create(
        camera_id,
        body.from_,
        body.to,
        [r.model_dump() for r in body.regions],
        sensitivity=body.sensitivity,
        sample_fps=body.sample_fps,
        actor=actor,
    )
    return MotionSearchJobPublic.from_row(row)


@router.get(
    "/motion-search/{job_id}",
    response_model=MotionSearchJobPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_motion_search(
    job_id: str,
    svc: Annotated[MotionSearchService, Depends(get_motion_search_service)],
) -> MotionSearchJobPublic:
    return MotionSearchJobPublic.from_row(await svc.get(job_id))
