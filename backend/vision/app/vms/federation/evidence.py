"""Federation — footage that leaves the recorder, or is held on it.

Recording control, clip export and its chain of custody, evidence holds, and the
camera reboot that sits beside them as the other audited operator act.

The chain of custody is the reason this is its own module. An export is produced by
the recorder, hashed by it, and signed with ITS key; verification re-hashes the file
on the box that holds it. None of that can move here, and the routes that relay it
have to keep the recorder's own bytes and its own sentences intact.
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


# ORDER MATTERS from here down, and it is not cosmetic.
#
# FastAPI matches in REGISTRATION order and a path parameter happily matches a
# literal segment, so `/exports/{export_id}` sitting first swallowed
# `/exports/public-key` — with `export_id="public-key"`. The handler below was never
# reached, and the endpoint appeared to work only because the segment is forwarded to
# the recorder verbatim and the RECORDER's own routing resolved it correctly. It
# returned the key while the VMS believed it was fetching an export.
#
# Static before parameterised. A test asserts the VMS's own handler runs.


# ORDER MATTERS from here down, and it is not cosmetic.
#
# FastAPI matches in REGISTRATION order and a path parameter happily matches a
# literal segment, so `/exports/{export_id}` sitting first swallowed
# `/exports/public-key` — with `export_id="public-key"`. The handler below was never
# reached, and the endpoint appeared to work only because the segment is forwarded to
# the recorder verbatim and the RECORDER's own routing resolved it correctly. It
# returned the key while the VMS believed it was fetching an export.
#
# Static before parameterised. A test asserts the VMS's own handler runs.
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
