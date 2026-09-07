"""Federation — the aggregate READS and the session mints.

What the estate view is made of: which recorders exist, which cameras they own, and a
token to watch or scrub one. Everything here is either a read across recorders — the
question no single recorder can answer — or a session the OWNING recorder mints and
this service relays.
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


@router.get("/nvrs", dependencies=[Depends(require_permission(PERM_READ))])
async def federated_nvrs_all(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Every online recorder's third-party NVR/DVR appliances, merged and tagged.

    The estate-wide view of appliances nobody but the VMS can assemble: each recorder
    knows only the ones IT onboarded. Same shape and same failure discipline as
    ``/cameras`` — a node that cannot be reached is listed in ``unreachable`` and
    skipped, never fatal, because one recorder rebooting must not empty the inventory.
    """
    nodes = await _online_nodes(db, scope)
    items: list[dict] = []
    unreachable: list[dict] = []
    for n in nodes:
        try:
            payload = await fed.list_nvrs_node(n.api_url, credential=n.credential)
        except fed.NodeUnavailable as e:
            log.warning("federation: node %s unreachable: %s", n.name, e)
            unreachable.append({"node_id": str(n.id), "name": n.name, "error": str(e)})
            continue
        for row in (payload or {}).get("items") or []:
            if not isinstance(row, dict):
                continue
            row["node_id"] = str(n.id)
            row["node_name"] = n.name
            items.append(row)
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
        raise _unreachable(e)
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload


# ── operate-THROUGH-node (Phase-3) — PTZ + snapshot ──────────────────────────
# The ONLY two mutations the VMS proxies onto a node-owned camera. An operator can
# pan/tilt/zoom and grab a still of a federated camera without leaving the VMS; the
# owning NVR still runs the real device op. Everything else stays read-only.


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
        raise _unreachable(e)
    return Response(content=raw, media_type=content_type, headers={"Cache-Control": "no-store"})

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
        raise _unreachable(e)
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
        raise _unreachable(e)
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload


# ── operate-THROUGH-node (Phase-3, extended) — recording control, clip export,
# evidence hold/release, and camera reboot. Each resolves the MediaNode + credential
# exactly like the PTZ route, proxies the operator's action to the owning NVR (which
# runs the real op), maps NodeUnavailable→503, and returns the node's JSON (or the
# streamed mp4 for a download). Gated on the vision operator perm matching the action.


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
        raise _unreachable(e)
    payload["node_id"] = str(node.id)
    payload["node_name"] = node.name
    return payload


# ── operate-THROUGH-node (Phase-4) — the whole per-camera DEVICE surface ──────
#
# Model A WAS the VMS decrypting a camera's credentials and driving the device itself.
# It is gone. Model B is this module: the OWNING NVR drives the device and the VMS
# commands through the node. Model B used to stop at PTZ move/stop + snapshot, so
# imaging, digital I/O, presets, patrol, talk and forensic motion search were reachable
# only through Model A — which is what made deleting it possible only after these
# existed. The node served every one of them all along.
#
# Shape, deliberately identical to the routes above: /nodes/{node_id}/cameras/{camera_id}/…,
# _resolve_node for tenant scoping (a node another tenant owns is simply not found → 404),
# node.credential for auth, and NodeUnavailable → 502. 502 and not 503: the VMS is
# reachable and answering; it is the UPSTREAM recorder that did not, which is what a
# Bad Gateway says and what the live/ptz/snapshot/timeline/playback routes above
# already say. (The Phase-3 batch — recording/export/holds/storage — answers 503 for
# the same condition. That inconsistency predates this change and is left alone rather
# than silently repointed under a client that may branch on it.)
#
# Permissions. Reads take PERM_READ; every device WRITE takes PERM_DEVICE_TUNE
# (vms.config.manage) — the same right the local device-management UI gates on, and
# the honest one: an OSD, a privacy mask, an encoder profile or a motion mask changes
# what every future recording CONTAINS. Relay drive and talk are the exceptions worth
# naming: they are physical acts outside the network, and they take the same gate for
# a stronger reason, not a weaker one. Forensic motion search is a READ of recorded
# footage and rides PERM_PLAYBACK, exactly as the node does (core.PermPlaybackView).
#
# One thing this stage CANNOT fix from here: node-side, every write below is gated on
# core.PermCameraManage, which estate/federation.go's federationGrants deliberately
# omits. A node that issued a scoped credential will 403 these (→ 502 with the node's
# own sentence); they pass only where the node still accepts the shared service JWT.
# Widening that grant set is a node-side decision. The VMS surface is ready for it.

# Live-scene TUNING, not config authorship — the VMS half of the node's
# vms.camera.tune (nvr estate/core/perms.go). Imaging + focus, driving a relay's
# state and push-to-talk are operator acts on a picture somebody is watching now.
#
# There is no PERM_DEVICE_TUNE any more, and that absence is the design. The
# federated writes that DID author config — encoder video/audio, OSD, privacy
# masks, motion zones, relay IdleState — are gone from this router entirely, not
# re-gated: the node refuses them to a federation credential on purpose, because
# a central VMS that can rewrite a recorder's camera configuration has become an
# NVR. Those screens belong to the owning node's own console.
PERM_DEVICE_TUNE = "vms.camera.tune"
PERM_MOTION_SEARCH = "vms.playback.view"  # forensic search reads recorded footage

# ── Image tab — picture settings + the focus MOTOR (onvifapi/imaging.go) ──────
