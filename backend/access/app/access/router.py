"""Access-control routes, under /api/v1/access.

Every endpoint is gated by an access.* permission and runs in the caller's tenant
scope. Covers: instance CRUD + test-connection + reconcile, mirror reads,
write-through cardholder/card CRUD, local access-group/schedule/door catalogs, and
controller commands.

The access-group and schedule routes require an instance_id query param — they are
local catalogs, not DDS entities (see catalog.py).

With no live controller, write/command/hardware endpoints return a clean error
rather than a 500; reads and door CRUD are local and work anyway.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .catalog import AccessGroupCatalog, ScheduleCatalog
from .commands import CommandError, CommandService, HARDWARE_SETS, SCHEDULED_SETS
from .doors import DoorCommandError, DoorService
from .schemas import (
    _building_id,
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
# Split out of PERM_MANAGE. Configuring an access system and USING it are
# different jobs: with one key, whoever could add a controller could also open
# every door in the estate.
PERM_CREDENTIAL = "access.credential"   # who may enter — cardholders and cards
PERM_COMMAND = "access.command"         # act on the hardware now — doors, outputs, zones


def _denied(permission: str) -> dict:
    """The two statuses every route in this router inherits from its gates.

    Composed per route rather than declared once on the APIRouter because the 403
    has to name the key the route actually gates on — and a route-level entry would
    replace a router-level one for the same status anyway.
    """
    return {
        401: {
            "description": (
                "No bearer token, a token that fails verification, or an X-Tenant-Id "
                "header that disagrees with the token's tenant claim. "
                "Envelope code UNAUTHORIZED."
            )
        },
        403: {
            "description": (
                f"The caller's token does not grant {permission}, the tenant does not "
                "have the 'access' module enabled, the tenant is suspended, or its "
                "licence has expired. Envelope codes FORBIDDEN, FEATURE_DISABLED, "
                "TENANT_SUSPENDED, LICENSE_EXPIRED."
            )
        },
    }


# A DDS/connector failure is relayed with the CONTROLLER's own status code, which
# this service cannot enumerate — so it is stated in the route description instead
# of invented as a `responses` entry.
_RELAY = (
    "A failure the controller itself reports is relayed with the controller's own "
    "status code, and the error message carries its response body."
)

_INSTANCE_404 = {
    404: {
        "description": (
            "No instance with that id in the caller's tenant. An instance owned by "
            "another tenant answers identically, so ids cannot be probed. "
            "Envelope code NOT_FOUND."
        )
    }
}

_UNREACHABLE_502 = {
    502: {
        "description": (
            "The controller could not be reached, or answered in a way the connector "
            "could not parse. Envelope code UPSTREAM_ERROR."
        )
    }
}


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
    dependencies=[Depends(require_permission(PERM_READ))],
    responses=_denied(PERM_READ),
)
async def list_instances(
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 20,
    search: Annotated[Optional[str], Query(max_length=100)] = None,
) -> InstanceListResponse:
    return await svc.list_(skip=skip, limit=limit, search=search)


@router.post(
    "/instances",
    status_code=status.HTTP_201_CREATED,
    responses={
        **_denied(PERM_MANAGE),
        409: {
            "description": (
                "Another instance in this tenant already uses that name. "
                "Envelope code CONFLICT."
            )
        },
    },
)
async def create_instance(
    body: InstanceCreate,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> InstancePublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/instances/{instance_id}",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def get_instance(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
) -> InstancePublic:
    return await svc.get(instance_id)


@router.patch(
    "/instances/{instance_id}",
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def update_instance(
    instance_id: str,
    body: InstanceUpdate,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> InstancePublic:
    return await svc.update(instance_id, body, actor=actor)


@router.delete(
    "/instances/{instance_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def delete_instance(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> Response:
    await svc.delete(instance_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Connector-driven ops ───────────────────────────────────────────────


@router.post(
    "/instances/{instance_id}/test-connection",
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def test_connection(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> TestConnectionResponse:
    """Ping the controller. Returns ok/error — never 500s on an unreachable box."""
    return await svc.test_connection(instance_id)


@router.post(
    "/instances/{instance_id}/reconcile",
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def reconcile_instance(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> SyncJobPublic:
    """Full-sync the controller's entities into the mirror + record a SyncJob.
    Degrades to a failed/partial SyncJob when the controller is unreachable."""
    return await svc.reconcile(instance_id, trigger="manual")


@router.get(
    "/instances/{instance_id}/sync-jobs",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def list_sync_jobs(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
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
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def list_cardholders(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
) -> MirrorListResponse:
    return await _list_mirror(svc, instance_id, "cardholders", skip, limit)


@router.get(
    "/instances/{instance_id}/cards",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def list_cards(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
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
    description=_RELAY,
    responses={
        **_denied(PERM_CREDENTIAL),
        **_INSTANCE_404,
        422: {
            "description": (
                "The body carries none of name, first_name or last_name — the "
                "controller cannot create a cardholder without one (code name_required)."
            )
        },
    },
)
async def create_cardholder(
    instance_id: str,
    body: CardholderCreate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    payload = body.model_dump(exclude_none=True)
    if not payload.get("name") and not payload.get("first_name") and not payload.get("last_name"):
        raise HTTPException(status_code=422, detail={"code": "name_required"})
    try:
        return await svc.create_cardholder(instance_id, payload)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.patch(
    "/instances/{instance_id}/cardholders/{cardholder_id}",
    description=_RELAY,
    responses={
        **_denied(PERM_CREDENTIAL),
        **_INSTANCE_404,
        422: {
            "description": (
                "The body sets no field, so there is nothing to write through to the "
                "controller (code empty_body)."
            )
        },
    },
)
async def update_cardholder(
    instance_id: str,
    cardholder_id: str,
    body: CardholderUpdate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
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
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def delete_cardholder(
    instance_id: str,
    cardholder_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> Response:
    try:
        await svc.delete_cardholder(instance_id, cardholder_id)
    except DDSError as exc:
        raise _dds_err(exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/instances/{instance_id}/cardholders/{cardholder_id}/suspend",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def suspend_cardholder(
    instance_id: str,
    cardholder_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.set_cardholder_status(instance_id, cardholder_id, "Invalidated")
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post(
    "/instances/{instance_id}/cardholders/{cardholder_id}/reinstate",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def reinstate_cardholder(
    instance_id: str,
    cardholder_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.set_cardholder_status(instance_id, cardholder_id, "Validated")
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post(
    "/instances/{instance_id}/cardholders/{cardholder_id}/cards",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def cardholder_add_card(
    instance_id: str,
    cardholder_id: str,
    body: AssignCardBody,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.assign_card(instance_id, cardholder_id, body.card_id)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete(
    "/instances/{instance_id}/cardholders/{cardholder_id}/cards/{card_id}",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def cardholder_remove_card(
    instance_id: str,
    cardholder_id: str,
    card_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.detach_card(instance_id, cardholder_id, card_id)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post(
    "/instances/{instance_id}/cardholders/{cardholder_id}/access-groups",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def cardholder_add_group(
    instance_id: str,
    cardholder_id: str,
    body: AssignGroupBody,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.assign_cardholder_to_group(
            instance_id, cardholder_id, body.access_group_id
        )
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete(
    "/instances/{instance_id}/cardholders/{cardholder_id}/access-groups/{group_id}",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def cardholder_remove_group(
    instance_id: str,
    cardholder_id: str,
    group_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
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
    description=_RELAY,
    responses={
        **_denied(PERM_CREDENTIAL),
        **_INSTANCE_404,
        502: {
            "description": (
                "The controller accepted the card but returned no UID, so there is "
                "nothing to patch or mirror (code dds_card_create_missing_uid)."
            )
        },
    },
)
async def create_card(
    instance_id: str,
    body: CardCreate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.create_card(instance_id, body.model_dump(exclude_none=True))
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.patch(
    "/instances/{instance_id}/cards/{card_id}",
    description=_RELAY,
    responses={
        **_denied(PERM_CREDENTIAL),
        **_INSTANCE_404,
        422: {
            "description": (
                "The body sets no field, so there is nothing to write through to the "
                "controller (code empty_body)."
            )
        },
    },
)
async def update_card(
    instance_id: str,
    card_id: str,
    body: CardUpdate,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=422, detail={"code": "empty_body"})
    try:
        return await svc.update_card(instance_id, card_id, payload)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.post(
    "/instances/{instance_id}/cards/{card_id}/status",
    description=_RELAY,
    responses={**_denied(PERM_CREDENTIAL), **_INSTANCE_404},
)
async def set_card_status(
    instance_id: str,
    card_id: str,
    body: CardStatusBody,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
) -> dict:
    try:
        return await svc.set_card_status(instance_id, card_id, body.status)
    except DDSError as exc:
        raise _dds_err(exc) from None


@router.delete(
    "/instances/{instance_id}/cards/{card_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    description=_RELAY,
    responses={
        **_denied(PERM_CREDENTIAL),
        **_INSTANCE_404,
        409: {
            "description": (
                'The mirrored card is "Used" — a card that is in use cannot be '
                "deleted (code card_in_use)."
            )
        },
    },
)
async def delete_card(
    instance_id: str,
    card_id: str,
    svc: Annotated[WriteThroughService, Depends(_wt_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_CREDENTIAL))],
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
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def list_access_groups(
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
) -> AccessGroupListResponse:
    rows = await svc.list_(instance_id)
    return AccessGroupListResponse(items=[AccessGroupPublic.from_row(r) for r in rows])


@router.post(
    "/access-groups",
    status_code=status.HTTP_201_CREATED,
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def create_access_group(
    body: AccessGroupCreate,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> AccessGroupPublic:
    row = await svc.create(instance_id, body.model_dump())
    return AccessGroupPublic.from_row(row)


@router.get(
    "/access-groups/{group_id}",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={
        **_denied(PERM_READ),
        404: {
            "description": (
                "No access group with that id under that instance, or no such "
                "instance in the caller's tenant (code group_not_found)."
            )
        },
    },
)
async def get_access_group(
    group_id: str,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
) -> AccessGroupPublic:
    row = await svc.get(instance_id, group_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    return AccessGroupPublic.from_row(row)


@router.patch(
    "/access-groups/{group_id}",
    responses={
        **_denied(PERM_MANAGE),
        404: {
            "description": (
                "No access group with that id under that instance, or no such "
                "instance in the caller's tenant (code group_not_found)."
            )
        },
    },
)
async def update_access_group(
    group_id: str,
    body: AccessGroupUpdate,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> AccessGroupPublic:
    row = await svc.update(instance_id, group_id, body.model_dump(exclude_unset=True))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    return AccessGroupPublic.from_row(row)


@router.delete(
    "/access-groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        **_denied(PERM_MANAGE),
        404: {
            "description": (
                "No access group with that id under that instance, or no such "
                "instance in the caller's tenant (code group_not_found)."
            )
        },
    },
)
async def delete_access_group(
    group_id: str,
    svc: Annotated[AccessGroupCatalog, Depends(_group_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> Response:
    if not await svc.delete(instance_id, group_id):
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/schedules",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def list_schedules(
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
) -> ScheduleListResponse:
    rows = await svc.list_(instance_id)
    return ScheduleListResponse(items=[SchedulePublic.from_row(r) for r in rows])


@router.post(
    "/schedules",
    status_code=status.HTTP_201_CREATED,
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def create_schedule(
    body: ScheduleCreate,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> SchedulePublic:
    row = await svc.create(instance_id, body.model_dump())
    return SchedulePublic.from_row(row)


@router.get(
    "/schedules/{schedule_id}",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={
        **_denied(PERM_READ),
        404: {
            "description": (
                "No schedule with that id under that instance, or no such instance "
                "in the caller's tenant (code schedule_not_found)."
            )
        },
    },
)
async def get_schedule(
    schedule_id: str,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
) -> SchedulePublic:
    row = await svc.get(instance_id, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "schedule_not_found"})
    return SchedulePublic.from_row(row)


@router.patch(
    "/schedules/{schedule_id}",
    responses={
        **_denied(PERM_MANAGE),
        404: {
            "description": (
                "No schedule with that id under that instance, or no such instance "
                "in the caller's tenant (code schedule_not_found)."
            )
        },
    },
)
async def update_schedule(
    schedule_id: str,
    body: ScheduleUpdate,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> SchedulePublic:
    row = await svc.update(instance_id, schedule_id, body.model_dump(exclude_unset=True))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "schedule_not_found"})
    return SchedulePublic.from_row(row)


@router.delete(
    "/schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        **_denied(PERM_MANAGE),
        404: {
            "description": (
                "No schedule with that id under that instance, or no such instance "
                "in the caller's tenant (code schedule_not_found)."
            )
        },
    },
)
async def delete_schedule(
    schedule_id: str,
    svc: Annotated[ScheduleCatalog, Depends(_schedule_catalog)],
    instance_id: Annotated[str, Query(min_length=1)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> Response:
    if not await svc.delete(instance_id, schedule_id):
        raise HTTPException(status_code=404, detail={"code": "schedule_not_found"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Doors CRUD (local, tenant-scoped) — v2 door/routes ──────────────────


@router.get(
    "/doors",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={
        **_denied(PERM_READ),
        422: {
            "description": (
                "site_id is not a usable building id. Answering with an empty list "
                "would read as \"no doors on that site\", which is a wrong answer."
            )
        },
    },
)
async def list_doors(
    svc: Annotated[DoorService, Depends(_door_service)],
    instance_id: Annotated[Optional[str], Query()] = None,
    site_id: Annotated[Optional[str], Query()] = None,
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> DoorListResponse:
    # Same rule the write path applies: a site id that could never be one is a
    # mistake, and answering it with an empty list reads as "no doors on that
    # site" — which is a wrong answer, not an error.
    try:
        site_id = _building_id(site_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail=f"site_id {exc}"
        ) from None
    rows, total = await svc.list_(
        instance_id=instance_id, site_id=site_id, skip=skip, limit=limit
    )
    return DoorListResponse(
        items=[DoorPublic.from_row(r) for r in rows], total=total, skip=skip, limit=limit
    )


@router.post(
    "/doors",
    status_code=status.HTTP_201_CREATED,
    responses={**_denied(PERM_MANAGE), **_INSTANCE_404},
)
async def create_door(
    body: DoorCreate,
    svc: Annotated[DoorService, Depends(_door_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> DoorPublic:
    row = await svc.create(body.model_dump(), actor=actor)
    return DoorPublic.from_row(row)


@router.get(
    "/doors/{door_id}",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={
        **_denied(PERM_READ),
        404: {
            "description": (
                "No door with that id in the caller's tenant. A door owned by another "
                "tenant answers identically. Envelope code NOT_FOUND."
            )
        },
    },
)
async def get_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
) -> DoorPublic:
    return DoorPublic.from_row(await svc.get(door_id))


@router.patch(
    "/doors/{door_id}",
    responses={
        **_denied(PERM_MANAGE),
        404: {
            "description": (
                "No door with that id in the caller's tenant. A door owned by another "
                "tenant answers identically. Envelope code NOT_FOUND."
            )
        },
    },
)
async def update_door(
    door_id: str,
    body: DoorUpdate,
    svc: Annotated[DoorService, Depends(_door_service)],
    actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> DoorPublic:
    row = await svc.update(door_id, body.model_dump(exclude_unset=True), actor=actor)
    return DoorPublic.from_row(row)


@router.delete(
    "/doors/{door_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        **_denied(PERM_MANAGE),
        404: {
            "description": (
                "No door with that id in the caller's tenant. A door owned by another "
                "tenant answers identically. Envelope code NOT_FOUND."
            )
        },
    },
)
async def delete_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_MANAGE))],
) -> Response:
    await svc.delete(door_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/doors/{door_id}/unlock",
    description=_RELAY,
    responses={
        **_denied(PERM_COMMAND),
        404: {
            "description": (
                "No door with that id in the caller's tenant, or the instance it "
                "points at is not the caller's. Envelope code NOT_FOUND."
            )
        },
        409: {
            "description": (
                "The door has no remote_ref, so there is no relay on the controller "
                "to drive (code door_not_mapped)."
            )
        },
        **_UNREACHABLE_502,
    },
)
async def unlock_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.command(door_id, "unlock")
    except DoorCommandError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None


@router.post(
    "/doors/{door_id}/lock",
    description=_RELAY,
    responses={
        **_denied(PERM_COMMAND),
        404: {
            "description": (
                "No door with that id in the caller's tenant, or the instance it "
                "points at is not the caller's. Envelope code NOT_FOUND."
            )
        },
        409: {
            "description": (
                "The door has no remote_ref, so there is no relay on the controller "
                "to drive (code door_not_mapped)."
            )
        },
        **_UNREACHABLE_502,
    },
)
async def lock_door(
    door_id: str,
    svc: Annotated[DoorService, Depends(_door_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.command(door_id, "lock")
    except DoorCommandError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None


# ── Commands — v2 commands/routes ───────────────────────────────────────


def _cmd_http(exc: CommandError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post(
    "/instances/{instance_id}/commands/outputs/activate",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_output_activate(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.output_activate(instance_id, body.uids, body.api_keys, body.period)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/outputs/activate_continuous",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_output_activate_continuous(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.output_activate_continuous(instance_id, body.uids, body.api_keys)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/outputs/deactivate",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_output_deactivate(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.output_deactivate(instance_id, body.uids, body.api_keys)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/outputs/return_to_normal",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_output_return_to_normal(
    instance_id: str,
    body: OutputTargets,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.output_return_to_normal(instance_id, body.uids, body.api_keys)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/outputs/open_all_doors",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_output_open_all(
    instance_id: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.output_open_all_doors(instance_id)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/outputs/return_to_normal_all",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_output_return_all(
    instance_id: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.output_return_to_normal_all(instance_id)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/alarm-zones/{dds_uid}/arm",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_arm_zone(
    instance_id: str,
    dds_uid: str,
    body: ArmBody,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.alarm_zone_arm(
            instance_id, dds_uid, body.arm_type, body.period, body.is_minute
        )
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/alarm-zones/{dds_uid}/disarm",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_disarm_zone(
    instance_id: str,
    dds_uid: str,
    body: DisarmBody,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.alarm_zone_disarm(
            instance_id, dds_uid, body.disarm_type, body.period, body.is_minute
        )
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/alarm-zones/{dds_uid}/return-to-schedule",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_return_zone(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.alarm_zone_return_to_schedule(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/controllers/{dds_uid}/initialize",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_init_controller(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.controller_initialize(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/sites/{dds_uid}/polling/start",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_site_start_polling(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.site_start_polling(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


@router.post(
    "/instances/{instance_id}/commands/sites/{dds_uid}/polling/stop",
    description=_RELAY,
    responses={**_denied(PERM_COMMAND), **_INSTANCE_404, **_UNREACHABLE_502},
)
async def cmd_site_stop_polling(
    instance_id: str,
    dds_uid: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    _actor: Annotated[Principal, Depends(require_permission(PERM_COMMAND))],
) -> dict:
    try:
        return await svc.site_stop_polling(instance_id, dds_uid)
    except CommandError as exc:
        raise _cmd_http(exc) from None


# ── Hardware proxy — v2 hardware/routes ─────────────────────────────────


@router.get(
    "/instances/{instance_id}/hardware/{hardware_set}",
    dependencies=[Depends(require_permission(PERM_READ))],
    description=_RELAY,
    responses={
        **_denied(PERM_READ),
        404: {
            "description": (
                "No such instance in the caller's tenant, or hardware_set is not one "
                "the connector serves (code unknown_hardware_set)."
            )
        },
        **_UNREACHABLE_502,
    },
)
async def list_hardware(
    instance_id: str,
    hardware_set: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict:
    # Accept both dashed and underscored (alarm-zones ↔ alarm_zones).
    key = hardware_set.replace("-", "_")
    if key not in HARDWARE_SETS:
        raise HTTPException(status_code=404, detail={"code": "unknown_hardware_set"})
    try:
        return await svc.list_hardware(instance_id, key, skip=skip, limit=limit)
    except CommandError as exc:
        raise _cmd_http(exc) from None


# ── Scheduled collections proxy (read-only) ─────────────────────────────


@router.get(
    "/instances/{instance_id}/scheduled/{scheduled_set}",
    dependencies=[Depends(require_permission(PERM_READ))],
    description=_RELAY,
    responses={
        **_denied(PERM_READ),
        404: {
            "description": (
                "No such instance in the caller's tenant, or scheduled_set is not one "
                "the connector serves (code unknown_scheduled_set)."
            )
        },
        **_UNREACHABLE_502,
    },
)
async def list_scheduled(
    instance_id: str,
    scheduled_set: str,
    svc: Annotated[CommandService, Depends(_cmd_service)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict:
    # Accept both dashed and underscored (scheduled-mags ↔ scheduled_mags).
    key = scheduled_set.replace("-", "_")
    if key not in SCHEDULED_SETS:
        raise HTTPException(status_code=404, detail={"code": "unknown_scheduled_set"})
    try:
        return await svc.list_scheduled(instance_id, key, skip=skip, limit=limit)
    except CommandError as exc:
        raise _cmd_http(exc) from None


# ── Events read API — v2 event/routes ───────────────────────────────────


@router.get(
    "/instances/{instance_id}/events",
    dependencies=[Depends(require_permission(PERM_READ))],
    responses={**_denied(PERM_READ), **_INSTANCE_404},
)
async def list_events(
    instance_id: str,
    svc: Annotated[InstanceService, Depends(_instance_service)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    category: Annotated[Optional[str], Query()] = None,
    result: Annotated[Optional[str], Query()] = None,
    door_ref: Annotated[Optional[str], Query()] = None,
    cardholder_ref: Annotated[Optional[str], Query()] = None,
    event_type: Annotated[Optional[str], Query()] = None,
    from_dt: Annotated[Optional[datetime], Query(alias="from")] = None,
    to_dt: Annotated[Optional[datetime], Query(alias="to")] = None,
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
