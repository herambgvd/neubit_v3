"""Tenant-scoped SSE realtime bridge — live Video-Wall shared state (VW-A).

The VMS service (``vision``) keeps each video wall's LIVE state (which camera shows in
which monitor cell) server-side and, on EVERY mutation (push a camera to a cell, clear,
apply/save a preset, start/stop a tour), publishes the NEW FULL wall state on the NATS
spine at ``tenant.<id>.vms.wall.<wall_id>.state`` (see
``backend/vision/app/vms/common/events.py`` :func:`emit_wall_state`). This module bridges
that family to the browser over Server-Sent Events so every operator console + every
display-client (the physical control-room screens) stays in lock-step WITHOUT polling —
each just REPLACES its local wall state with the broadcast ``state``.

    GET /api/v1/realtime/wall-events                 (text/event-stream)

Auth mirrors ``realtime_vms.py``: the same short-lived HS256 access token the REST API
uses, accepted as ``?token=<jwt>`` (browser ``EventSource`` can't set headers) with a
``Authorization: Bearer`` fallback. Invalid/missing → 401. The caller's ``tenant_id``
scopes the NATS subscription ``tenant.<id>.vms.wall.>`` — a tenant only ever sees its own
walls. Super-admins (no tenant) subscribe to ``tenant.*.vms.wall.>``.

An optional ``?wall_id=<id>`` narrows the stream server-side to one wall (a display-client
only cares about its own wall).

Delivery: one EPHEMERAL, non-durable core NATS subscription PER open stream (via
``events_nats.ephemeral_subscribe``), torn down on client disconnect. Live, at-most-once —
which is exactly right for a "latest wall state wins" model.

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

import jwt
from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..auth.security import decode_token
from .logging import get_logger

log = get_logger("edge.realtime.wall")

realtime_wall_router = APIRouter(prefix="/realtime", tags=["realtime"])

# Keepalive cadence so idle connections survive proxy / Traefik idle timeouts.
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
    token: str | None = Query(None, description="access token (browser EventSource)"),
    wall_id: str | None = Query(None, description="only forward this wall's state frames"),
) -> StreamingResponse:
    """SSE stream of live Video-Wall shared-state updates for the caller's tenant.

    Emits ``event: wall.state`` frames (new full wall state) plus a periodic ``: keepalive``
    comment. Subscribes to ``tenant.<id>.vms.wall.>`` on NATS (ephemeral, non-durable) and
    cleans up on disconnect. When ``wall_id`` is given, only that wall's frames pass.
    """
    claims = _principal_or_401(request, token)
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
            # Per-wall narrowing: drop frames for other walls.
            if wall_id and data.get("wall_id") != wall_id:
                return
            try:
                queue.put_nowait((WALL_STATE_NAME, data))
            except asyncio.QueueFull:
                log.warning("SSE wall queue full (tenant=%s) — dropping frame", tenant_id)

        sub = await events_nats.ephemeral_subscribe(pattern, _on_event)
        if sub is None:
            log.info("SSE wall: NATS unavailable — stream open, keepalive only")

        # Prime the connection so the client's onopen fires and proxies flush.
        yield ": connected\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    name, data = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                    yield f"event: {name}\ndata: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
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
