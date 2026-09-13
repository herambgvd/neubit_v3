"""Tenant-scoped SSE realtime bridge — live Video-Wall shared state (VW-A).

The vision service holds each wall's live state (which camera is in which cell) and
publishes the new FULL state on every mutation at
``tenant.<id>.vms.wall.<wall_id>.state``. This module bridges it to the browser over
Server-Sent Events, so each operator console and display-client just replaces its
local state with the broadcast one.

    GET /api/v1/realtime/wall-events                 (text/event-stream)

Auth mirrors ``realtime_vms.py``: the access token as ``?token=<jwt>`` or an
``Authorization: Bearer`` fallback, with ``tenant_id`` scoping the subscription to
``tenant.<id>.vms.wall.>``; super-admins get ``tenant.*.vms.wall.>``.

``?wall_id=<id>`` narrows the stream to one wall, which is all a display-client wants.

Delivery: one ephemeral, non-durable NATS subscription per open stream, torn down on
disconnect. At-most-once, which suits a "latest wall state wins" model.

One SSE event name is emitted:
  * ``wall.state`` — the new full wall state; payload
    ``{wall_id, state, rows?, cols?, action?, actor_id?, tenant_id}``.

Client (mirror of the VMS ``use-vms-event-stream`` hook — VW-D builds it):

    const es = new EventSource(
      `/api/v1/realtime/wall-events?token=${accessToken}&wall_id=${id}`
    )
    es.addEventListener("wall.state", (e) => replaceWall(JSON.parse(e.data)))
"""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

import jwt
from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..auth.security import decode_token
from .logging import get_logger
from .shutdown import SSE_SHUTDOWN_FRAME, next_sse_frame
from ..auth.permissions import CorePerm
from .sse_auth import StreamGuard, authorize_stream

log = get_logger("edge.realtime.wall")

realtime_wall_router = APIRouter(prefix="/realtime", tags=["realtime"])

# Keepalive cadence, so idle connections survive proxy idle timeouts.
KEEPALIVE_SECONDS = 20.0

# SSE ``event:`` name the wall UI listens on.
WALL_STATE_NAME = "wall.state"


def _extract_token(request: Request, token_qs: str | None) -> str | None:
    """Pull the access token: ``?token=`` first (browser EventSource), then Bearer."""
    if token_qs:
        return token_qs
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def _principal_or_401(request: Request, token_qs: str | None) -> dict:
    """Validate the access token (HS256, shared secret) → claims. Raise 401 otherwise."""
    from fastapi import HTTPException, status

    token = _extract_token(request, token_qs)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "SSE auth required"},
        )
    try:
        claims = decode_token(token)  # verifies signature + expiry
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "invalid or expired token"},
        )
    if claims.get("type") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "not an access token"},
        )
    if not claims.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "token missing subject"},
        )
    return claims


def _compact_wall(envelope: dict) -> dict:
    """Map a ``vms.wall.<id>.state`` envelope → the compact JSON the wall UI needs.

    Envelope: {event_id, tenant_id, type, occurred_at, source, payload}. The wall fields
    live in ``payload`` (see vision events.emit_wall_state): {wall_id, state, rows, cols,
    action, actor_id}.
    """
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    return {
        "wall_id": payload.get("wall_id"),
        "state": payload.get("state") or {},
        "rows": payload.get("rows"),
        "cols": payload.get("cols"),
        "action": payload.get("action"),
        "actor_id": payload.get("actor_id"),
        "occurred_at": envelope.get("occurred_at"),
        "tenant_id": envelope.get("tenant_id") or payload.get("tenant_id"),
    }


@realtime_wall_router.get("/wall-events")
async def wall_events_stream(
    request: Request,
    token: Annotated[str | None, Query(description="access token (browser EventSource)")] = None,
    wall_id: Annotated[
        str | None, Query(description="only forward this wall's state frames")
    ] = None,
) -> StreamingResponse:
    """SSE stream of live Video-Wall shared-state updates for the caller's tenant.

    Emits ``event: wall.state`` frames (new full wall state) plus a periodic ``: keepalive``
    comment. Subscribes to ``tenant.<id>.vms.wall.>`` on NATS (ephemeral, non-durable) and
    cleans up on disconnect. When ``wall_id`` is given, only that wall's frames pass.
    """
    claims = _principal_or_401(request, token)
    # Authentication is not authorization: wall state is permission-gated on the
    # REST side, so the stream must be gated too.
    # authorize_stream re-reads the user and tenant from the database rather than
    # trusting the token's claims: a stream outlives a suspension.
    await authorize_stream(claims, CorePerm.VMS_WALL_VIEW)
    # …and again while the stream is open, or a revoked permission would keep
    # this feed alive until the token expired.
    guard = StreamGuard(claims, CorePerm.VMS_WALL_VIEW)
    tenant_id = claims.get("tenant_id")
    is_superadmin = bool(claims.get("is_superadmin", False))

    if tenant_id:
        pattern = f"tenant.{tenant_id}.vms.wall.>"
    elif is_superadmin:
        pattern = "tenant.*.vms.wall.>"
    else:
        pattern = "tenant.__none__.vms.wall.>"

    async def event_stream():
        from . import events_nats

        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)

        async def _on_event(envelope: dict) -> None:
            data = _compact_wall(envelope)
            # Drop frames for other walls.
            if wall_id and data.get("wall_id") != wall_id:
                return
            try:
                queue.put_nowait((WALL_STATE_NAME, data))
            except asyncio.QueueFull:
                log.warning("SSE wall queue full (tenant=%s) — dropping frame", tenant_id)

        sub = await events_nats.ephemeral_subscribe(pattern, _on_event)
        if sub is None:
            log.info("SSE wall: NATS unavailable — stream open, keepalive only")

        # Prime the connection so onopen fires and proxies flush.
        yield ": connected\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                kind, item = await next_sse_frame(queue, KEEPALIVE_SECONDS)
                if kind == "shutdown":
                    # Going down: end the response instead of looping, or the
                    # open stream wedges the shutdown. EventSource reconnects.
                    yield SSE_SHUTDOWN_FRAME
                    break
                if kind == "keepalive":
                    if not await guard.still_allowed():
                        # The 200 went out when the stream opened, so ending the
                        # body is the only way left to refuse. EventSource
                        # reconnects and gets a clean 401/403 then.
                        yield "event: revoked\ndata: {}\n\n"
                        break
                    yield ": keepalive\n\n"
                    continue
                name, data = item
                yield f"event: {name}\ndata: {json.dumps(data)}\n\n"
        finally:
            if sub is not None:
                try:
                    await sub.unsubscribe()
                except Exception:  # noqa: BLE001 — best-effort cleanup
                    pass
            log.debug("SSE wall stream closed (tenant=%s)", tenant_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
