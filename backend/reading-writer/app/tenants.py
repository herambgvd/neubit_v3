"""Resolve the gateway's tenant key to a platform tenant UUID.

WHY THIS EXISTS. Contract §2 says a connection without a tenant "uses the
platform's default tenant id". The gateway does something subtly different: it
publishes ITS OWN default tenant key, which is the literal string ``default`` —
observed live on ``tenant.default.iot.reading.<conn>.<device>.<point>``. But
``readings.tenant_id`` is ``uuid NOT NULL`` (contract §5), so a non-UUID key must
be turned into one or the reading cannot be stored at all.

Three rules, in order:

1. The key already parses as a UUID → use it. This is the steady state once the
   gateway is configured with platform tenant ids, and needs no configuration.
2. The key appears in ``VE_READINGS_TENANT_MAP`` (``key=uuid,key2=uuid``) →
   use the mapped UUID. This is how an operator points ``default`` at the real
   platform tenant, and it is the only way readings show up under a tenant the
   UI knows about.
3. Otherwise → ``VE_READINGS_DEFAULT_TENANT_ID`` if set, else a deterministic
   UUIDv5 of the key.

Rule 3 is deliberately NOT a drop. Dropping a reading because its tenant key was
not configured is silent data loss, which is the worst outcome available here; a
stable synthetic UUID keeps the data, keeps it separable per key, and can be
re-pointed later with a single UPDATE. It is loud instead of silent: every
unmapped key is WARNed once and counted in ``/metrics``
(``reading_writer_unmapped_tenant_keys``), so "my readings are under a tenant
nobody recognises" is a visible condition rather than a mystery.
"""

from __future__ import annotations

import logging
import os
import uuid

log = logging.getLogger("reading-writer.tenants")

# Fixed namespace for rule 3. Never change it — it would repoint every synthetic
# tenant_id already in the table.
NAMESPACE = uuid.UUID("6f1d5a2e-0d3b-5a8f-9c21-1f2b3c4d5e60")


class TenantResolver:
    def __init__(
        self, mapping: dict[str, uuid.UUID] | None = None, default: uuid.UUID | None = None
    ) -> None:
        self._map = mapping or {}
        self._default = default
        self._cache: dict[str, uuid.UUID] = {}
        self.unmapped: dict[str, int] = {}

    @classmethod
    def from_env(cls) -> "TenantResolver":
        mapping: dict[str, uuid.UUID] = {}
        raw = (os.getenv("VE_READINGS_TENANT_MAP") or "").strip()
        for pair in raw.split(","):
            pair = pair.strip()
            if not pair:
                continue
            key, _, val = pair.partition("=")
            try:
                mapping[key.strip()] = uuid.UUID(val.strip())
            except ValueError:
                log.warning("VE_READINGS_TENANT_MAP entry %r is not 'key=uuid' — ignored", pair)

        default = None
        raw_default = (os.getenv("VE_READINGS_DEFAULT_TENANT_ID") or "").strip()
        if raw_default:
            try:
                default = uuid.UUID(raw_default)
            except ValueError:
                log.warning(
                    "VE_READINGS_DEFAULT_TENANT_ID=%r is not a UUID — ignored", raw_default
                )
        return cls(mapping, default)

    def resolve(self, key: str | None) -> uuid.UUID:
        k = (key or "").strip() or "platform"
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
                    "tenant key %r is not a UUID and is not in VE_READINGS_TENANT_MAP — "
                    "readings are being stored under %s. Map it to the platform tenant "
                    "or the UI will not find them.",
                    k, resolved,
                )
        self._cache[k] = resolved
        return resolved
