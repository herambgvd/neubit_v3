"""Shared plumbing for the federation surface — one router, split by what it does.

The federation API is one prefix (``/vms/federation``) and four concerns, and it grew
to fifty-six routes in a single file. They are split by what a call ASKS FOR, not by
which Go file answers it:

  * ``estate``   — the aggregate reads and the session mints (nodes, cameras, live,
                   snapshot, timeline, recordings, playback)
  * ``device``   — the per-camera OPERATE surface (PTZ, imaging, I/O, talk, motion)
  * ``evidence`` — footage that leaves or is held (recording control, exports and
                   their chain of custody, evidence holds, camera reboot)
  * ``storage``  — what the recorder reports about its own disks and appliances

Every one of them needs the same four things, which is what lives here.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, scoped
from kernel.errors import NotFoundError

from app.vms.federation import client as fed
from app.vms.models import MediaNode

log = logging.getLogger("vision.federation")

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
PERM_EXPORT = PERM_PLAYBACK               # clip export rides the playback/investigation right the app uses
PERM_EVIDENCE_HOLD = PERM_RECORDING       # evidence write == recording.control (matches EvidenceLockModal)
PERM_EVIDENCE_RELEASE = PERM_RECORDING
PERM_EVIDENCE_READ = PERM_PLAYBACK
PERM_CAMERA_REBOOT = "vms.config.manage"  # the real device-maintenance/reboot right (deviceMgmt.reboot)

# Nodes we attempt to reach for a federated read (a draining/errored node is skipped).
_REACHABLE = ("online", "unknown", "draining")
PERM_DEVICE_TUNE = "vms.camera.tune"
PERM_MOTION_SEARCH = PERM_PLAYBACK        # forensic search reads recorded footage


def _nodes_query(scope: Scope):
    return scoped(select(MediaNode), MediaNode, scope)


async def _online_nodes(db: AsyncSession, scope: Scope) -> list[MediaNode]:
    rows = (await db.execute(_nodes_query(scope))).scalars().all()
    return [n for n in rows if (n.status or "unknown") in _REACHABLE]


async def _resolve_node(db: AsyncSession, scope: Scope, node_id: str) -> MediaNode:
    node = (await db.execute(_nodes_query(scope).where(MediaNode.id == node_id))).scalar_one_or_none()
    if node is None:
        raise NotFoundError("recorder node not found")
    return node


async def _via(db: AsyncSession, scope: Scope, node_id: str, call):
    """Resolve the node, make ONE call against it, and stamp the answer.

    Every route on this surface does the same four things: find the recorder (404
    if it is not the caller's), call it, turn a failure into the right status, and
    say which recorder answered. Written out per route that is seven lines
    repeated sixty-odd times — and the repetition is not the cost. The cost is that
    each copy is a chance to get the ERROR MAPPING wrong, and one of them did: a
    node's 4xx was reported as "recorder unavailable" until it was fixed in the one
    place that had been written carefully.

    `call` takes the node and returns the coroutine, so the credential and api_url
    come from the row this function resolved rather than from anything the route
    closed over.
    """
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(node, await call(node))
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


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


__all__ = [
    "log",
    "_nodes_query",
    "_online_nodes",
    "_resolve_node",
    "_tag",
    "_unreachable",
]
