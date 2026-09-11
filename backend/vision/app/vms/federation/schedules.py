"""Federation — recording schedules, the one piece of config authorship the VMS holds.

Everything else on this surface is read or operate: the recorder owns its cameras and
its disks, and a central VMS that could rewrite them would have stopped aggregating
recorders and started being one. Schedules are the deliberate exception, and the
reason is the operator's week rather than the architecture's neatness — "record this
camera 09:00-18:00 on weekdays" is a decision made from the console somebody is
already sitting at, and sending them to each recorder's own screen to make it is the
tax this federation exists to remove.

TWO SHAPES, because the recorder has two.

  * THE LIBRARY — named templates ("24/7", "Business hours", "Overnight motion"),
    and an apply-to-many that copies one onto a list of cameras. Applying COPIES:
    editing a template afterwards does not reach back into cameras an earlier apply
    set. The recorder says so and this does not pretend otherwise.
  * ONE CAMERA'S OWN CONFIG — read it, or write it directly when no template fits.

WHAT A WRITE HERE CAN REACH, said out loud. The node gates both writes on
``vms.recording.configure``, and the per-camera PUT carries retention_days as well as
schedule. So this surface can shorten how long footage survives. Partial writes are
the mitigation that matters: the PUT patches only the fields it is given, so a
schedule edit sent from the console cannot take retention with it by accident.

A NODE ENROLLED BEFORE THE GRANT WIDENED REFUSES EVERY WRITE. That is a 502 carrying
the recorder's own sentence, which names the missing permission and says to re-enrol —
not a 503, because nothing about it will be different on the next try.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, get_scope, require_permission

from app.db import get_db
from app.vms.federation import client as fed
from app.vms.federation._common import (
    _via,
    PERM_READ,
    _resolve_node,
    _tag,
    _unreachable,
)

router = APIRouter()

# Reads ride the camera-read right every federated read uses. Writes gate on
# vms.config.manage — the VMS-side authorship right its own config screens already
# use (patterns, storage) — so a role that may not author config cannot author it
# on a recorder either. The node separately enforces its credential's grants; both
# have to say yes.
PERM_SCHEDULE_WRITE = "vms.config.manage"


@router.get(
    "/nodes/{node_id}/recording-schedule-templates",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_schedule_templates(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """This recorder's named schedule library."""
    return await _via(db, scope, node_id, lambda n: fed.list_schedule_templates(n.api_url, credential=n.credential))


@router.post(
    "/nodes/{node_id}/recording-schedule-templates",
    dependencies=[Depends(require_permission(PERM_SCHEDULE_WRITE))],
)
async def create_schedule_template(
    node_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict[str, Any], Body()],
) -> dict:
    """Add a named schedule to this recorder's library."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(
            node, await fed.create_schedule_template(node.api_url, body, credential=node.credential)
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.put(
    "/nodes/{node_id}/recording-schedule-templates/{template_id}",
    dependencies=[Depends(require_permission(PERM_SCHEDULE_WRITE))],
)
async def update_schedule_template(
    node_id: str,
    template_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict[str, Any], Body()],
) -> dict:
    """Retune a template. Cameras an earlier apply touched keep their own copy —
    this does not reach back into them, and the console must not imply it does."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(
            node,
            await fed.update_schedule_template(
                node.api_url, template_id, body, credential=node.credential
            ),
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.delete(
    "/nodes/{node_id}/recording-schedule-templates/{template_id}",
    dependencies=[Depends(require_permission(PERM_SCHEDULE_WRITE))],
)
async def delete_schedule_template(
    node_id: str,
    template_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """Remove a template from the library. No camera loses its schedule."""
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(
            node,
            await fed.delete_schedule_template(node.api_url, template_id, credential=node.credential),
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.post(
    "/nodes/{node_id}/recording-schedule-templates/{template_id}/apply",
    dependencies=[Depends(require_permission(PERM_SCHEDULE_WRITE))],
)
async def apply_schedule_template(
    node_id: str,
    template_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict[str, Any], Body()],
) -> dict:
    """Push one template onto many cameras.

    The node answers per camera (applied | skipped | failed) and the counts are
    passed through untouched: a fan-out an operator cannot watch is one they have
    to be able to read afterwards.
    """
    node = await _resolve_node(db, scope, node_id)
    camera_ids = [str(c) for c in (body.get("camera_ids") or [])]
    try:
        return _tag(
            node,
            await fed.apply_schedule_template(
                node.api_url, template_id, camera_ids, credential=node.credential
            ),
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.get(
    "/nodes/{node_id}/cameras/{camera_id}/recording-config",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_camera_recording(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> dict:
    """One camera's recording config as its recorder holds it.

    Named `recording-config` and not `recording`, which the evidence module already
    owns as `/recording/start|stop`. A literal segment and a start/stop pair under
    one name would read as the same resource and are not.
    """
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(
            node, await fed.get_camera_recording(node.api_url, camera_id, credential=node.credential)
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)


@router.put(
    "/nodes/{node_id}/cameras/{camera_id}/recording-config",
    dependencies=[Depends(require_permission(PERM_SCHEDULE_WRITE))],
)
async def put_camera_recording(
    node_id: str,
    camera_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    body: Annotated[dict[str, Any], Body()],
) -> dict:
    """Write one camera's recording config.

    PARTIAL on purpose, and the body is forwarded as given: the node patches only
    the fields it receives, so a console sending {"schedule": …} cannot reset
    retention_days to a default it never asked about. Sending the whole object back
    would turn every schedule edit into a rewrite of how long footage survives.
    """
    node = await _resolve_node(db, scope, node_id)
    try:
        return _tag(
            node,
            await fed.put_camera_recording(
                node.api_url, camera_id, body, credential=node.credential
            ),
        )
    except fed.NodeUnavailable as e:
        raise _unreachable(e)
