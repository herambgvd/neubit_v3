"""Tenant-scoped SSE realtime bridge — live access-control events for the operator UI.

The access service turns each controller event into an ``AccessEvent`` row and
publishes it on the NATS spine at
``tenant.<id>.access.<category>.<event_type>`` (see
``backend/access/app/access/ingestion.py`` + ``events.py``). This module bridges
those events to the browser over Server-Sent Events so the access EventsFeed gets
live updates instead of polling every 5s.

    GET /api/v1/realtime/access-events        (text/event-stream)

Auth: the same short-lived HS256 access token the REST API uses. Browsers can't set
headers on ``EventSource``, so we accept the token as ``?token=<jwt>`` first and fall
back to ``Authorization: Bearer <jwt>`` (native clients / proxies). Invalid/missing →
401. The caller's ``tenant_id`` is read from the token and used to scope the NATS
subscription: ``tenant.<tenant_id>.access.>`` — a tenant only ever sees its own
access events. Super-admins (no tenant) subscribe to ``tenant.*.access.>`` (all
tenants).

Since the EventsFeed is per-instance, an optional ``?instance_id=<id>`` narrows the
stream server-side: only frames whose payload ``instance_id`` matches are forwarded,
so a client watching one instance isn't pushed every access event in the tenant.

Delivery model: one EPHEMERAL, non-durable core NATS subscription PER open stream
(via ``events_nats.ephemeral_subscribe``), torn down on client disconnect. Live,
at-most-once — no history/replay, which is exactly what a live feed wants.

Client (matches the access ``use-access-event-stream`` hook):

    const es = new EventSource(
      `/api/v1/realtime/access-events?token=${accessToken}&instance_id=${id}`
    )
    es.addEventListener("access.event", (e) => append(JSON.parse(e.data)))
"""

from __future__ import annotations

import asyncio
import json

import jwt
from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..auth.security import decode_token
from .logging import get_logger

log = get_logger("edge.realtime.access")

realtime_access_router = APIRouter(prefix="/realtime", tags=["realtime"])

# How often to emit an SSE keepalive comment so idle connections survive proxy /
# Traefik / load-balancer idle timeouts (typically 30-60s).
KEEPALIVE_SECONDS = 20.0

# SSE ``event:`` name the UI listens on for every access frame.
ACCESS_EVENT_NAME = "access.event"


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
    """Map a NATS envelope → the compact JSON the EventsFeed needs.

    Envelope: {event_id, tenant_id, type, occurred_at, source, payload}. The
    access-event fields live in ``payload`` (see access ingestion._handle_event):
    {instance_id, event_id, category, type, result, remote_uid, door_ref,
    cardholder_ref, site_id, occurred_at, raw}. We surface both the snake_case
    ``door_ref``/``cardholder_ref`` the row carries and ``raw`` so the feed's
    renderers (which key off ``raw_payload``/``timestamp``/``event_id``) work.
    """
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    return {
        "event_id": payload.get("event_id") or envelope.get("event_id"),
        "instance_id": payload.get("instance_id"),
        "category": payload.get("category"),
        "event_type": payload.get("type"),
        "result": payload.get("result"),
        "remote_uid": payload.get("remote_uid"),
        "door_ref": payload.get("door_ref"),
        "cardholder_ref": payload.get("cardholder_ref"),
        "site_id": payload.get("site_id"),
        "raw": payload.get("raw") or {},
        "occurred_at": payload.get("occurred_at") or envelope.get("occurred_at"),
        "tenant_id": envelope.get("tenant_id") or payload.get("tenant_id"),
    }


@realtime_access_router.get("/access-events")
async def access_events_stream(
    request: Request,
    token: str | None = Query(None, description="access token (browser EventSource)"),
    instance_id: str | None = Query(None, description="only forward this instance's events"),
) -> StreamingResponse:
    """SSE stream of live access-control events for the caller's tenant.

    Emits ``event: access.event`` frames plus a periodic ``: keepalive`` comment.
    Subscribes to ``tenant.<id>.access.>`` on NATS (ephemeral, non-durable) and
    cleans the subscription up on disconnect. When ``instance_id`` is given, only
    frames whose payload ``instance_id`` matches are forwarded.
    """
    claims = _principal_or_401(request, token)
    tenant_id = claims.get("tenant_id")
    is_superadmin = bool(claims.get("is_superadmin", False))

    # Tenant scope: a tenant sees only its own access events; a platform
    # super-admin (no tenant) may watch every tenant's events.
    if tenant_id:
        pattern = f"tenant.{tenant_id}.access.>"
    elif is_superadmin:
        pattern = "tenant.*.access.>"
    else:
        # A non-super-admin token with no tenant has nothing to watch → nothing scoped.
        pattern = "tenant.__none__.access.>"

    async def event_stream():
        from . import events_nats

        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)

        async def _on_event(envelope: dict) -> None:
            data = _compact(envelope)
            # Per-instance narrowing: drop frames for other instances.
            if instance_id and data.get("instance_id") != instance_id:
                return
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                log.warning("SSE access queue full (tenant=%s) — dropping frame", tenant_id)

        sub = await events_nats.ephemeral_subscribe(pattern, _on_event)
        if sub is None:
            log.info("SSE access: NATS unavailable — stream open, keepalive only")

        # Prime the connection so the client's onopen fires and proxies flush.
        yield ": connected\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                    yield f"event: {ACCESS_EVENT_NAME}\ndata: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if sub is not None:
                try:
                    await sub.unsubscribe()
                except Exception:  # noqa: BLE001 — best-effort cleanup
                    pass
            log.debug("SSE access stream closed (tenant=%s)", tenant_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
