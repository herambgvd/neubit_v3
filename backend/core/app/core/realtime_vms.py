"""Tenant-scoped SSE realtime bridge — live VMS camera-events + operator popups.

The vision service publishes each device notification at
``tenant.<id>.vms.camera.<event_type>`` and the linkage engine's ``popup`` action at
``tenant.<id>.vms.popup`` (see ``backend/vision/app/vms/common/events.py``). This
module bridges both families to the browser over Server-Sent Events.

    GET /api/v1/realtime/vms-events           (text/event-stream)

Auth: the same short-lived HS256 access token the REST API uses, as ``?token=<jwt>``
(``EventSource`` cannot set headers) or an ``Authorization: Bearer`` fallback. The
token's ``tenant_id`` scopes the subscription to ``tenant.<id>.vms.>``; super-admins
(no tenant) get ``tenant.*.vms.>``.

``?camera_id=<id>`` narrows the stream server-side, so a client watching one camera
is not pushed every VMS event in the tenant.

Delivery: one ephemeral, non-durable NATS subscription per open stream, torn down on
disconnect. Live and at-most-once — no history or replay.

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
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from .logging import get_logger
from .shutdown import SSE_SHUTDOWN_FRAME, next_sse_frame
from ..auth.permissions import CorePerm
from .sse_auth import StreamGuard, authorize_stream, principal_or_401

log = get_logger("edge.realtime.vms")

realtime_vms_router = APIRouter(prefix="/realtime", tags=["realtime"])

# Keepalive cadence, so idle connections survive proxy idle timeouts (30-60s).
KEEPALIVE_SECONDS = 20.0

# SSE ``event:`` names the UI listens on.
VMS_EVENT_NAME = "vms.event"
VMS_POPUP_NAME = "vms.popup"


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
    token: Annotated[str | None, Query(description="access token (browser EventSource)")] = None,
    camera_id: Annotated[
        str | None, Query(description="only forward this camera's events")
    ] = None,
) -> StreamingResponse:
    """SSE stream of live VMS camera-events + operator popups for the caller's tenant.

    Emits ``event: vms.event`` frames for camera device/system events and
    ``event: vms.popup`` frames for linkage popups, plus a periodic ``: keepalive``
    comment. Subscribes to ``tenant.<id>.vms.>`` on NATS (ephemeral, non-durable) and
    cleans the subscription up on disconnect. When ``camera_id`` is given, only frames
    whose payload ``camera_id`` matches are forwarded (popups without a camera pass
    only when no ``camera_id`` filter is set).
    """
    claims = principal_or_401(request, token)
    # Authentication is not authorization: these events are permission-gated on the
    # REST side, so the stream must be gated too.
    # authorize_stream re-reads the user and tenant from the database rather than
    # trusting the token's claims: a stream outlives a suspension.
    await authorize_stream(claims, CorePerm.VMS_CAMERA_READ)
    # …and again while the stream is open, or a revoked permission would keep
    # this feed alive until the token expired.
    guard = StreamGuard(claims, CorePerm.VMS_CAMERA_READ)
    tenant_id = claims.get("tenant_id")
    is_superadmin = bool(claims.get("is_superadmin", False))

    # A tenant sees only its own events; a super-admin (no tenant) sees every one.
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
            # Drop frames for other cameras.
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
