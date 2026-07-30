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

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
