"""Tags domain-event publishing on the NATS spine.

Subjects follow the platform convention ``tenant.<tenant_id>.tags.<entity>.<event>``
(built by ``events_nats.publish(tenant_id, domain, event, payload)``). We use the
domain ``tags`` and the entity ``tag`` (e.g. ``tag.created``, ``tag.updated``,
``tag.deleted``, plus ``tag.assigned`` / ``tag.unassigned`` for link changes) so a
subscriber can match ``tenant.*.tags.>`` or ``tenant.<id>.tags.tag.>``.

Publish-only, best-effort, and a no-op when NATS is disabled (``VE_NATS_URL``
unset) — it never breaks a request. ``tenant_id`` NULL (a platform/super-admin
action) is published under the reserved ``platform`` tenant segment so the subject
is always well-formed.
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
