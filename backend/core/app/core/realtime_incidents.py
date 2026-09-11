"""Tenant-scoped SSE realtime bridge — live incident updates for the operator UI.

The workflow service turns domain events into incidents and publishes them on the
NATS spine (``tenant.<id>.workflow.incident.created`` / ``.trigger.fired``). This
module bridges those events to the browser over Server-Sent Events so the operator
UI gets live updates instead of polling every 10s.

    GET /api/v1/realtime/incidents        (text/event-stream)

Auth: the same short-lived HS256 access token the REST API uses, as ``?token=<jwt>``
(``EventSource`` cannot set headers) or an ``Authorization: Bearer`` fallback. The
token's ``tenant_id`` scopes the subscription to ``tenant.<id>.workflow.>``;
super-admins (no tenant) get ``tenant.*.workflow.>``.

Delivery: one ephemeral, non-durable NATS subscription per open stream, torn down on
disconnect. Live and at-most-once — no history or replay.

Client (matches v2's ``use-incident-stream`` hook):

    const es = new EventSource(`/api/v1/realtime/incidents?token=${accessToken}`)
    es.addEventListener("incident.created", (e) => refetch(JSON.parse(e.data)))
    es.addEventListener("trigger.fired",  (e) => ...)
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from .logging import get_logger
from .shutdown import SSE_SHUTDOWN_FRAME, next_sse_frame
from ..auth.permissions import CorePerm
from .sse_auth import StreamGuard, authorize_stream, principal_or_401

log = get_logger("edge.realtime.incidents")

realtime_incidents_router = APIRouter(prefix="/realtime", tags=["realtime"])

# Keepalive cadence, so idle connections survive proxy idle timeouts (30-60s).
KEEPALIVE_SECONDS = 20.0

# Envelope ``type`` (``<domain>.<event>``) → SSE ``event:`` name the UI listens on.
_EVENT_NAMES = {
    "workflow.incident.created": "incident.created",
    "workflow.trigger.fired": "trigger.fired",
}


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
    claims = principal_or_401(request, token)
    # Authentication is not authorization: incidents are permission-gated on the
    # REST side, so the stream must be gated too.
    # authorize_stream re-reads the user and tenant from the database rather than
    # trusting the token's claims: a stream outlives a suspension.
    await authorize_stream(claims, CorePerm.WORKFLOW_INSTANCE_READ)
    # …and again while the stream is open, or a revoked permission would keep
    # this feed alive until the token expired.
    guard = StreamGuard(claims, CorePerm.WORKFLOW_INSTANCE_READ)
    tenant_id = claims.get("tenant_id")
    is_superadmin = bool(claims.get("is_superadmin", False))

    # A tenant sees only its own events; a super-admin (no tenant) sees every one.
    if tenant_id:
        pattern = f"tenant.{tenant_id}.workflow.>"
    elif is_superadmin:
        pattern = "tenant.*.workflow.>"
    else:
        # A non-super-admin token with no tenant has nothing to watch.
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
