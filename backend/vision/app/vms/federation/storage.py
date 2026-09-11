"""Federation — what a recorder reports about its own storage and appliances.

READ-ONLY, and that is the shape of the whole thing: the recorder owns storage —
pools, retention, tiering, RAID — and owns the third-party NVR/DVR appliances it has
onboarded. This service shows what it reports and decides none of it.

``vms.storage.manage`` is deliberately not in the federation grant set, so there is no
write to relay even if one were written here.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission

from app.db import get_db
from app.vms.federation import client as fed
from app.vms.federation._common import (
    PERM_CAMERA_REBOOT,
    PERM_DEVICE_TUNE,
    PERM_EVIDENCE_HOLD,
    PERM_EVIDENCE_READ,
    PERM_EVIDENCE_RELEASE,
    PERM_EXPORT,
    PERM_LIVE,
    PERM_MOTION_SEARCH,
    PERM_PLAYBACK,
    PERM_PTZ,
    PERM_READ,
    PERM_RECORDING,
    _online_nodes,
    _nodes_query,
    _resolve_node,
    _tag,
    _unreachable,
    log,
)
from app.vms.models import MediaNode

router = APIRouter()


# ── storage read seam (Phase-1) — the recorder node OWNS storage; the VMS only READS.
# READ-ONLY, gated on PERM_PLAYBACK (vms.playback.view) — the same permission the rest
# of the federated reads (timeline/recordings/playback) use, and the one /vms/storage/*
# reads on locally (no vms.storage.read perm exists). Node lookup + credential +
# NodeUnavailable→503 handling exactly mirror the federated read routes above.


@router.get(
    "/nodes/{node_id}/storage/usage",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_storage_usage(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The recorder node's OWN disk usage summary, read through the node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.get_node_storage_usage(node.api_url, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


@router.get(
    "/nodes/{node_id}/storage/raid",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_storage_raid(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The recorder node's OWN RAID array health, read through the node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.get_node_storage_raid(node.api_url, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


@router.get(
    "/nodes/{node_id}/storage/pools",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_storage_pools(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The recorder node's OWN storage pools, read through the node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.list_node_pools(node.api_url, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


@router.get(
    "/nodes/{node_id}/storage/tier-rules",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_storage_tier_rules(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The recorder node's OWN tiering rules, read through the node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.list_node_tier_rules(node.api_url, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


@router.get(
    "/nodes/{node_id}/nvrs",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_nvrs(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The third-party NVR/DVR appliances a recorder has onboarded.

    Read-only, and that is the whole shape of third-party NVR support here: the
    recorder onboards them, holds their credentials and syncs their channels into
    proxy cameras; the estate view says which appliances exist and how they are
    doing. Their footage needs no route of its own — a channel IS a camera on the
    node, so it arrives in the camera list and plays through the camera routes."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.list_nvrs_node(node.api_url, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/nvrs/{nvr_id}/storage",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_upstream_nvr_storage(
    node_id: str,
    nvr_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A 3rd-party UPSTREAM NVR's HDDs (federated by this recorder), read through the
    node. Returns {"available": false} when the node has no upstream storage for this
    nvr yet (client returns None on the node's 404 — the feature may still be building)."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.get_upstream_nvr_storage(node.api_url, nvr_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if payload is None:
        return {"available": False, "node_id": str(node.id), "node_name": node.name}
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


# ── archive + restore (cold tier) ────────────────────────────────────────────
#
# Retention deletes the LOCAL copy of footage the archive has already copied
# somewhere durable. From the console that looks exactly like footage being gone —
# an empty stretch of timeline — and it is not. These three reads are what tell the
# difference.
#
# READ ONLY, and deliberately incomplete: starting a restore gates node-side on
# vms.storage.manage, which this credential does not carry. The screen links out to
# the recorder for that one act rather than offering a button that can only 502.


@router.get(
    "/nodes/{node_id}/storage/archive",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_archive(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The recorder's archive posture: schedule, destination, last run, and how much
    footage is local-only (no durable copy yet) versus cold-only (archive only)."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_node_archive(node.api_url, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/storage/restore/ranges",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_restore_ranges(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    camera_id: Annotated[Optional[str], Query()] = None,
    frm: Annotated[Optional[str], Query(alias="from")] = None,
    to: Annotated[Optional[str], Query()] = None,
) -> dict:
    """What can be recovered: footage that exists ONLY in the archive.

    `from` is the query name because it is the recorder's, and every other windowed
    read on this surface already speaks it; `frm` is only the python spelling of a
    reserved word."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(
            node,
            await fed.get_node_restore_ranges(
                node.api_url, camera_id=camera_id, frm=frm, to=to, credential=node.credential
            ),
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/storage/restore/jobs",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_restore_jobs(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Recent restores and how they went, per segment."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_node_restore_jobs(node.api_url, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
