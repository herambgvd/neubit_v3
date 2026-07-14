"""Storage router — permission-gated, tenant-scoped (P3-B).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix:
  * StoragePool CRUD  ``/vms/storage/pools`` (+ ``/{id}``, ``/{id}/usage``).
  * TierRule   CRUD  ``/vms/storage/tier-rules`` (+ ``/{id}``).
  * Recording integrity + evidence lock:
      ``POST /vms/recordings/{id}/lock`` / ``unlock`` / ``verify``.

All writes gate on ``vms.config.manage`` (the storage/config admin permission);
reads on ``vms.playback.view`` (a storage read is part of the playback/browse
surface — the same permission the recording browse uses). ``*`` wildcard grants
either.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    RaidDeviceOut,
    RaidStatusResponse,
    RecordingIntegrityResult,
    RecordingLockBody,
    StoragePoolCreate,
    StoragePoolListResponse,
    StoragePoolPublic,
    StoragePoolUpdate,
    StoragePoolUsage,
    TierRuleCreate,
    TierRuleListResponse,
    TierRulePublic,
    TierRuleUpdate,
)
from .service import StorageService

PERM_MANAGE = "vms.config.manage"
PERM_VIEW = "vms.playback.view"

router = APIRouter(prefix="/vms/storage", tags=["VMS Storage"])
# Recording integrity/lock lives on the recordings path family — its own router so
# the paths stay ``/vms/recordings/{id}/...`` (not under ``/vms/storage``).
rec_router = APIRouter(prefix="/vms", tags=["VMS Storage"])


async def get_storage_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> StorageService:
    return StorageService(db, scope)


# ── StoragePool CRUD ────────────────────────────────────────────────────


@router.get(
    "/pools",
    response_model=StoragePoolListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_pools(
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> StoragePoolListResponse:
    items = await svc.list_pools()
    return StoragePoolListResponse(items=items, total=len(items))


@router.post("/pools", response_model=StoragePoolPublic, status_code=status.HTTP_201_CREATED)
async def create_pool(
    body: StoragePoolCreate,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> StoragePoolPublic:
    return await svc.create_pool(body, actor=actor)


@router.get(
    "/pools/{pool_id}",
    response_model=StoragePoolPublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_pool(
    pool_id: str,
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> StoragePoolPublic:
    return await svc.get_pool(pool_id)


@router.get(
    "/pools/{pool_id}/usage",
    response_model=StoragePoolUsage,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def pool_usage(
    pool_id: str,
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> StoragePoolUsage:
    return await svc.pool_usage(pool_id)


# ── RAID health (software-RAID monitoring) ──────────────────────────────
@router.get(
    "/raid/status",
    response_model=RaidStatusResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def raid_status(
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> RaidStatusResponse:
    return await svc.raid_status()


@router.get(
    "/raid/devices",
    response_model=list[RaidDeviceOut],
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def raid_devices(
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> list[RaidDeviceOut]:
    return await svc.raid_devices()


@router.patch("/pools/{pool_id}", response_model=StoragePoolPublic)
async def update_pool(
    pool_id: str,
    body: StoragePoolUpdate,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> StoragePoolPublic:
    return await svc.update_pool(pool_id, body, actor=actor)


@router.delete("/pools/{pool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pool(
    pool_id: str,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_pool(pool_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── TierRule CRUD ───────────────────────────────────────────────────────


@router.get(
    "/tier-rules",
    response_model=TierRuleListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_rules(
    svc: Annotated[StorageService, Depends(get_storage_service)],
) -> TierRuleListResponse:
    items = await svc.list_rules()
    return TierRuleListResponse(items=items, total=len(items))


@router.post("/tier-rules", response_model=TierRulePublic, status_code=status.HTTP_201_CREATED)
async def create_rule(
    body: TierRuleCreate,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> TierRulePublic:
    return await svc.create_rule(body, actor=actor)


@router.patch("/tier-rules/{rule_id}", response_model=TierRulePublic)
async def update_rule(
    rule_id: str,
    body: TierRuleUpdate,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> TierRulePublic:
    return await svc.update_rule(rule_id, body, actor=actor)


@router.delete("/tier-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: str,
    svc: Annotated[StorageService, Depends(get_storage_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_rule(rule_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
