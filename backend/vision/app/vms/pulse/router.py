"""PULSE — the surveillance estate's operational health, in one read.

WHAT THIS IS AND WHY IT IS NOT THE SERVICE-HEALTH SCREEN.
The console's Surveillance mode has a Pulse tile. It used to open the platform's
container health board — the list of Docker services with their logs — which is a
platform-admin surface, is already reachable under Configurations, and answers a
question no operator on a video wall is asking. Their questions are: which cameras
are down and where, is footage actually being written, how much storage headroom
is left, and what needs me first.

Every one of those is a fact the OWNING RECORDER already measures. Each node
serves its whole System-Monitor board at ``GET /estate/sysmon`` behind
``camera.read`` — a grant every federation credential already carries — so this
module is a fan-out and a roll-up, not a new measurement:

    GET /vms/pulse/overview                                  the estate answer
    GET /vms/pulse/nodes/{node_id}/sysmon                    one recorder's board
    GET /vms/pulse/nodes/{node_id}/cameras/{camera_id}/isolate   one fault trace

WHAT IT REFUSES TO DO. No estate figure is ever computed across a recorder that
did not answer: the totals count the recorders that did, ``partial`` says whether
any did not, and the ones that did not are named. Nothing here converts the node's
``unmeasured`` into a zero, invents a percentage for a volume whose usage could not
be read, or reports "gap-free" for a recorder that is not recording. The roll-up
rules live in ``rollup.py``, which is pure so those cases can be tested.

THE DRILL-DOWN IS THE POINT. A count says something is wrong; the isolate trace
says WHERE — camera, network, or the recorder — with the evidence the recorder
measured, including when the recorder itself is cleared.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission

from app.db import get_db
from app.vms.federation import client as fed
from app.vms.federation._common import (
    PERM_READ,
    _online_nodes,
    _resolve_node,
    _unreachable,
    log,
)

from . import rollup

router = APIRouter(prefix="/vms/pulse", tags=["VMS Pulse"])


async def _board(node) -> tuple[object, dict | None, str | None]:
    """One recorder's board, or the reason it could not be read.

    Never raises: a recorder rebooting must degrade the estate view to "3 of 4
    answered", never empty it. Same discipline as the federated camera list.
    """
    try:
        return node, await fed.get_node_sysmon(node.api_url, credential=node.credential), None
    except fed.NodeUnavailable as e:
        log.warning("pulse: node %s unreachable: %s", node.name, e)
        return node, None, str(e)


@router.get("/overview", dependencies=[Depends(require_permission(PERM_READ))])
async def pulse_overview(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """The estate's operational health: recorders, cameras, recording, storage.

    Fans out to every enrolled recorder CONCURRENTLY — sequentially, one node
    timing out would delay the whole page by its timeout, and the page an operator
    opens when something is wrong is exactly the page a sick recorder appears on.
    """
    nodes = await _online_nodes(db, scope)
    results = await asyncio.gather(*(_board(n) for n in nodes)) if nodes else []

    node_views: list[dict] = []
    unreachable: list[dict] = []
    offline: list[dict] = []
    for node, board, error in results:
        if board is None:
            unreachable.append({"node_id": str(node.id), "name": node.name, "error": error})
            continue
        node_views.append(rollup.node_view(str(node.id), node.name, board))
        offline.extend(rollup.offline_cameras(str(node.id), node.name, board))

    out = rollup.overview(node_views, unreachable, offline)
    out["generated_at"] = datetime.now(timezone.utc).isoformat()
    return out


@router.get("/nodes/{node_id}/sysmon", dependencies=[Depends(require_permission(PERM_READ))])
async def node_sysmon(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """One recorder's whole System-Monitor board, as the recorder reports it.

    Passed through rather than reshaped: this is the recorder's own screen, and a
    field this service has never heard of is still a field an operator needs to
    see. Unreachable → 502, the same answer every other federated read gives when
    the VMS is fine and the upstream recorder is not.
    """
    node = await _resolve_node(db, scope, node_id)
    try:
        board = await fed.get_node_sysmon(node.api_url, credential=node.credential)
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    board["node_id"] = str(node.id)
    board["node_name"] = node.name
    return board


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/isolate",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def isolate_camera(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    profile: Annotated[Optional[str], Query(max_length=64)] = None,
) -> dict:
    """The fault trace for one camera: camera → network → ingest → decode → storage
    → display, with the recorder's own evidence and verdict.

    The recorder answers this because it is the only party that can: it holds the
    stream, the segment index and the disk. The VMS relays it so an operator can
    ask from the estate view they are already standing in.
    """
    node = await _resolve_node(db, scope, node_id)
    try:
        trace = await fed.isolate_node_camera(
            node.api_url, camera_id, profile=profile, credential=node.credential
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
    trace["node_id"] = str(node.id)
    trace["node_name"] = node.name
    return trace
