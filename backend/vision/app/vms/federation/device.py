"""Federation — the per-camera OPERATE surface.

An operator acting on a live scene through the recorder that owns the camera: moving
the head, nudging focus, driving a relay, speaking through it, searching recorded
footage for movement.

What is deliberately NOT here is config authorship — the encoder, OSD, privacy masks,
motion zones, a relay's IdleState. Those are the recorder's, it withholds
``vms.camera.manage`` from a federation credential on purpose, and a route for them
here could only ever produce a refusal. The reads stay so the console can SHOW the
state it cannot change.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission

from app.db import get_db
from app.vms.federation import client as fed
from app.vms.federation._common import (
    _via,
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
        raise _unreachable(e)
    if isinstance(result, dict):
        result["node_id"] = str(node.id)
        result["node_name"] = node.name
    return result


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
    return await _via(db, scope, node_id, lambda n: fed.get_imaging_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.set_imaging_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.focus_move_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.focus_stop_node(n.api_url, camera_id, credential=n.credential))


# ── Video / Audio encoder tabs (onvifapi/video.go, audio.go) ──────────────────


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
    return await _via(db, scope, node_id, lambda n: fed.get_video_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.get_audio_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.list_osds_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.list_masks_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.get_backchannel_node(n.api_url, camera_id, credential=n.credential))


# ── camera-side ONVIF motion detection (onvifapi/motion.go) ───────────────────


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
    return await _via(db, scope, node_id, lambda n: fed.get_motion_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.get_io_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.set_relay_state_node(n.api_url, camera_id, token, body or {}, credential=n.credential))


# ── PTZ: capability, device presets, host patrol, native tours ───────────────


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
    return await _via(db, scope, node_id, lambda n: fed.get_ptz_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.list_ptz_presets_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.save_ptz_preset_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    body: Annotated[Optional[dict], Body()] = None,
) -> dict:
    """Recall a preset on a federated camera, via its node. ptz.go ptzGotoPreset —
    ``preset`` is the DEVICE token from the list route, and { speed?, zoom_speed? } is
    optional. Returns { moved, preset }."""
    return await _via(db, scope, node_id, lambda n: fed.goto_ptz_preset_node(n.api_url, camera_id, preset, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.delete_ptz_preset_node(n.api_url, camera_id, preset, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.get_patrol_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.set_patrol_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.operate_patrol_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.list_ptz_tours_node(n.api_url, camera_id, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.create_ptz_tour_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.modify_ptz_tour_node(n.api_url, camera_id, tour, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.delete_ptz_tour_node(n.api_url, camera_id, tour, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.operate_ptz_tour_node(n.api_url, camera_id, tour, body or {}, credential=n.credential))


# ── push-to-talk (onvifapi/talk.go, talk_uplink.go) ───────────────────────────


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
    body: Annotated[Optional[dict], Body()] = None,
) -> dict:
    """Begin push-to-talk on a federated camera, via its node (talk.go postTalk): the
    capability + transport check and the audited intent, returning
    { talking, half_duplex, transport, support, started_at }. A node with no talk
    transport configured answers an honest 501, which arrives here as a 502 carrying
    the node's OWN sentence — "the path is not built", not a bare status code."""
    return await _via(db, scope, node_id, lambda n: fed.talk_begin_node(n.api_url, camera_id, body or {}, credential=n.credential))


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
    return await _via(db, scope, node_id, lambda n: fed.motion_search_node(n.api_url, camera_id, body or {}, credential=n.credential))
