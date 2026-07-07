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
        # One durable stream capturing all tenant events for replay/audit.
        try:
            await _js.add_stream(name="EVENTS", subjects=["tenant.>"])
        except Exception:
            pass  # already exists
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


def is_connected() -> bool:
    return _nc is not None
