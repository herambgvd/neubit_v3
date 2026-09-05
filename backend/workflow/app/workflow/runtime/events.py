"""Workflow domain-event publishing on the NATS spine.

Subjects follow the platform convention
``tenant.<tenant_id>.workflow.<entity>.<event>`` (built by
``kernel.events.subject``). A subscriber can match ``tenant.*.workflow.>`` or a
narrower ``tenant.<id>.workflow.incident.>``.

Publishing is best-effort and a no-op when NATS is disabled (``VE_NATS_URL``
unset), so it never breaks a request. ``tenant_id`` NULL (a platform/super-admin
action) publishes under the reserved ``platform`` segment.

A single process-wide ``EventBus`` is shared: the FastAPI app connects it at
startup (``app.main``); Celery tasks connect a short-lived bus per run.
"""

from __future__ import annotations

import uuid

from kernel.events import EventBus, subject

# Process-wide bus (source tag = "workflow"). The API connects this at startup;
# the correlation consumer/worker uses its own bus instance.
bus = EventBus(source="workflow")


async def emit(
    tenant_id: uuid.UUID | str | None,
    entity: str,
    event: str,
    payload: dict,
    *,
    _bus: EventBus | None = None,
) -> None:
    """Publish ``tenant.<tenant_id>.workflow.<entity>.<event>`` (best-effort).

    The payload always carries ``tenant_id`` (str|None) plus the caller's fields.
    Pass ``_bus`` to publish through a specific bus (e.g. a worker's own bus);
    defaults to the process-wide API bus.
    """
    tid = str(tenant_id) if tenant_id is not None else None
    body = {"tenant_id": tid, **payload}
    target = _bus or bus
    await target.publish(subject(tid, "workflow", f"{entity}.{event}"), body)
