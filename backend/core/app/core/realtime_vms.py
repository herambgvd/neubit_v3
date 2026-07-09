"""Tenant-scoped SSE realtime bridge — live VMS camera-events + operator popups.

The VMS service (``vision``) turns each ONVIF/brand device notification into a
``VmsEvent`` row and publishes it on the NATS spine at
``tenant.<id>.vms.camera.<event_type>`` (see
``backend/vision/app/vms/common/events.py`` :func:`emit_camera_event`). The P5-B
linkage engine's ``popup`` action publishes ``tenant.<id>.vms.popup`` for the
operator UI (:func:`emit_popup`). This module bridges BOTH families to the browser
over Server-Sent Events so the VMS Events feed + operator-popup consumer get live
updates instead of polling.

    GET /api/v1/realtime/vms-events           (text/event-stream)

Auth: the same short-lived HS256 access token the REST API uses. Browsers can't set
headers on ``EventSource``, so we accept the token as ``?token=<jwt>`` first and fall
back to ``Authorization: Bearer <jwt>`` (native clients / proxies). Invalid/missing →
401. The caller's ``tenant_id`` is read from the token and used to scope the NATS
subscription: ``tenant.<tenant_id>.vms.>`` — a tenant only ever sees its own VMS
events. Super-admins (no tenant) subscribe to ``tenant.*.vms.>`` (all tenants).

An optional ``?camera_id=<id>`` narrows the stream server-side: only frames whose
payload ``camera_id`` matches are forwarded, so a client watching one camera isn't
pushed every VMS event in the tenant.

Delivery model: one EPHEMERAL, non-durable core NATS subscription PER open stream
(via ``events_nats.ephemeral_subscribe``), torn down on client disconnect. Live,
at-most-once — no history/replay, which is exactly what a live feed wants.

Two SSE event names are emitted so the client can route them:
  * ``vms.event`` — a camera device/system event (``tenant.*.vms.camera.*`` +
    ``tenant.*.vms.*.status``). The compact payload matches the Events feed.
  * ``vms.popup`` — a linkage ``popup`` action (``tenant.*.vms.popup``); the compact
    payload carries {camera_id, reason, event_id, event_type, severity}.

Client (matches the VMS ``use-vms-event-stream`` hook):

    const es = new EventSource(
      `/api/v1/realtime/vms-events?token=${accessToken}&camera_id=${id}`
    )
    es.addEventListener("vms.event", (e) => append(JSON.parse(e.data)))
    es.addEventListener("vms.popup", (e) => popup(JSON.parse(e.data)))
"""

from __future__ import annotations

import asyncio
import json

import jwt
from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..auth.security import decode_token
from .logging import get_logger

log = get_logger("edge.realtime.vms")

realtime_vms_router = APIRouter(prefix="/realtime", tags=["realtime"])

# How often to emit an SSE keepalive comment so idle connections survive proxy /
# Traefik / load-balancer idle timeouts (typically 30-60s).
KEEPALIVE_SECONDS = 20.0

# SSE ``event:`` names the UI listens on.
VMS_EVENT_NAME = "vms.event"
VMS_POPUP_NAME = "vms.popup"


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


def _compact_event(envelope: dict) -> dict:
    """Map a ``vms.camera.*`` / ``vms.*.status`` envelope → the compact JSON the feed needs.

    Envelope: {event_id, tenant_id, type, occurred_at, source, payload}. The VMS
    device-event fields live in ``payload`` (see vision events.normalize.event_payload):
    {event_id, camera_id, event_type, severity, source, title, occurred_at, raw, zone?}.
    We surface those plus the envelope ``type`` (``vms.camera.<event_type>``) so the feed
    can distinguish device events from status frames.
    """
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    return {
        "id": payload.get("event_id") or envelope.get("event_id"),
        "event_id": payload.get("event_id") or envelope.get("event_id"),
        "camera_id": payload.get("camera_id"),
        "event_type": payload.get("event_type"),
        "severity": payload.get("severity") or "info",
        "source": payload.get("source"),
        "title": payload.get("title"),
        "zone": payload.get("zone"),
        "raw": payload.get("raw") or {},
        "occurred_at": payload.get("occurred_at") or envelope.get("occurred_at"),
        "tenant_id": envelope.get("tenant_id") or payload.get("tenant_id"),
        "subject_type": envelope.get("type"),
        "acknowledged": False,
        "published": True,
    }


def _compact_popup(envelope: dict) -> dict:
    """Map a ``vms.popup`` envelope → the compact JSON the operator-popup consumer needs.

    Payload (see vision linkage.actions.action_popup):
    {camera_id, reason, event_id, event_type, severity}.
    """
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    return {
        "camera_id": payload.get("camera_id"),
        "reason": payload.get("reason"),
        "event_id": payload.get("event_id"),
        "event_type": payload.get("event_type"),
        "severity": payload.get("severity") or "warning",
        "occurred_at": payload.get("occurred_at") or envelope.get("occurred_at"),
        "tenant_id": envelope.get("tenant_id") or payload.get("tenant_id"),
    }


@realtime_vms_router.get("/vms-events")
async def vms_events_stream(
    request: Request,
    token: str | None = Query(None, description="access token (browser EventSource)"),
    camera_id: str | None = Query(None, description="only forward this camera's events"),
) -> StreamingResponse:
    """SSE stream of live VMS camera-events + operator popups for the caller's tenant.

    Emits ``event: vms.event`` frames for camera device/system events and
    ``event: vms.popup`` frames for linkage popups, plus a periodic ``: keepalive``
    comment. Subscribes to ``tenant.<id>.vms.>`` on NATS (ephemeral, non-durable) and
    cleans the subscription up on disconnect. When ``camera_id`` is given, only frames
    whose payload ``camera_id`` matches are forwarded (popups without a camera pass
    only when no ``camera_id`` filter is set).
    """
    claims = _principal_or_401(request, token)
    tenant_id = claims.get("tenant_id")
    is_superadmin = bool(claims.get("is_superadmin", False))

    # Tenant scope: a tenant sees only its own VMS events; a platform super-admin
    # (no tenant) may watch every tenant's events.
    if tenant_id:
        pattern = f"tenant.{tenant_id}.vms.>"
    elif is_superadmin:
        pattern = "tenant.*.vms.>"
    else:
        pattern = "tenant.__none__.vms.>"

    async def event_stream():
        from . import events_nats

        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)

        async def _on_event(envelope: dict) -> None:
            etype = str(envelope.get("type") or "")
            is_popup = etype == "vms.popup"
            data = _compact_popup(envelope) if is_popup else _compact_event(envelope)
            # Per-camera narrowing: drop frames for other cameras.
            if camera_id and data.get("camera_id") != camera_id:
                return
            frame = (VMS_POPUP_NAME, data) if is_popup else (VMS_EVENT_NAME, data)
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                log.warning("SSE vms queue full (tenant=%s) — dropping frame", tenant_id)

        sub = await events_nats.ephemeral_subscribe(pattern, _on_event)
        if sub is None:
            log.info("SSE vms: NATS unavailable — stream open, keepalive only")

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
            log.debug("SSE vms stream closed (tenant=%s)", tenant_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
