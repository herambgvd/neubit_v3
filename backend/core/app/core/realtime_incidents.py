"""Tenant-scoped SSE realtime bridge — live incident updates for the operator UI.

The workflow service turns domain events into incidents and publishes them on the
NATS spine (``tenant.<id>.workflow.incident.created`` / ``.trigger.fired``). This
module bridges those events to the browser over Server-Sent Events so the operator
UI gets live updates instead of polling every 10s.

    GET /api/v1/realtime/incidents        (text/event-stream)

Auth: the same short-lived HS256 access token the REST API uses. Browsers can't set
headers on ``EventSource``, so we accept the token as ``?token=<jwt>`` first and fall
back to ``Authorization: Bearer <jwt>`` (native clients / proxies). Invalid/missing →
401. The caller's ``tenant_id`` is read from the token and used to scope the NATS
subscription: ``tenant.<tenant_id>.workflow.>`` — a tenant only ever sees its own
incidents. Super-admins (no tenant) subscribe to ``tenant.*.workflow.>`` (all tenants).

Delivery model: one EPHEMERAL, non-durable core NATS subscription PER open stream
(via ``events_nats.ephemeral_subscribe``), torn down on client disconnect. Live,
at-most-once — no history/replay, which is exactly what a live feed wants.

Client (matches v2's ``use-incident-stream`` hook):

    const es = new EventSource(`/api/v1/realtime/incidents?token=${accessToken}`)
    es.addEventListener("incident.created", (e) => refetch(JSON.parse(e.data)))
    es.addEventListener("trigger.fired",  (e) => ...)
"""

from __future__ import annotations

import asyncio
import json

import jwt
from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..auth.security import decode_token
from .logging import get_logger

log = get_logger("edge.realtime.incidents")

realtime_incidents_router = APIRouter(prefix="/realtime", tags=["realtime"])

# How often to emit an SSE keepalive comment so idle connections survive proxy /
# Traefik / load-balancer idle timeouts (typically 30-60s).
KEEPALIVE_SECONDS = 20.0

# Envelope ``type`` (``<domain>.<event>``) → SSE ``event:`` name the UI listens on.
_EVENT_NAMES = {
    "workflow.incident.created": "incident.created",
    "workflow.trigger.fired": "trigger.fired",
}


def _extract_token(request: Request, token_qs: str | None) -> str | None:
    """Pull the access token: ``?token=`` first (browser EventSource), then Bearer."""
    if token_qs:
        return token_qs
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def _principal_or_401(request: Request, token_qs: str | None) -> dict:
    """Validate the access token (HS256, shared secret) → claims. Raise 401 otherwise.

    Uses core's ``decode_token`` (same HS256 ``jwt_secret`` the satellite services'
    ``kernel.verify_token`` uses — core is the token issuer, so it validates locally).
    """
    # 401 envelope matching the platform's error shape.
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


def _compact(envelope: dict) -> dict:
    """Map a NATS envelope → the compact JSON the UI needs.

    Envelope: {event_id, tenant_id, type, occurred_at, source, payload}. The
    incident fields live in ``payload`` (see workflow correlation._fire).
    """
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    return {
        "instance_id": payload.get("instance_id"),
        "sop_id": payload.get("sop_id"),
        "sop_name": payload.get("sop_name"),
        "priority": payload.get("priority"),
        "site_id": payload.get("site_id"),
        "trigger_id": payload.get("trigger_id"),
        "matched_event_type": payload.get("matched_event_type"),
        "tenant_id": envelope.get("tenant_id") or payload.get("tenant_id"),
        "occurred_at": envelope.get("occurred_at"),
        "event_id": envelope.get("event_id"),
    }


@realtime_incidents_router.get("/incidents")
async def incidents_stream(
    request: Request,
    token: str | None = Query(None, description="access token (browser EventSource)"),
) -> StreamingResponse:
    """SSE stream of live workflow incidents for the caller's tenant.

    Emits ``event: incident.created`` / ``event: trigger.fired`` frames plus a
    periodic ``: keepalive`` comment. Subscribes to ``tenant.<id>.workflow.>`` on
    NATS (ephemeral, non-durable) and cleans the subscription up on disconnect.
    """
    claims = _principal_or_401(request, token)
    tenant_id = claims.get("tenant_id")
    is_superadmin = bool(claims.get("is_superadmin", False))

    # Tenant scope: a tenant sees only its own workflow events; a platform
    # super-admin (no tenant) may watch every tenant's incidents.
    if tenant_id:
        pattern = f"tenant.{tenant_id}.workflow.>"
    elif is_superadmin:
        pattern = "tenant.*.workflow.>"
    else:
        # A non-super-admin token with no tenant has nothing to watch → nothing scoped.
        pattern = "tenant.__none__.workflow.>"

    async def event_stream():
        from . import events_nats

        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)

        async def _on_event(envelope: dict) -> None:
            event_type = envelope.get("type") or ""
            name = _EVENT_NAMES.get(str(event_type))
            if name is None:
                return  # not an event the UI cares about
            try:
                queue.put_nowait((name, _compact(envelope)))
            except asyncio.QueueFull:
                log.warning("SSE incident queue full (tenant=%s) — dropping frame", tenant_id)

        sub = await events_nats.ephemeral_subscribe(pattern, _on_event)
        if sub is None:
            log.info("SSE incidents: NATS unavailable — stream open, keepalive only")

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
            log.debug("SSE incidents stream closed (tenant=%s)", tenant_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
