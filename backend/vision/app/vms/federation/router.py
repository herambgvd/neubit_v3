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

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status
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
# operate-THROUGH-node (Phase-3, extended) operator perms. Vision declares its perms as
# plain string literals passed to require_permission (no central registry; grants() does
# super-admin/'*' bypass), so these are declared here exactly like PERM_PTZ above and
# mirror the node-side grants the federation credential now carries.
# These OPERATOR-facing gates must match the perms real VMS roles actually grant
# (and the client's button-visibility gates) so a visible action never 403s. They
# are the operator's right; the NODE separately enforces the federation credential's
# own scoped grants (recording.control / export.create / evidence.* / camera.reboot).
PERM_RECORDING = "vms.recording.control"  # manual record + evidence-write, as the local recording/evidence UI gates
PERM_EXPORT = "vms.playback.view"         # clip export rides the playback/investigation right the app uses
PERM_EVIDENCE_HOLD = "vms.recording.control"   # evidence write == recording.control (matches EvidenceLockModal)
PERM_EVIDENCE_RELEASE = "vms.recording.control"
PERM_EVIDENCE_READ = "vms.playback.view"
PERM_CAMERA_REBOOT = "vms.config.manage"  # the real device-maintenance/reboot right (deviceMgmt.reboot)

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


# ── operate-THROUGH-node (Phase-3, extended) — recording control, clip export,
# evidence hold/release, and camera reboot. Each resolves the MediaNode + credential
# exactly like the PTZ route, proxies the operator's action to the owning NVR (which
# runs the real op), maps NodeUnavailable→503, and returns the node's JSON (or the
# streamed mp4 for a download). Gated on the vision operator perm matching the action.


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/recording/start",
    dependencies=[Depends(require_permission(PERM_RECORDING))],
)
async def federated_recording_start(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Start recording a federated camera THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.record_start_node(node.api_url, camera_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/recording/stop",
    dependencies=[Depends(require_permission(PERM_RECORDING))],
)
async def federated_recording_stop(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Stop recording a federated camera THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.record_stop_node(node.api_url, camera_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/reboot",
    dependencies=[Depends(require_permission(PERM_CAMERA_REBOOT))],
)
async def federated_camera_reboot(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Reboot a federated camera (ONVIF) THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.reboot_camera_node(node.api_url, camera_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/exports",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_create(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Queue a clip export of a federated camera THROUGH its recorder node. ``body`` =
    { from, to, watermark? } (RFC3339). Returns the node-issued 202 { id, status, ... }.

    ``watermark`` burns a visible provenance stamp into the picture and forces a
    re-encode on the recorder — a slower job producing a clip that is no longer
    bit-identical to the segments. The operator chooses it per export; it is not a
    policy this service applies."""
    node = await _resolve_node(db, scope, node_id)
    frm = str((body or {}).get("from") or "").strip()
    to = str((body or {}).get("to") or "").strip()
    try:
        result = await fed.create_export_node(
            node.api_url, camera_id, frm, to,
            watermark=bool((body or {}).get("watermark")),
            credential=node.credential,
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/exports",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_list(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's export jobs, listed THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.list_exports_node(node.api_url, camera_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.get(
    "/nodes/{node_id}/exports/{export_id}",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_status(
    node_id: str,
    export_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """One export job's status, read THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.get_export_node(node.api_url, export_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.post(
    "/nodes/{node_id}/exports/{export_id}/verify",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_verify(
    node_id: str,
    export_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Ask the recorder to re-hash its own copy of the clip and check the manifest
    signature. { valid, reason, public_key, signed_by_this_node, manifest? }.

    The VMS never sees the clip's bytes, so it cannot answer this itself — and a
    re-hash of a copy relayed through here would only prove the copy arrived intact,
    which is not the question."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.verify_export_node(node.api_url, export_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    return _tag(node, result)


@router.get(
    "/nodes/{node_id}/exports/public-key",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_public_key(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The recorder's export signing key — { algorithm, key_id, public_key }.

    Per NODE, not per VMS: each recorder signs with its own identity, so there is no
    single key the VMS could publish on their behalf without lying about who vouched
    for a given clip."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.export_public_key_node(node.api_url, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    return _tag(node, result)


@router.get(
    "/nodes/{node_id}/exports/{export_id}/manifest",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_manifest(
    node_id: str,
    export_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> Response:
    """Relay the signed chain-of-custody manifest, byte for byte.

    Byte for byte, and not parsed into a dict and re-encoded: the signature covers the
    document's canonical bytes, so re-serialising it here would break the very offline
    verification it exists for."""
    node = await _resolve_node(db, scope, node_id)
    try:
        raw, media_type, filename = await fed.export_manifest_node(
            node.api_url, export_id, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    return Response(
        content=raw,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.get(
    "/nodes/{node_id}/exports/{export_id}/download",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def federated_export_download(
    node_id: str,
    export_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> Response:
    """Download a produced clip THROUGH its recorder node. The node streams the mp4; we
    relay the bytes with the node's media-type and an attachment disposition so the browser
    saves it directly. 503 if the node is unreachable."""
    node = await _resolve_node(db, scope, node_id)
    try:
        raw, media_type, filename = await fed.download_export_node(
            node.api_url, export_id, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    return Response(
        content=raw,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/holds",
    dependencies=[Depends(require_permission(PERM_EVIDENCE_HOLD))],
)
async def federated_evidence_hold(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Place an evidence hold on a federated camera THROUGH its recorder node. ``body`` =
    { from, to, reason }. Returns the node-issued hold JSON."""
    node = await _resolve_node(db, scope, node_id)
    frm = str((body or {}).get("from") or "").strip()
    to = str((body or {}).get("to") or "").strip()
    reason = str((body or {}).get("reason") or "").strip()
    try:
        result = await fed.evidence_hold_node(
            node.api_url, camera_id, frm, to, reason, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.delete(
    "/nodes/{node_id}/cameras/{camera_id}/holds",
    dependencies=[Depends(require_permission(PERM_EVIDENCE_RELEASE))],
)
async def federated_evidence_release(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    from_: Annotated[str, Query(alias="from")],
    to: str,
) -> dict:
    """Release an evidence hold on a federated camera THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.evidence_release_node(
            node.api_url, camera_id, from_, to, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/holds",
    dependencies=[Depends(require_permission(PERM_EVIDENCE_READ))],
)
async def federated_evidence_list(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's active evidence holds, listed THROUGH its recorder node."""
    node = await _resolve_node(db, scope, node_id)
    try:
        result = await fed.list_holds_node(node.api_url, camera_id, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


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


def _tag(node: MediaNode, payload):
    """Stamp the source node onto a node-issued payload, as every federated route does,
    so a client holding a merged multi-node view can always say which recorder answered.
    Non-dict payloads (there are none today) pass through untouched."""
    if isinstance(payload, dict):
        payload["node_id"] = str(node.id)
        payload["node_name"] = node.name
    return payload


def _unreachable(e: Exception) -> HTTPException:
    """Map a failed node call to a status that says WHICH kind of failure it was.

    A recorder that REFUSED us is not a recorder that is down, and conflating the two
    is a real cost: a 403 for a missing grant surfaced as "recorder unavailable" twice
    in one afternoon, and both times it sent the reader to look at the network. A
    refusal is a 502 with the node's own sentence, which names the missing permission
    and what to do about it (re-enrol).

    Everything else — a connection refused, a timeout, a 5xx from the node — is a 503:
    the call may well work on the next try, which is exactly what that status means and
    a 502 does not.
    """
    if isinstance(e, fed.NodeRefused):
        return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"recorder unavailable: {e}"
    )


# ── Image tab — picture settings + the focus MOTOR (onvifapi/imaging.go) ──────


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/imaging",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_imaging_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's live imaging settings + options, read THROUGH its node.
    imaging.go getImaging: { settings, source_token, options, options_error?, focus? }.
    ``options_error`` is REPORTED, never swallowed — a dropped GetOptions is not the
    same fact as a device with nothing adjustable, and a UI that conflated them would
    present a reduced control set as the camera's real capability."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_imaging_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.put(
    "/nodes/{node_id}/cameras/{camera_id}/imaging",
    dependencies=[Depends(require_permission(PERM_DEVICE_TUNE))],
)
async def federated_imaging_set(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Apply picture settings to a federated camera THROUGH its node. Body is
    onvif.ImagingSettings (imaging.go setImaging) — a PARTIAL block is the normal way to
    change one setting, so it is relayed as given rather than merged here; the node
    validates required children before anything reaches the wire."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.set_imaging_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/imaging/focus/move",
    dependencies=[Depends(require_permission(PERM_DEVICE_TUNE))],
)
async def federated_focus_move(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Drive a federated camera's lens THROUGH its node. imaging.go focusMoveReq
    { mode: relative|absolute|continuous, distance?, position?, speed?, timeout_ms? }.
    Returns { moved, mode, source_token }. The node bounds a continuous move with its
    own watchdog, so a dropped Stop cannot leave the lens travelling."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.focus_move_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/imaging/focus/stop",
    dependencies=[Depends(require_permission(PERM_DEVICE_TUNE))],
)
async def federated_focus_stop(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Stop a federated camera's focus move THROUGH its node. Returns { stopped }."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.focus_stop_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


# ── Video / Audio encoder tabs (onvifapi/video.go, audio.go) ──────────────────


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/video",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_video_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's video encoder configurations + options, via its node.
    video.go getVideo — carries ``media_service`` / ``media2_available`` on every shape
    including the refusals, so the console can always say which service it is showing."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_video_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/audio",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_audio_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's audio encoder configurations + options, via its node.
    audio.go getAudio — ``scoped:false`` with a ``scope_reason`` is the device saying
    this channel's input could not be identified, not an error."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_audio_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/osd",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_osd_list(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's live OSD overlays + what the device allows, via its node.
    overlay.go getOSD: { osds, config_token, options, options_error? }."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.list_osds_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/masks",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_masks_list(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's privacy masks + mask options, via its node. overlay.go
    getMasks — relayed WITH ``coordinate_space`` (ONVIF normalised: x,y in [-1,1],
    origin at frame centre, y UP), because a draw-on-frame UI that guesses the space
    puts the mask somewhere nobody chose."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.list_masks_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/backchannel",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_backchannel(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Whether a federated camera can RECEIVE a talk-back stream, via its node
    (overlay.go getBackchannel). The read the console needs to enable or honestly
    DISABLE push-to-talk, rather than offering a button that cannot work."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_backchannel_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


# ── camera-side ONVIF motion detection (onvifapi/motion.go) ───────────────────


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/motion",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_motion_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's DEVICE-side motion detection config, via its node.
    motion.go getMotion: { supported, profile_token, columns, rows, sensitivity,
    active_cells?, zones?, reason? }. ``supported:false`` + ``reason`` is firmware
    answering honestly, and comes back 200, not an error."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_motion_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/io",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_io_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's DEVICE digital inputs + relays, via its node (io.go getIO).
    ``scope:"device"`` is the contract: this describes the whole device, and
    ``channels_on_device`` / ``channel_names`` name the other channels a relay drive
    would affect."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_io_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/io/relays/{token}/state",
    dependencies=[Depends(require_permission(PERM_DEVICE_TUNE))],
)
async def federated_relay_state(
    node_id: str,
    camera_id: str,
    token: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """DRIVE a relay on a federated camera's device, via its node. io.go relayStateReq
    { state: "active"|"inactive" }. This is the one federated call whose effect is
    physical and outside the network; the node audits it on both outcomes. The reply's
    ``latching`` is three-valued — null means the device did not report its mode, NOT
    "there is a way back from this"."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.set_relay_state_node(node.api_url, camera_id, token, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


# ── PTZ: capability, device presets, host patrol, native tours ───────────────


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/ptz",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_ptz_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's PTZ capability report, via its node (ptz.go getPtz). The
    read the pad needs before it can offer anything: no ``node`` in the payload means
    no movable head bound to this channel, and ``detail`` says which of the two
    reasons it is."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_ptz_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/presets",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_presets_list(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's DEVICE presets, via its node (ptz.go ptzListPresets).
    These are the camera's own presets — there is no VMS-side preset table to
    translate, which is the whole point of node ownership."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.list_ptz_presets_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/presets",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_preset_save(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Store a federated camera's CURRENT position as a preset, via its node. ptz.go
    ptzSavePreset { name, token? } — an empty token creates, a supplied token
    OVERWRITES that preset. Takes PERM_PTZ, not the config gate: this is the PTZ
    operator's own tool, and it is the same right the pad already carries."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.save_ptz_preset_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/presets/{preset}/goto",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_preset_goto(
    node_id: str,
    camera_id: str,
    preset: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Optional[dict] = Body(None),
) -> dict:
    """Recall a preset on a federated camera, via its node. ptz.go ptzGotoPreset —
    ``preset`` is the DEVICE token from the list route, and { speed?, zoom_speed? } is
    optional. Returns { moved, preset }."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.goto_ptz_preset_node(node.api_url, camera_id, preset, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.delete(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/presets/{preset}",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_preset_delete(
    node_id: str,
    camera_id: str,
    preset: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Delete a preset from a federated camera's device, via its node. The node answers
    204, so this answers { node_id, node_name } — a body, because every other route
    here carries the node tag and a lone 204 would be the one shape a client special-cases."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.delete_ptz_preset_node(node.api_url, camera_id, preset, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/patrol",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_patrol_get(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's HOST-DRIVEN patrol config, via its node (ptz_patrol.go
    getPatrol). ``kind:"host_driven"`` and the accompanying note are load-bearing: this
    patrol runs on the RECORDER, not on the camera, and the payload says so rather than
    letting a UI present it as a tour the camera holds. ``native_tours_supported``
    absent means unknown, not "no"."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.get_patrol_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.put(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/patrol",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_patrol_set(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Save a federated camera's patrol stops / dwell / order, via its node. ptz_patrol.go
    patrolWriteReq — the node validates every stop against the DEVICE's live preset list,
    so a stop naming a preset the camera does not have is refused rather than driving
    the head somewhere nobody chose."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.set_patrol_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/patrol/operate",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_patrol_operate(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Start or stop a federated camera's host-driven patrol, via its node
    { operation: "start"|"stop" }. Arming unattended motion: the node audits both."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.operate_patrol_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/tours",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def federated_tours_list(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """A federated camera's NATIVE ONVIF preset tours, via its node (ptz_tours.go
    ptzListTours). ``tours_supported`` is a tri-state — true / false / ABSENT — and the
    absent case ("we could not ask") is the only one worth a Retry. Relayed as the node
    sent it; collapsing it to a boolean is how a dropped packet becomes a permanent
    statement about somebody's hardware."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.list_ptz_tours_node(node.api_url, camera_id, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/tours",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_tour_create(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Create a preset tour ON a federated camera, via its node (ptz_tours.go tourReq).
    Returns { token, populated, tour? }; the node's two-step create is deliberately not
    atomic and its error says so, so a ``populated:false`` reply means an empty tour
    exists on the device and the modify did not land."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.create_ptz_tour_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.put(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/tours/{tour}",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_tour_modify(
    node_id: str,
    camera_id: str,
    tour: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Rewrite one preset tour on a federated camera, via its node. tourReq overlays the
    DEVICE's own values (absent = leave alone) EXCEPT ``spots``, which replaces the list
    wholesale — a patrol is an ordered sequence and there is no per-spot patch."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.modify_ptz_tour_node(node.api_url, camera_id, tour, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.delete(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/tours/{tour}",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_tour_delete(
    node_id: str,
    camera_id: str,
    tour: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Remove a preset tour from a federated camera, via its node (204 → node tag)."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.delete_ptz_tour_node(node.api_url, camera_id, tour, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/ptz/tours/{tour}/operate",
    dependencies=[Depends(require_permission(PERM_PTZ))],
)
async def federated_tour_operate(
    node_id: str,
    camera_id: str,
    tour: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Start / Stop / Pause a preset tour on a federated camera, via its node
    { operation }. The sharpest command in this file: every other one moves a head while
    somebody watches, this hands the head to the device and walks away — which is why
    the node audits every operate, including the ones that end motion."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.operate_ptz_tour_node(node.api_url, camera_id, tour, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


# ── push-to-talk (onvifapi/talk.go, talk_uplink.go) ───────────────────────────


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/talk",
    dependencies=[Depends(require_permission(PERM_DEVICE_TUNE))],
)
async def federated_talk_begin(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Optional[dict] = Body(None),
) -> dict:
    """Begin push-to-talk on a federated camera, via its node (talk.go postTalk): the
    capability + transport check and the audited intent, returning
    { talking, half_duplex, transport, support, started_at }. A node with no talk
    transport configured answers an honest 501, which arrives here as a 502 carrying
    the node's OWN sentence — "the path is not built", not a bare status code."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.talk_begin_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/talk/uplink",
    dependencies=[Depends(require_permission(PERM_DEVICE_TUNE))],
)
async def federated_talk_uplink(
    node_id: str,
    camera_id: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Carry the operator's microphone to a federated camera's speaker, via its node
    (talk_uplink.go postTalkUplink): a streamed PCM16LE 8 kHz mono body, which this
    route STREAMS through rather than buffering. Buffering would both cap how long a
    press may last and hold every frame until the operator let go — on a live talk that
    is the difference between speaking to somebody and playing them a recording of it.
    Returns { talked, half_duplex, codec, frames_sent, finished_at }."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.talk_uplink_node(
            node.api_url, camera_id, request.stream(), credential=node.credential
        ))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


# ── forensic motion search over RECORDED footage (estate/motionsearch.go) ─────


@router.post(
    "/nodes/{node_id}/cameras/{camera_id}/motion-search",
    dependencies=[Depends(require_permission(PERM_MOTION_SEARCH))],
)
async def federated_motion_search(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict, Body(...)],
) -> dict:
    """Forensic region motion search over a federated camera's RECORDED footage, run on
    the node that holds it (motionsearch.go). Body { from, to, region?, sensitivity?,
    sample_interval_sec?, min_duration_sec?, merge_gap_sec? }.

    The node's response is relayed WHOLE, and two of its fields must survive the trip:
    ``method``/``summary`` (this is pixel-difference, NOT AI — no object detection, and
    a hit list without that disclosure is what somebody reads as "three intruders"), and
    ``complete``/``notes``/``gaps`` (a bounded search that gave up must not present an
    empty hit list as "the footage is clear"). Nothing is written, moved or deleted, so
    evidence-locked footage is safe to search — which is why this is a playback READ
    gated on PERM_MOTION_SEARCH even though the verb is POST."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await fed.motion_search_node(node.api_url, camera_id, body or {}, credential=node.credential))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
