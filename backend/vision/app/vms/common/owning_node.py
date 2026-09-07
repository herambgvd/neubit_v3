"""Which RECORDER owns a camera the VMS has no row for.

Under single ownership the recorders own the cameras: there are no ``Camera`` rows
for them here. A federated screen therefore addresses a camera by the id it has ON
its recorder, and any VMS endpoint handed one of those has to answer the question
this module exists for — WHICH recorder is that?

Screens that already know say so (``/vms/federation/nodes/{node}/…`` carries the
node). The ones that cannot are the reason this is here: an alarm popup and a video
wall cell each hold a camera id and nothing else, because an incident carries a
camera and a wall cell stores a camera. Making them carry a node id would mean
persisting a placement decision inside every popup and every saved wall layout, and
re-saving them all whenever a camera moves recorder.

So the lookup happens once, here, and is cached.

CACHE. Camera→node placement is stable in the way that matters: a camera moves
recorder on an operator action or a failover, not on its own. A miss is re-resolved
against every node, so a moved camera costs one wrong answer at most, and a wrong
answer is a 404 from a recorder that does not have it — not a stream from the wrong
camera. The TTL is short enough that a failover heals in a minute without anyone
doing anything.
"""

from __future__ import annotations

import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.vms.models import MediaNode

log = logging.getLogger("vision.owning_node")

_TTL_SEC = 60.0
# camera id → (node id, resolved_at). Process-local; a restart just re-resolves.
_CACHE: dict[str, tuple[str, float]] = {}


def _fresh(camera_id: str) -> str | None:
    hit = _CACHE.get(camera_id)
    if not hit:
        return None
    node_id, at = hit
    if time.monotonic() - at > _TTL_SEC:
        _CACHE.pop(camera_id, None)
        return None
    return node_id


def forget(camera_id: str) -> None:
    """Drop a cached placement — call it when a node says it does not have the camera."""
    _CACHE.pop(camera_id, None)


async def owning_node(db: AsyncSession, tenant_id, camera_id: str) -> MediaNode | None:
    """The recorder that hosts ``camera_id``, or ``None`` if no registered node does.

    Asks each reachable node for its camera list until one claims the id. Nodes are
    asked in registration order and the answer is cached, so the common case is one
    lookup per camera per minute regardless of how many recorders an estate has.

    NEVER raises: an unreachable node is skipped (another may own the camera), and
    all-nodes-unreachable answers ``None``, which the caller surfaces as "not found"
    rather than as a stack trace.
    """
    if not camera_id:
        return None

    cached = _fresh(camera_id)
    if cached:
        node = await db.get(MediaNode, cached)
        if node is not None and _usable(node, tenant_id):
            return node
        _CACHE.pop(camera_id, None)

    from app.vms.federation.client import NodeUnavailable, list_estate_cameras

    stmt = select(MediaNode)
    for node in (await db.execute(stmt)).scalars().all():
        if not _usable(node, tenant_id):
            continue
        try:
            cameras = await list_estate_cameras(node.api_url, node.credential)
        except NodeUnavailable as exc:
            # Skipped, not failed: another recorder may own this camera, and one box
            # rebooting must not make every camera on the estate unresolvable.
            log.info("owning-node lookup: node %s unreachable: %s", node.name, exc)
            continue
        for cam in cameras:
            cid = str(cam.get("id") or "")
            if cid:
                _CACHE[cid] = (node.id, time.monotonic())
        if _fresh(camera_id):
            return node
    return None


def _usable(node: MediaNode, tenant_id) -> bool:
    """A node this caller may route to: same tenant (or shared) and addressable."""
    node_tenant = getattr(node, "tenant_id", None)
    if node_tenant is not None and tenant_id is not None and node_tenant != tenant_id:
        return False
    return bool((getattr(node, "api_url", None) or "").strip())


__all__ = ["owning_node", "forget"]
