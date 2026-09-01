"""NATS + JetStream event bus client for the platform.

The event spine of the v3 architecture: services publish domain events and subscribe to
what they care about, with subjects namespaced `tenant.<id>.<domain>.<event>`. This module
is the thin, shared client — connect once at startup, publish/subscribe anywhere.

Kept dependency-light and optional: if VE_NATS_URL is unset the client is a no-op, so the
core still runs standalone without a broker.
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .config import get_settings
from .logging import get_logger

log = get_logger("events")

_nc: Any = None  # nats.aio.client.Client
_js: Any = None  # JetStream context

# ── the EVENTS stream's subject list ─────────────────────────────────────────
# MUST stay identical to ``kernel.events.EVENTS_SUBJECTS`` (backend/kernel) and to
# gokernel's list, because whichever service connects first is the one that
# creates the stream. Core cannot import the kernel package (it does not ship in
# core's image), so this is a deliberate copy — change both, or a service will
# quietly converge the stream back to the other list.
#
# EVENTS used to be ``tenant.>``. It was narrowed so the live IoT sensor feed
# could get its OWN bounded stream (``IOT_READINGS``, subjects ``tenant.*.iot.>``):
# NATS refuses overlapping subjects between streams on one account, and EVENTS is
# unbounded on purpose because it carries low-volume domain events worth keeping.
#
# ⚠ ADDING A NEW DOMAIN? Add it here AND in kernel.events, or its events land on a
# subject no stream captures — the realtime SSE relays (core NATS, at-most-once)
# still work, but there is no persistence and no durable consumer is possible.
EVENTS_STREAM = "EVENTS"
EVENTS_SUBJECTS = [
    "tenant.*.access.>",
    "tenant.*.core.>",
    "tenant.*.device.>",
    "tenant.*.erasure.>",
    "tenant.*.fire.>",
    "tenant.*.ingest.>",
    "tenant.*.notify.>",
    "tenant.*.sites.>",
    "tenant.*.tags.>",
    "tenant.*.tenant.>",
    "tenant.*.vms.>",
    "tenant.*.workflow.>",
]


async def _ensure_events_stream(js) -> None:
    """Create EVENTS, or converge an existing one onto EVENTS_SUBJECTS.

    ``add_stream`` only CREATES; on an existing stream it raises, and this used to
    be swallowed — so a subject-list change would never reach a running stack.
    Update explicitly, only when it differs. Never raises: core must still boot.
    """
    try:
        info = await js.stream_info(EVENTS_STREAM)
    except Exception:
        try:
            await js.add_stream(name=EVENTS_STREAM, subjects=list(EVENTS_SUBJECTS))
        except Exception as e:  # concurrent create by another service — fine
            log.info("EVENTS stream ensure note: %s", e)
        return

    if sorted(info.config.subjects or []) != sorted(EVENTS_SUBJECTS):
        try:
            info.config.subjects = list(EVENTS_SUBJECTS)
            await js.update_stream(config=info.config)
            log.info("EVENTS stream subjects converged to %s", EVENTS_SUBJECTS)
        except Exception as e:
            log.warning("EVENTS stream subject update failed: %s", e)



async def connect() -> None:
    """Connect to NATS and ensure the JetStream event stream exists. Safe to call once."""
    global _nc, _js
    settings = get_settings()
    url = getattr(settings, "nats_url", None) or None
    if not url:
        log.info("NATS disabled (VE_NATS_URL unset) — events are no-ops")
        return
    try:
        import nats

        _nc = await nats.connect(url, name="neubit-core")
        _js = _nc.jetstream()
        # One durable stream capturing the platform's domain events for replay/audit.
        # NOT the IoT sensor feed — that has its own bounded stream. See above.
        await _ensure_events_stream(_js)
        log.info("NATS connected: %s", url)
    except Exception as e:  # broker down / lib missing → degrade gracefully
        log.warning("NATS connect failed (%s) — events are no-ops", e)
        _nc = None
        _js = None


async def close() -> None:
    global _nc, _js
    if _nc is not None:
        try:
            await _nc.drain()
        except Exception:
            pass
    _nc = _js = None


def subject(tenant_id: str, domain: str, event: str) -> str:
    return f"tenant.{tenant_id}.{domain}.{event}"


async def publish(tenant_id: str, domain: str, event: str, payload: dict | None = None) -> None:
    """Publish a domain event. No-op if NATS is unavailable."""
    if _js is None:
        return
    subj = subject(tenant_id, domain, event)
    body = json.dumps({"tenant_id": tenant_id, "domain": domain, "event": event, "payload": payload or {}})
    try:
        await _js.publish(subj, body.encode())
    except Exception as e:
        log.warning("event publish failed on %s: %s", subj, e)


async def subscribe(pattern: str, handler: Callable[[dict], Awaitable[None]]) -> None:
    """Subscribe to a subject pattern (e.g. 'tenant.*.fire.*'); handler gets the decoded dict."""
    if _nc is None:
        return

    async def _cb(msg):
        try:
            await handler(json.loads(msg.data.decode()))
        except Exception as e:
            log.warning("event handler error on %s: %s", pattern, e)

    await _nc.subscribe(pattern, cb=_cb)


async def ephemeral_subscribe(
    pattern: str, handler: Callable[[dict], Awaitable[None]]
) -> Any:
    """Create a NON-durable, per-caller core NATS subscription and RETURN it.

    Unlike ``subscribe`` (fire-and-forget, process-lifetime), this hands the raw
    ``nats.aio.subscription.Subscription`` back so the caller can ``await sub.unsubscribe()``
    when it's done — the shape an SSE connection needs: one ephemeral subscription
    per open stream, torn down the moment the client disconnects. At-most-once live
    delivery (no JetStream, no history) which is exactly right for live UI fan-out.

    Returns ``None`` if NATS is unavailable (client degrades to no-op).
    """
    if _nc is None:
        return None

    async def _cb(msg):
        try:
            await handler(json.loads(msg.data.decode()))
        except Exception as e:  # noqa: BLE001 — never let a bad frame kill the sub
            log.warning("ephemeral event handler error on %s: %s", pattern, e)

    return await _nc.subscribe(pattern, cb=_cb)


def is_connected() -> bool:
    return _nc is not None
