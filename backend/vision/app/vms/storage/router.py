"""Recording integrity + evidence-lock router — permission-gated, tenant-scoped.

The storage control-plane (StoragePool/TierRule/RAID under ``/vms/storage/*``) is
owned by the NVR and has been retired from this VMS. Only the recording
integrity/lock surface remains here:

  * ``POST /vms/recordings/{id}/lock`` / ``unlock`` / ``verify``.

Writes gate on ``vms.config.manage``; reads on ``vms.playback.view`` (a recording
integrity read is part of the playback/browse surface). ``*`` wildcard grants either.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import RecordingIntegrityResult, RecordingLockBody
from .service import StorageService

PERM_MANAGE = "vms.config.manage"
PERM_VIEW = "vms.playback.view"

# Recording integrity/lock lives on the recordings path family — its paths stay
# ``/vms/recordings/{id}/...`` (not under ``/vms/storage``).
rec_router = APIRouter(prefix="/vms", tags=["VMS Storage"])


async def get_storage_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> StorageService:
    return StorageService(db, scope)


# ── recording integrity + evidence lock ─────────────────────────────────


@rec_router.post("/recordings/{rec_id}/lock", response_model=RecordingIntegrityResult)
async def lock_recording(
    rec_id: str,
    body: RecordingLockBody,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> RecordingIntegrityResult:
    return await svc.set_lock(rec_id, locked=True, actor=actor, reason=body.reason)


@rec_router.post("/recordings/{rec_id}/unlock", response_model=RecordingIntegrityResult)
async def unlock_recording(
    rec_id: str,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> RecordingIntegrityResult:
    return await svc.set_lock(rec_id, locked=False, actor=actor)


@rec_router.post(
    "/recordings/{rec_id}/verify",
    response_model=RecordingIntegrityResult,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def verify_recording(
    rec_id: str,
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> RecordingIntegrityResult:
    return await svc.verify(rec_id)
