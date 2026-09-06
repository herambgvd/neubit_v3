"""System monitoring API — one-shot snapshot + a live WebSocket stream.

  GET  /api/system/resources          → a single sample_resources() snapshot.
  WS   /api/system/resources/stream   → pushes a fresh snapshot every 2 seconds
                                        until the client disconnects.

The dashboard uses the REST endpoint for an initial paint and the WebSocket for
a live, ticking view (CPU/RAM/GPU gauges).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

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
    page. Same probes as the public ``/ready``, but gated by ``system.read``."""
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
