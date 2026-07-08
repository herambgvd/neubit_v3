"""Access-control routers — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with an ``/access`` domain
prefix, so paths are ``/api/v1/access/...``. Every endpoint is gated by an
``access.*`` permission via ``kernel.auth.require_permission`` and runs inside the
caller's tenant scope (``get_scope``).

FOUNDATION (Phase 1):
  * Instance CRUD (list/get/create/update/delete).
  * POST /instances/{id}/test-connection — connector ping (graceful on failure).
  * POST /instances/{id}/reconcile — full-sync → mirror + SyncJob (graceful).
  * GET  /instances/{id}/sync-jobs — reconcile history.
  * GET  /instances/{id}/{cardholders|cards} — DDS mirror reads.

PHASE 2 (this file, ported from v2 gates):
  * Write-through CRUD for cardholders/cards + assignment/status ops (v2 cardholder/
    card routes).
  * LOCAL access-group + schedule catalogs at top-level /access-groups + /schedules
    (v2 access_groups module — repository CRUD, NOT DDS write-through; see
    catalog.py). Both REQUIRE an ``instance_id`` query param.
  * Doors CRUD (local, tenant-scoped) + door commands (v2 door/routes).
  * Commands: outputs/alarm-zones/controllers/sites OData actions (v2 commands).
  * Hardware proxy (v2 hardware/routes). Events read API (v2 event/routes).

DDS is unreachable in dev → write/command/hardware endpoints return a CLEAN error
(never a 500 crash-loop); reads + doors CRUD are fully local and testable.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .catalog import AccessGroupCatalog, ScheduleCatalog
from .commands import CommandError, CommandService, HARDWARE_SETS
from .doors import DoorCommandError, DoorService
from .schemas import (
    AccessEventListResponse,
    AccessGroupCreate,
    AccessGroupListResponse,
    AccessGroupPublic,
    AccessGroupUpdate,
    ArmBody,
    AssignCardBody,
    AssignGroupBody,
    CardCreate,
    CardStatusBody,
    CardUpdate,
    CardholderCreate,
    CardholderUpdate,
    DisarmBody,
    DoorCreate,
    DoorListResponse,
    DoorPublic,
    DoorUpdate,
    InstanceCreate,
    InstanceListResponse,
    InstancePublic,
    InstanceUpdate,
    MirrorListResponse,
    OutputTargets,
    ScheduleCreate,
    ScheduleListResponse,
    SchedulePublic,
    ScheduleUpdate,
    SyncJobListResponse,
    SyncJobPublic,
    TestConnectionResponse,
)
from .service import InstanceService
from .writethrough import DDSError, WriteThroughService

# Permission keys this service gates on. Kernel grants if the JWT carries the key
# (or "*"/super-admin) — no local permission registry needed on a satellite.
PERM_READ = "access.read"
PERM_MANAGE = "access.manage"

router = APIRouter(prefix="/access", tags=["Access Control"])

# Map the public mirror-listing path segment → the mirror collection name.
# NOTE: access-groups + schedules are NOT mirror reads — they are LOCAL catalogs
# served at top-level /access-groups + /schedules (see catalog.py). Only the true
# DDS-mirrored entities (cardholders/cards) are listed from the mirror here.
_MIRROR_PATHS = {
    "cardholders": "cardholders",
    "cards": "cards",
}


async def _instance_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> InstanceService:
    return InstanceService(db, scope)


async def _wt_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> WriteThroughService:
    return WriteThroughService(db, scope)


async def _door_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> DoorService:
    return DoorService(db, scope)


async def _cmd_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> CommandService:
    return CommandService(db, scope)


async def _group_catalog(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> AccessGroupCatalog:
    return AccessGroupCatalog(db, scope)


async def _schedule_catalog(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> ScheduleCatalog:
    return ScheduleCatalog(db, scope)


def _dds_err(exc: DDSError) -> HTTPException:
    """Translate a DDS write failure into a clean HTTP error (never a 500)."""
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


# ── Instance CRUD ──────────────────────────────────────────────────────


@router.get(
    "/instances",
    response_model=InstanceListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_instances(
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=500),
    search: Optional[str] = Query(None, max_length=100),
) -> InstanceListResponse:
    return await svc.list_(skip=skip, limit=limit, search=search)


@router.post(
    "/instances",
    response_model=InstancePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_instance(
    body: InstanceCreate,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> InstancePublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/instances/{instance_id}",
    response_model=InstancePublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_instance(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
) -> InstancePublic:
    return await svc.get(instance_id)


@router.patch("/instances/{instance_id}", response_model=InstancePublic)
async def update_instance(
    instance_id: str,
    body: InstanceUpdate,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> InstancePublic:
    return await svc.update(instance_id, body, actor=actor)


@router.delete("/instances/{instance_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_instance(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(instance_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Connector-driven ops ───────────────────────────────────────────────


@router.post("/instances/{instance_id}/test-connection", response_model=TestConnectionResponse)
async def test_connection(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> TestConnectionResponse:
    """Ping the controller. Returns ok/error — never 500s on an unreachable box."""
    return await svc.test_connection(instance_id)


@router.post("/instances/{instance_id}/reconcile", response_model=SyncJobPublic)
async def reconcile_instance(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> SyncJobPublic:
    """Full-sync the controller's entities into the mirror + record a SyncJob.
    Degrades to a failed/partial SyncJob when the controller is unreachable."""
    return await svc.reconcile(instance_id, trigger="manual")


@router.get(
    "/instances/{instance_id}/sync-jobs",
    response_model=SyncJobListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_sync_jobs(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    limit: int = Query(50, ge=1, le=200),
) -> SyncJobListResponse:
    return await svc.sync_jobs(instance_id, limit=limit)


# ── Read-only mirror listing ───────────────────────────────────────────


async def _list_mirror(
    svc: InstanceService, instance_id: str, path_segment: str, skip: int, limit: int
) -> MirrorListResponse:
    collection = _MIRROR_PATHS[path_segment]
    return await svc.list_mirror(instance_id, collection, skip=skip, limit=limit)


@router.get(
    "/instances/{instance_id}/cardholders",
    response_model=MirrorListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_cardholders(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> MirrorListResponse:
    return await _list_mirror(svc, instance_id, "cardholders", skip, limit)


@router.get(
    "/instances/{instance_id}/cards",
    response_model=MirrorListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_cards(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> MirrorListResponse:
    return await _list_mirror(svc, instance_id, "cards", skip, limit)


# NOTE: access-groups + schedules were previously (incorrectly) exposed here as
# DDS-mirror reads. They are LOCAL catalogs → served at top-level /access-groups +
# /schedules (see the local-catalog section below). Removed to keep ONE clean
# surface matching v2.


# ══════════════════════════════════════════════════════════════════════
# PHASE 2 — write-through CRUD, doors, commands, hardware, events
# ══════════════════════════════════════════════════════════════════════

# ── Cardholders (write-through) — v2 cardholder/routes ──────────────────


@router.post(
    "/instances/{instance_id}/cardholders",
    status_code=status.HTTP_201_CREATED,
)
async def create_cardholder(
    instance_id: str,
    body: CardholderCreate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    payload = body.model_dump(exclude_none=True)
    if not payload.get("name") and not payload.get("first_name") and not payload.get("last_name"):
        raise HTTPException(status_code=422, detail={"code": "name_required"})
    try:
        return await svc.create_cardholder(instance_id, payload)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.patch("/instances/{instance_id}/cardholders/{cardholder_id}")
async def update_cardholder(
    instance_id: str,
    cardholder_id: str,
    body: CardholderUpdate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=422, detail={"code": "empty_body"})
    try:
        return await svc.update_cardholder(instance_id, cardholder_id, payload)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete(
    "/instances/{instance_id}/cardholders/{cardholder_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_cardholder(
    instance_id: str,
    cardholder_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    try:
        await svc.delete_cardholder(instance_id, cardholder_id)
    except DDSError as exc:
        raise _dds_err(exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/instances/{instance_id}/cardholders/{cardholder_id}/suspend")
async def suspend_cardholder(
    instance_id: str,
    cardholder_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.set_cardholder_status(instance_id, cardholder_id, "Invalidated")
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post("/instances/{instance_id}/cardholders/{cardholder_id}/reinstate")
async def reinstate_cardholder(
    instance_id: str,
    cardholder_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.set_cardholder_status(instance_id, cardholder_id, "Validated")
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post("/instances/{instance_id}/cardholders/{cardholder_id}/cards")
async def cardholder_add_card(
    instance_id: str,
    cardholder_id: str,
    body: AssignCardBody,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.assign_card(instance_id, cardholder_id, body.card_id)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete("/instances/{instance_id}/cardholders/{cardholder_id}/cards/{card_id}")
async def cardholder_remove_card(
    instance_id: str,
    cardholder_id: str,
    card_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.detach_card(instance_id, cardholder_id, card_id)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post("/instances/{instance_id}/cardholders/{cardholder_id}/access-groups")
async def cardholder_add_group(
    instance_id: str,
    cardholder_id: str,
    body: AssignGroupBody,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.assign_cardholder_to_group(
            instance_id, cardholder_id, body.access_group_id
        )
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete(
    "/instances/{instance_id}/cardholders/{cardholder_id}/access-groups/{group_id}"
)
async def cardholder_remove_group(
    instance_id: str,
    cardholder_id: str,
    group_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.remove_cardholder_from_group(
            instance_id, cardholder_id, group_id
        )
    except DDSError as exc:
        raise _dds_err(exc) from None


# ── Cards (write-through) — v2 card/routes ──────────────────────────────


@router.post(
    "/instances/{instance_id}/cards",
    status_code=status.HTTP_201_CREATED,
)
async def create_card(
    instance_id: str,
    body: CardCreate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.create_card(instance_id, body.model_dump(exclude_none=True))
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.patch("/instances/{instance_id}/cards/{card_id}")
async def update_card(
    instance_id: str,
    card_id: str,
    body: CardUpdate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=422, detail={"code": "empty_body"})
    try:
        return await svc.update_card(instance_id, card_id, payload)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post("/instances/{instance_id}/cards/{card_id}/status")
async def set_card_status(
    instance_id: str,
    card_id: str,
    body: CardStatusBody,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.set_card_status(instance_id, card_id, body.status)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete(
    "/instances/{instance_id}/cards/{card_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_card(
    instance_id: str,
    card_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    try:
        await svc.delete_card(instance_id, card_id)
    except DDSError as exc:
        raise _dds_err(exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Access groups + schedules (LOCAL catalog) — v2 access_groups/routes ──
#
# These are LOCAL, instance-scoped repository catalogs (NOT DDS write-through).
# Faithful to v2: top-level ``/access-groups`` + ``/schedules`` with a REQUIRED
# ``instance_id`` query param, tenant- + instance-scoped, response keys
# ``group_id`` / ``schedule_id`` / ``door_ids`` / ``windows`` / ``holidays``.
# See ``catalog.py``. (Cardholders/cards below stay DDS write-through.)


@router.get(
    "/access-groups",
    response_model=AccessGroupListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_access_groups(
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: str = Query(..., min_length=1),
) -> AccessGroupListResponse:
    rows = await svc.list_(instance_id)
    return AccessGroupListResponse(items=[AccessGroupPublic.from_row(r) for r in rows])


@router.post(
    "/access-groups",
    response_model=AccessGroupPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_access_group(
    body: AccessGroupCreate,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: str = Query(..., min_length=1),
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> AccessGroupPublic:
    row = await svc.create(instance_id, body.model_dump())
    return AccessGroupPublic.from_row(row)


@router.get(
    "/access-groups/{group_id}",
    response_model=AccessGroupPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_access_group(
    group_id: str,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: str = Query(..., min_length=1),
) -> AccessGroupPublic:
    row = await svc.get(instance_id, group_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    return AccessGroupPublic.from_row(row)


@router.patch("/access-groups/{group_id}", response_model=AccessGroupPublic)
async def update_access_group(
    group_id: str,
    body: AccessGroupUpdate,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: str = Query(..., min_length=1),
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> AccessGroupPublic:
    row = await svc.update(instance_id, group_id, body.model_dump(exclude_unset=True))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    return AccessGroupPublic.from_row(row)


@router.delete(
    "/access-groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_access_group(
    group_id: str,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: str = Query(..., min_length=1),
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    if not await svc.delete(instance_id, group_id):
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/schedules",
    response_model=ScheduleListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_schedules(
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: str = Query(..., min_length=1),
) -> ScheduleListResponse:
    rows = await svc.list_(instance_id)
    return ScheduleListResponse(items=[SchedulePublic.from_row(r) for r in rows])


@router.post(
    "/schedules",
    response_model=SchedulePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_schedule(
    body: ScheduleCreate,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: str = Query(..., min_length=1),
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> SchedulePublic:
    row = await svc.create(instance_id, body.model_dump())
    return SchedulePublic.from_row(row)


@router.get(
    "/schedules/{schedule_id}",
    response_model=SchedulePublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_schedule(
    schedule_id: str,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: str = Query(..., min_length=1),
) -> SchedulePublic:
    row = await svc.get(instance_id, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "schedule_not_found"})
    return SchedulePublic.from_row(row)


@router.patch("/schedules/{schedule_id}", response_model=SchedulePublic)
async def update_schedule(
    schedule_id: str,
    body: ScheduleUpdate,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: str = Query(..., min_length=1),
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> SchedulePublic:
    row = await svc.update(instance_id, schedule_id, body.model_dump(exclude_unset=True))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "schedule_not_found"})
    return SchedulePublic.from_row(row)


@router.delete(
    "/schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_schedule(
    schedule_id: str,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: str = Query(..., min_length=1),
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    if not await svc.delete(instance_id, schedule_id):
        raise HTTPException(status_code=404, detail={"code": "schedule_not_found"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Doors CRUD (local, tenant-scoped) — v2 door/routes ──────────────────


@router.get(
    "/doors",
    response_model=DoorListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_doors(
    svc: Annotated[DoorService, Depends(_door_service)],
    instance_id: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
) -> DoorListResponse:
    rows, total = await svc.list_(
        instance_id=instance_id, site_id=site_id, skip=skip, limit=limit
    )
    return DoorListResponse(
        items=[DoorPublic.from_row(r) for r in rows], total=total, skip=skip, limit=limit
    )


@router.post("/doors", response_model=DoorPublic, status_code=status.HTTP_201_CREATED)
async def create_door(
    body: DoorCreate,
    svc: Annotated[DoorService, Depends(_door_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> DoorPublic:
    row = await svc.create(body.model_dump(), actor=actor)
    return DoorPublic.from_row(row)


@router.get(
    "/doors/{door_id}",
    response_model=DoorPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
) -> DoorPublic:
    return DoorPublic.from_row(await svc.get(door_id))


@router.patch("/doors/{door_id}", response_model=DoorPublic)
async def update_door(
    door_id: str,
    body: DoorUpdate,
    svc: Annotated[DoorService, Depends(_door_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> DoorPublic:
    row = await svc.update(door_id, body.model_dump(exclude_unset=True), actor=actor)
    return DoorPublic.from_row(row)


@router.delete("/doors/{door_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(door_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/doors/{door_id}/unlock")
async def unlock_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.command(door_id, "unlock")
    except DoorCommandError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None


@router.post("/doors/{door_id}/lock")
async def lock_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.command(door_id, "lock")
    except DoorCommandError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None


# ── Commands — v2 commands/routes ───────────────────────────────────────


def _cmd_http(exc: CommandError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/instances/{instance_id}/commands/outputs/activate")
async def cmd_output_activate(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.output_activate(instance_id, body.uids, body.api_keys, body.period)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/outputs/activate_continuous")
async def cmd_output_activate_continuous(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.output_activate_continuous(instance_id, body.uids, body.api_keys)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/outputs/deactivate")
async def cmd_output_deactivate(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.output_deactivate(instance_id, body.uids, body.api_keys)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/outputs/return_to_normal")
async def cmd_output_return_to_normal(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.output_return_to_normal(instance_id, body.uids, body.api_keys)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/outputs/open_all_doors")
async def cmd_output_open_all(
    instance_id: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.output_open_all_doors(instance_id)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/outputs/return_to_normal_all")
async def cmd_output_return_all(
    instance_id: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.output_return_to_normal_all(instance_id)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/alarm-zones/{dds_uid}/arm")
async def cmd_arm_zone(
    instance_id: str,
    dds_uid: str,
    body: ArmBody,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.alarm_zone_arm(
            instance_id, dds_uid, body.arm_type, body.period, body.is_minute
        )
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/alarm-zones/{dds_uid}/disarm")
async def cmd_disarm_zone(
    instance_id: str,
    dds_uid: str,
    body: DisarmBody,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.alarm_zone_disarm(
            instance_id, dds_uid, body.disarm_type, body.period, body.is_minute
        )
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/alarm-zones/{dds_uid}/return-to-schedule")
async def cmd_return_zone(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.alarm_zone_return_to_schedule(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/controllers/{dds_uid}/initialize")
async def cmd_init_controller(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.controller_initialize(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/sites/{dds_uid}/polling/start")
async def cmd_site_start_polling(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.site_start_polling(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post("/instances/{instance_id}/commands/sites/{dds_uid}/polling/stop")
async def cmd_site_stop_polling(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> dict:
    try:
        return await svc.site_stop_polling(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


# ── Hardware proxy — v2 hardware/routes ─────────────────────────────────


@router.get(
    "/instances/{instance_id}/hardware/{hardware_set}",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_hardware(
    instance_id: str,
    hardware_set: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    # Accept both dashed and underscored (alarm-zones ↔ alarm_zones).
    key = hardware_set.replace("-", "_")
    if key not in HARDWARE_SETS:
        raise HTTPException(status_code=404, detail={"code": "unknown_hardware_set"})
    try:
        return await svc.list_hardware(instance_id, key, skip=skip, limit=limit)
    except CommandError as exc:
        raise _cmd_http(exc) from None


# ── Events read API — v2 event/routes ───────────────────────────────────


@router.get(
    "/instances/{instance_id}/events",
    response_model=AccessEventListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_events(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    category: Optional[str] = Query(None),
    result: Optional[str] = Query(None),
    door_ref: Optional[str] = Query(None),
    cardholder_ref: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    from_dt: Optional[datetime] = Query(None, alias="from"),
    to_dt: Optional[datetime] = Query(None, alias="to"),
) -> AccessEventListResponse:
    return await svc.list_events(
        instance_id,
        skip=skip,
        limit=limit,
        category=category,
        result=result,
        door_ref=door_ref,
        cardholder_ref=cardholder_ref,
        event_type=event_type,
        from_dt=from_dt,
        to_dt=to_dt,
    )


routers = [router]
