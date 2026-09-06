"""Tags domain-event publishing on the NATS spine.

Subjects follow the platform convention
``tenant.<tenant_id>.tags.tag.<event>`` — ``created``, ``updated``, ``deleted``,
``assigned``, ``unassigned`` — so a subscriber can match ``tenant.*.tags.>``.

Publish-only and best-effort: a no-op when NATS is disabled (``VE_NATS_URL`` unset),
never breaking a request. A NULL ``tenant_id`` (a platform action) publishes under
the reserved ``platform`` segment so the subject is always well-formed.
"""

from __future__ import annotations

import uuid

from ..core.events_nats import publish

_PLATFORM = "platform"


async def emit(
    tenant_id: uuid.UUID | None,
    event: str,
    payload: dict,
) -> None:
    """Publish ``tenant.<tenant_id>.tags.tag.<event>`` (best-effort).

    The payload always carries ``tenant_id`` (str|None) plus whatever the caller
    passes (which always includes ``tag_id``).
    """
    tid = str(tenant_id) if tenant_id is not None else _PLATFORM
    body = {"tenant_id": str(tenant_id) if tenant_id is not None else None, **payload}
    await publish(tid, "tags", f"tag.{event}", body)
