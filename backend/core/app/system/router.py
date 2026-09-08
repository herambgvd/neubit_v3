"""System monitoring API — one-shot snapshot + a live WebSocket stream.

  GET  /api/system/resources          → a single sample_resources() snapshot.
  WS   /api/system/resources/stream   → pushes a fresh snapshot every 2 seconds
                                        until the client disconnects.

The dashboard uses the REST endpoint for an initial paint and the WebSocket for
a live, ticking view (CPU/RAM/GPU gauges).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from ..auth.deps import require_permission
from ..auth.permissions import CorePerm
from ..core.logging import get_logger
from ..core.ws_auth import authorize_ws
from .resources import sample_resources

log = get_logger("edge.system")

system_router = APIRouter(prefix="/system", tags=["system"])


@system_router.get("/resources")
async def get_resources(_user=Depends(require_permission(CorePerm.SYSTEM_READ))) -> dict:
    """Return a single point-in-time resource snapshot. Requires ``system.read``."""
    return sample_resources()


@system_router.get("/health")
async def get_health(_user=Depends(require_permission(CorePerm.SYSTEM_READ))) -> dict:
    """Authenticated dependency health (DB / Redis / storage) for the admin status
    page. Same probes as the public ``/readyz``, but gated by ``system.read``."""
    from ..core.health import run_checks

    healthy, checks = await run_checks()
    return {"status": "healthy" if healthy else "degraded", "checks": checks}


@system_router.websocket("/resources/stream")
async def stream_resources(websocket: WebSocket) -> None:
    """Push a resource snapshot every 2 seconds over a WebSocket.

    HTTP dependencies do not run on WS handshakes, so this authorizes by hand: the
    client passes its access token as ``?token=<access>`` (see edge.core.ws_auth)
    and ``authorize_ws`` enforces ``CorePerm.SYSTEM_READ``, closing the socket
    (4401/4403) and returning None on failure.

    Authorize before ``accept()`` so an unauthorized client never gets an open
    socket — Starlette supports ``close()`` on an un-accepted handshake.
    """
    user = await authorize_ws(websocket, CorePerm.SYSTEM_READ)
    if user is None:
        return  # authorize_ws already closed the socket (4401/4403)
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(sample_resources())
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        # Normal client hang-up; nothing to clean up.
        log.debug("system resource stream disconnected")


# --- the estate ---------------------------------------------------------------
# The health page used to show three dependency probes and the host's CPU/RAM.
# That answers "can core reach its database", not "which services are running and
# what are they saying" — which is what an operator opens a health page for. The
# inventory comes from the ops-agent sidecar (the only component that holds the
# docker socket); core forwards, exactly as /admin/infra does for super-admins.
#
# Read-only here, deliberately. Lifecycle (restart/stop/start) stays on the
# super-admin infra API, which audits it.

#: The compose services this console reports on, in the order they are shown.
#: A container outside this list (a one-shot migration, a build helper) is not a
#: service an operator watches; the ops-agent's own project whitelist still
#: decides what exists at all.
_HIDDEN_SERVICES = {"db-init", "reporting-migrate"}


def _service_row(container: dict) -> dict:
    """One ops-agent container → the row this console shows.

    A projection, not a pass-through: the agent's payload carries the image tag
    and container id, which say nothing to an operator and would put the deployed
    image digest on a screen that a non-super-admin can open.
    """
    state = container.get("state") or "unknown"
    health = container.get("health")
    return {
        "name": container.get("service") or container.get("name"),
        "container": container.get("name"),
        "state": state,
        # None when the container declares no healthcheck — which is NOT the same
        # as unhealthy, and the UI must not paint it red.
        "health": health,
        "running": state == "running",
        "created_at": container.get("created_at"),
        "cpu_pct": container.get("cpu_pct"),
        "mem_used_mb": container.get("mem_used_mb"),
        "mem_limit_mb": container.get("mem_limit_mb"),
    }


@system_router.get("/services")
async def list_services(_user=Depends(require_permission(CorePerm.SYSTEM_READ))) -> list[dict]:
    """Every service in the deployment with its live state. Requires ``system.read``.

    503 when the ops-agent is unreachable (its client raises), so the page can say
    the inventory is unavailable instead of rendering an empty estate as "nothing
    is running".
    """
    from ..infra.client import OpsAgentClient

    containers = await OpsAgentClient().list_containers() or []
    rows = [_service_row(c) for c in containers]
    rows = [r for r in rows if r["name"] not in _HIDDEN_SERVICES]
    # Trouble first: an operator opening this page is looking for what is wrong.
    return sorted(rows, key=lambda r: (r["running"] and r["health"] != "unhealthy", r["name"] or ""))


@system_router.get("/services/{container}/logs")
async def service_logs(
    container: str,
    tail: int = Query(200, ge=1, le=2000),
    since: int = Query(0, ge=0),
    _user=Depends(require_permission(CorePerm.SYSTEM_LOGS)),
) -> dict:
    """Tail one service's logs. Requires ``system.logs`` — NOT ``system.read``.

    Addressed by CONTAINER name (the ``container`` field of a /services row), not
    by the compose service: resolving a service name here would mean listing the
    whole estate — and its per-container docker stats — on every poll of a live
    viewer.

    Seeing that a service is up and reading everything it prints are different
    grants: a log line carries request paths, identifiers and whatever a stack
    trace picked up on its way out.

    ``since`` (unix seconds) makes a following viewer cost only the new lines.
    """
    from ..infra.client import OpsAgentClient

    return await OpsAgentClient().logs(container, tail=tail, since=since) or {"lines": []}
