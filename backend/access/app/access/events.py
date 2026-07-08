"""Access domain-event publishing on the NATS spine.

Subjects follow the platform convention
``tenant.<tenant_id>.access.<category>.<event_type>`` (built by
``kernel.events.subject``). This is the contract the workflow correlation engine
already subscribes to (``tenant.*.access.>`` — see
``backend/workflow/app/workflow/correlation.py``), so access events flow straight
into SOP triggering with no extra wiring.

v2 published these to Kafka ``neubit.access.events`` with type
``access.<category>.<type>`` (or ``access.device.<category>`` for io/health) —
see ``neubit_v2/backend/gates/app/ingestion/signalr_handlers.py``. v3 keeps the
same category/type taxonomy but rides the NATS spine instead of Kafka.

Publishing is best-effort and a no-op when NATS is disabled (``VE_NATS_URL``
unset), so it never breaks ingestion. ``tenant_id`` NULL (a platform/system row)
publishes under the reserved ``platform`` segment.
"""

from __future__ import annotations

import re
import uuid

from kernel.events import EventBus, subject

# Process-wide bus (source tag = "access"). The API connects this at startup.
bus = EventBus(source="access")

_SAFE = re.compile(r"[^a-z0-9_]+")


def _slug(value: str) -> str:
    """Lowercase + subject-safe an event-type token (no dots/spaces)."""
    return _SAFE.sub("_", (value or "").strip().lower()).strip("_") or "event"


async def emit_access_event(
    tenant_id: uuid.UUID | str | None,
    category: str,
    event_type: str,
    payload: dict,
    *,
    _bus: EventBus | None = None,
) -> str:
    """Publish ``tenant.<id>.access.<category>.<event_type>`` (best-effort).

    Returns the subject that was targeted (for logging / persistence).
    """
    tid = str(tenant_id) if tenant_id is not None else None
    event = f"{_slug(category)}.{_slug(event_type)}"
    subj = subject(tid, "access", event)
    target = _bus or bus
    await target.publish(subj, {"tenant_id": tid, **payload})
    return subj
