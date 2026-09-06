"""Access domain events on the NATS spine.

Subjects are tenant.<tenant_id>.access.<category>.<event_type>. The workflow
correlation engine already subscribes to tenant.*.access.>, so these feed SOP
triggering with no extra wiring.

Best-effort: a no-op when NATS is disabled, so publishing never breaks ingestion.
A NULL tenant_id publishes under the reserved "platform" segment.
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
