"""NATS + JetStream event bus client, shared across neubit_v3 services.

Mirrors the platform core's ``app.core.events_nats`` so every service connects to
the same JetStream ``EVENTS`` stream (subjects: see ``EVENTS_SUBJECTS``) and publishes with a
consistent subject scheme + envelope. Cross-domain communication between core,
ingest, and workflow rides on this spine.

Subjects:  ``tenant.<id>.<domain>.<event>``  (per-tenant events)
           ``tenant.platform.<domain>.<event>``  (tenant_id is None → platform)

Envelope (JSON body of every publish):
    { event_id, tenant_id, type, occurred_at, source, payload }

Kept optional: if VE_NATS_URL is unset the client is a no-op, so a service still
runs standalone without a broker.

    from kernel.events import EventBus
    bus = EventBus(source="ingest")
    await bus.connect()
    await bus.publish(subject(tenant_id, "fire", "alarm.raised"), {"zone": 3})
    await bus.subscribe("tenant.*.fire.>", handler, durable="workflow-fire")
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import uuid
from typing import Any, Awaitable, Callable

from .config import get_settings

log = logging.getLogger("kernel.events")

# ── the EVENTS stream's subject list ─────────────────────────────────────────
# EVENTS used to capture ``tenant.>`` — literally every subject on the platform.
# That stopped being safe when the IoT bridge went live: a sensor feed on a
# stream configured ``max_msgs=-1, max_bytes=-1, max_age=0`` is an unbounded
# disk leak, and EVENTS has to stay unbounded-ish because it carries low-volume
# domain events that are worth keeping.
#
# NATS refuses overlapping subjects between two streams on one account, so the
# sensor feed cannot get its own bounded stream while EVENTS still claims
# ``tenant.>``. EVENTS is therefore narrowed to an EXPLICIT list of domains, and
# ``tenant.*.iot.>`` belongs to the bounded ``IOT_READINGS`` stream instead
# (see deploy/README-nats.md and the pipeline contract §4).
#
# ⚠ ADDING A NEW DOMAIN? Add it here, or its events are published to a subject
# no stream captures: core NATS delivery (the realtime SSE relays) still works,
# but there is no JetStream persistence and no durable consumer can be created
# on it. This list is the one place to change — kernel, core and gokernel all
# ensure the same stream.
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


async def ensure_events_stream(js) -> None:
    """Create EVENTS, or converge an existing one onto :data:`EVENTS_SUBJECTS`.

    ``add_stream`` only ever CREATES — on an existing stream it raises and every
    caller here used to swallow that, so a subject-list change would never reach
    a running deployment. Update explicitly, and only when the list differs, so
    this stays a no-op on a converged stack.

    Never raises: a service must still boot when JetStream is unhappy.
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
        except Exception as e:  # e.g. it would overlap another stream
            log.warning("EVENTS stream subject update failed: %s", e)



def subject(tenant_id: str | None, domain: str, event: str) -> str:
    """Build a JetStream subject. ``tenant_id`` None → the ``platform`` namespace."""
    tid = tenant_id if tenant_id else "platform"
    return f"tenant.{tid}.{domain}.{event}"


def envelope(
    *, tenant_id: str | None, type: str, source: str, payload: dict | None = None
) -> dict:
    """The canonical event envelope every service emits."""
    return {
        "event_id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "type": type,
        "occurred_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": source,
        "payload": payload or {},
    }


class EventBus:
    """A thin JetStream client. One per service; connect at startup, close at shutdown."""

    def __init__(self, source: str = "neubit-service") -> None:
        self.source = source
        self._nc: Any = None  # nats.aio.client.Client
        self._js: Any = None  # JetStream context

    async def connect(self) -> None:
        """Connect to NATS + ensure the JetStream event stream exists. No-op if unset."""
        settings = get_settings()
        url = getattr(settings, "nats_url", None) or None
        if not url:
            log.info("NATS disabled (VE_NATS_URL unset) — events are no-ops")
            return
        try:
            import nats

            self._nc = await nats.connect(url, name=f"neubit-{self.source}")
            self._js = self._nc.jetstream()
            await ensure_events_stream(self._js)
            log.info("NATS connected: %s", url)
        except Exception as e:  # broker down / lib missing → degrade gracefully
            log.warning("NATS connect failed (%s) — events are no-ops", e)
            self._nc = None
            self._js = None

    async def close(self) -> None:
        if self._nc is not None:
            try:
                await self._nc.drain()
            except Exception:
                pass
        self._nc = self._js = None

    async def publish(self, subj: str, payload: dict | None = None) -> None:
        """Publish an enveloped event to ``subj``. No-op if NATS is unavailable.

        The subject encodes tenant/domain/event; the envelope re-derives tenant_id
        and type (``<domain>.<event>``) from the subject for consumers.
        """
        if self._js is None:
            return
        tenant_id, type_ = _parse_subject(subj)
        body = envelope(
            tenant_id=tenant_id, type=type_, source=self.source, payload=payload
        )
        try:
            await self._js.publish(subj, json.dumps(body).encode())
        except Exception as e:
            log.warning("event publish failed on %s: %s", subj, e)

    async def subscribe(
        self,
        pattern: str,
        handler: Callable[[dict], Awaitable[None]],
        *,
        durable: str | None = None,
    ) -> None:
        """Subscribe to a subject pattern; handler receives the decoded envelope dict.

        Pass ``durable`` for an at-least-once JetStream durable consumer (survives
        restarts); omit it for an ephemeral core subscription.
        """
        if self._nc is None:
            return

        async def _cb(msg):
            try:
                await handler(json.loads(msg.data.decode()))
            except Exception as e:
                log.warning("event handler error on %s: %s", pattern, e)

        if durable is not None and self._js is not None:
            await self._js.subscribe(pattern, cb=_cb, durable=durable)
        else:
            await self._nc.subscribe(pattern, cb=_cb)

    def is_connected(self) -> bool:
        return self._nc is not None


def _parse_subject(subj: str) -> tuple[str | None, str]:
    """`tenant.<id>.<domain>.<event>` → (tenant_id_or_None, "<domain>.<event>")."""
    parts = subj.split(".")
    if len(parts) >= 4 and parts[0] == "tenant":
        tid = parts[1]
        tenant_id = None if tid == "platform" else tid
        return tenant_id, ".".join(parts[2:])
    return None, subj
