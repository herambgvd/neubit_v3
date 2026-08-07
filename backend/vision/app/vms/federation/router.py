"""Federation API — aggregate node-authoritative cameras across recorders.

The central VMS surfaces the cameras owned by each registered ``MediaNode`` (NVR
node) and streams them THROUGH the node. Read-only over the nodes' estate:

  * ``GET  /vms/federation/cameras``                       — every online node's cameras, node-tagged
  * ``GET  /vms/federation/nodes``                         — the recorder nodes + reachability
  * ``POST /vms/federation/nodes/{node}/cameras/{cam}/live`` — mint a live token via the node

Cameras stay owned/managed on the node; the VMS never writes them here.
"""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission, scoped
from kernel.errors import NotFoundError

from app.db import get_db
from app.vms.models import MediaNode
from app.vms.federation import client as fed

log = logging.getLogger("vision.federation")
router = APIRouter(prefix="/vms/federation", tags=["federation"])

PERM_READ = "vms.camera.read"
PERM_LIVE = "vms.live.view"
PERM_PLAYBACK = "vms.playback.view"
PERM_PTZ = "vms.ptz.control"

# Nodes we attempt to reach for a federated read (a draining/errored node is skipped).
_REACHABLE = ("online", "unknown", "draining")


def _nodes_query(scope: Scope):
    return scoped(select(MediaNode), MediaNode, scope)


async def _online_nodes(db: AsyncSession, scope: Scope) -> list[MediaNode]:
    rows = (await db.execute(_nodes_query(scope))).scalars().all()
    return [n for n in rows if (n.status or "unknown") in _REACHABLE]


@router.get("/nodes", dependencies=[Depends(require_permission(PERM_READ))])
async def list_nodes(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    rows = (await db.execute(_nodes_query(scope))).scalars().all()
    return {
        "items": [
            {
                "id": str(n.id),
                "name": n.name,
                "api_url": n.api_url,
                "status": n.status,
                "label": n.label,
                "capacity_channels": n.capacity_channels,
                "used_channels": n.used_channels,
                "last_heartbeat": n.last_heartbeat.isoformat() if n.last_heartbeat else None,
            }
            for n in rows
        ],
        "total": len(rows),
    }


@router.get("/cameras", dependencies=[Depends(require_permission(PERM_READ))])
async def federated_cameras(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Every online recorder's own cameras, each tagged with its source node. A node
    that can't be reached is reported in ``unreachable`` and skipped, never fatal."""
    nodes = await _online_nodes(db, scope)
    items: list[dict] = []
    unreachable: list[dict] = []
    for n in nodes:
        try:
            cams = await fed.list_estate_cameras(n.api_url, credential=n.credential)
        except fed.NodeUnavailable as e:
            log.warning("federation: node %s unreachable: %s", n.name, e)
            unreachable.append({"node_id": str(n.id), "name": n.name, "error": str(e)})
            continue
        for c in cams:
            c["node_id"] = str(n.id)
            c["node_name"] = n.name
            items.append(c)
    return {"items": items, "total": len(items), "nodes": len(nodes), "unreachable": unreachable}


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/live",
    dependencies=[Depends(require_permission(PERM_LIVE))],
)
async def federated_live(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    profile: Optional[str] = None,
) -> dict:
    """Mint a live session for a federated camera THROUGH its recorder node. Returns
    the node-issued { hls_url, webrtc_url, token, expires_at, ... }."""
    node = (await db.execute(_nodes_query(scope).where(MediaNode.id == node_id))).scalar_one_or_none()
    if node is None:
        raise NotFoundError("recorder node not found")
    try:
        payload = await fed.mint_estate_live(node.api_url, camera_id, profile=profile, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"recorder unavailable: {e}")
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload


# ── operate-THROUGH-node (Phase-3) — PTZ + snapshot ──────────────────────────
# The ONLY two mutations the VMS proxies onto a node-owned camera. An operator can
# pan/tilt/zoom and grab a still of a federated camera without leaving the VMS; the
# owning NVR still runs the real device op. Everything else stays read-only.


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/ptz",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_ptz(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Run a PTZ command on a federated camera THROUGH its recorder node. ``body`` =
    { action:"move"|"stop"|"zoom"|"focus", ...payload } — ``action`` selects the
    node's /ptz/{action} subroute and the rest is the command the node forwards to
    the device. Returns the node-issued { ok, result, ... }. 502 if the node is
    unreachable (or refuses PTZ — the scoped federation credential does not carry
    vms.ptz.control; see federation.go)."""
    node = await _resolve_node(db, scope, node_id)
    action = str((body or {}).get("action") or "").strip()
    payload = {k: v for k, v in (body or {}).items() if k != "action"}
    try:
        result = await fed.ptz_node(
            node.api_url, camera_id, action, payload, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"recorder unavailable: {e}")
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/snapshot",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_snapshot(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    refresh: bool = False,
) -> Response:
    """Proxy a still frame from a federated camera THROUGH its recorder node. The node
    grabs the frame off its own camera and answers a base64 data URI; we decode it and
    hand back the raw image with the node's content-type so the browser renders/saves
    it directly. 502 if the node is unreachable or returns no decodable image."""
    node = await _resolve_node(db, scope, node_id)
    try:
        raw, content_type = await fed.snapshot_node(
            node.api_url, camera_id, refresh=refresh, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"recorder unavailable: {e}")
    return Response(content=raw, media_type=content_type, headers={"Cache-Control": "no-store"})


async def _resolve_node(db: AsyncSession, scope: Scope, node_id: str) -> MediaNode:
    node = (await db.execute(_nodes_query(scope).where(MediaNode.id == node_id))).scalar_one_or_none()
    if node is None:
        raise NotFoundError("recorder node not found")
    return node


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/timeline",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_timeline(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    profile: Optional[str] = None,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
) -> dict:
    """Merged recorded-coverage ranges (scrub bar) for a federated camera, via its node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.get_node_timeline(
            node.api_url, camera_id, profile=profile, from_=from_, to=to, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"recorder unavailable: {e}")
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/recordings",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_recordings(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    profile: Optional[str] = None,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
    limit: int = 500,
    offset: int = 0,
) -> dict:
    """A federated camera's per-segment recording index THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.list_node_recordings(
            node.api_url, camera_id, profile=profile, from_=from_, to=to,
            limit=limit, offset=offset, credential=node.credential,
        )
    except fed.NodeUnavailable as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"recorder unavailable: {e}")
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload


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
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"recorder unavailable: {e}")
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
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"recorder unavailable: {e}")
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
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"recorder unavailable: {e}")
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
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"recorder unavailable: {e}")
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


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
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"recorder unavailable: {e}")
    if payload is None:
        return {"available": False, "node_id": str(node.id), "node_name": node.name}
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/playback",
    dependencies=[Depends(require_permission(PERM_PLAYBACK))],
)
async def federated_playback(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
) -> dict:
    """Mint a playback session for a federated camera THROUGH its recorder node. Returns
    the node-issued { session_id, playback_url, token, start, ranges, expires_at, ... }.
    200 with an empty playback_url means no footage in the window (not an error)."""
    node = await _resolve_node(db, scope, node_id)
    try:
        payload = await fed.mint_node_playback(
            node.api_url, camera_id, from_=from_, to=to, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"recorder unavailable: {e}")
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload
