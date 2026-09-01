"""Resolve an event's tenant segment to a platform tenant UUID.

Same problem the reading-writer has, one domain over. A projected relation
declares ``tenant_id uuid NOT NULL``, but the value on the wire is whatever the
publisher put in the subject — and ``kernel.events.subject`` writes the literal
string ``platform`` when an event has no tenant. That is not a uuid and the row
cannot be stored without a decision.

Three rules, in order:

1. The value already parses as a UUID → use it. Steady state; no configuration.
2. The value appears in ``VE_PROJECTOR_TENANT_MAP`` (``key=uuid,key2=uuid``) →
   use the mapped UUID. This is how an operator points ``platform`` (or any other
   publisher-side key) at a real platform tenant.
3. Otherwise → ``VE_PROJECTOR_DEFAULT_TENANT_ID`` if set, else a deterministic
   UUIDv5 of the key.

Rule 3 is deliberately NOT a drop. Discarding an access event because its tenant
segment was not configured is silent data loss, which is the worst outcome
available here. A stable synthetic UUID keeps the event, keeps it separable per
key, and can be re-pointed later with one UPDATE. It is loud rather than silent:
every unmapped key is WARNed once and counted in ``/metrics``.

The namespace is shared with the reading-writer on purpose: the same publisher
key must resolve to the same synthetic tenant in both stores, or the two datasets
would disagree about who owns the data.
"""

from __future__ import annotations

import logging
import uuid

log = logging.getLogger("projector.tenants")

# Identical to reading-writer's `app.tenants.NAMESPACE`. Never change it — it
# would repoint every synthetic tenant_id already stored.
NAMESPACE = uuid.UUID("6f1d5a2e-0d3b-5a8f-9c21-1f2b3c4d5e60")


class TenantResolver:
    def __init__(self, mapping_raw: str = "", default_raw: str = "") -> None:
        self._map: dict[str, uuid.UUID] = {}
        for pair in (mapping_raw or "").split(","):
            pair = pair.strip()
            if not pair:
                continue
            key, _, val = pair.partition("=")
            try:
                self._map[key.strip()] = uuid.UUID(val.strip())
            except ValueError:
                log.warning("VE_PROJECTOR_TENANT_MAP entry %r is not 'key=uuid' — ignored", pair)

        self._default: uuid.UUID | None = None
        if (default_raw or "").strip():
            try:
                self._default = uuid.UUID(default_raw.strip())
            except ValueError:
                log.warning("VE_PROJECTOR_DEFAULT_TENANT_ID=%r is not a UUID — ignored", default_raw)

        self._cache: dict[str, uuid.UUID] = {}
        self.unmapped: dict[str, int] = {}

    def resolve(self, key: str | None) -> uuid.UUID:
        k = (str(key) if key is not None else "").strip() or "platform"
        hit = self._cache.get(k)
        if hit is not None:
            return hit
        try:
            resolved = uuid.UUID(k)
        except ValueError:
            resolved = self._map.get(k)
            if resolved is None:
                resolved = self._default or uuid.uuid5(NAMESPACE, k)
                self.unmapped[k] = self.unmapped.get(k, 0) + 1
                log.warning(
                    "tenant key %r is not a UUID and is not in VE_PROJECTOR_TENANT_MAP — "
                    "events are being stored under %s. Map it to the platform tenant "
                    "or the dashboard will not find them.",
                    k, resolved,
                )
        self._cache[k] = resolved
        return resolved
