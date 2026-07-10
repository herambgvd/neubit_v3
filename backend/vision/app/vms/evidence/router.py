"""Evidence-lock / legal-hold router (G3) — perm-gated, tenant-scoped.

Mounted under ``/vms`` (paths ``/api/v1/vms/evidence...``). A legal hold protects a
camera's recordings over a time-range from the retention sweep's auto-deletion.

Writes (create / release / delete) gate on ``vms.recording.control`` — the recording-
control permission (the same class of right as the P3-B per-recording lock/unlock;
reused rather than adding a new perm to core, which is off-limits from vision). Reads
(list / get / check-badge) gate on ``vms.playback.view`` — a lock read is part of the
playback/investigation browse surface. The ``*`` wildcard grants either.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    EvidenceCheckResult,
    EvidenceLockCreate,
    EvidenceLockListResponse,
    EvidenceLockPublic,
)
from .service import EvidenceService

# Reuse existing vms.* perms (core is off-limits from vision): the recording-control
# permission gates lock writes; the playback-view permission gates reads.
PERM_CONTROL = "vms.recording.control"
PERM_VIEW = "vms.playback.view"

router = APIRouter(prefix="/vms", tags=["VMS Evidence"])


async def get_evidence_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> EvidenceService:
    return EvidenceService(db, scope)


@router.get(
    "/evidence",
    response_model=EvidenceLockListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_evidence(
    svc: Annotated[EvidenceService, Depends(get_evidence_service)],
    camera_id: str | None = Query(None, max_length=36),
    active_only: bool = Query(False),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
) -> EvidenceLockListResponse:
    items, total = await svc.list_(
        camera_id=camera_id, active_only=active_only, skip=skip, limit=limit
    )
    return EvidenceLockListResponse(items=items, total=total)


# ── check-badge (does an active hold cover a camera at a point / range?) ─────
# Registered BEFORE ``/evidence/{lock_id}`` so the literal ``/evidence/check`` path
# is matched before the path-param catch-all (FastAPI matches in registration order).
@router.get(
    "/evidence/check",
    response_model=EvidenceCheckResult,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def check_evidence(
    svc: Annotated[EvidenceService, Depends(get_evidence_service)],
    camera_id: str = Query(..., max_length=36),
    ts: datetime | None = Query(None),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None, alias="to"),
) -> EvidenceCheckResult:
    if ts is None and (from_ is None or to is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="provide either 'ts' or both 'from' and 'to'",
        )
    locked = await svc.check(camera_id, at=ts, start=from_, end=to)
    return EvidenceCheckResult(camera_id=camera_id, locked=locked)


@router.post(
    "/evidence",
    response_model=EvidenceLockPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_evidence(
    body: EvidenceLockCreate,
    svc: Annotated[EvidenceService, Depends(get_evidence_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> EvidenceLockPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/evidence/{lock_id}",
    response_model=EvidenceLockPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_evidence(
    lock_id: str,
    svc: Annotated[EvidenceService, Depends(get_evidence_service)],
) -> EvidenceLockPublic:
    return await svc.get(lock_id)


@router.post("/evidence/{lock_id}/release", response_model=EvidenceLockPublic)
async def release_evidence(
    lock_id: str,
    svc: Annotated[EvidenceService, Depends(get_evidence_service)],
    actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> EvidenceLockPublic:
    return await svc.release(lock_id, actor=actor)


@router.delete("/evidence/{lock_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_evidence(
    lock_id: str,
    svc: Annotated[EvidenceService, Depends(get_evidence_service)],
    _actor: Principal = Depends(require_permission(PERM_CONTROL)),
) -> Response:
    await svc.delete(lock_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
