"""Connector framework — pluggable notification delivery.

A ``Connector`` turns a queued ``Notification`` into an actual delivery through a
provider (SMTP, an HTTP webhook, and later WhatsApp / mobile-push). The design
goal is extensibility: adding a new channel is a new ``Connector`` subclass + one
``register()`` call — no changes to the dispatch task.

Delivery is driven by the notification-dispatch Celery task, which:
  1. reads pending ``notifications`` rows,
  2. looks up the tenant's enabled ``NotificationChannel`` of the row's
     ``channel_type`` (per-tenant provider config),
  3. picks the connector for that type from the registry, and
  4. calls ``connector.send(...)``.

Connectors are deliberately transport-only and stateless; all provider config
comes in via the resolved ``channel`` config dict, so the same connector instance
serves every tenant.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

log = logging.getLogger("workflow.connectors")


@dataclass
class DeliveryContext:
    """Everything a connector needs to deliver one notification.

    ``channel_config`` is the per-tenant provider config (from the matched
    ``NotificationChannel.config``, or empty when no channel row exists and the
    connector can fall back to service-level settings, e.g. SMTP env vars).
    """

    tenant_id: Optional[str]
    recipient: str
    subject: Optional[str]
    body: str
    metadata: dict[str, Any]
    channel_config: dict[str, Any]


class Connector:
    """Base class for all notification connectors.

    Subclasses set ``channel_type`` (the registry key) and implement ``send``.
    ``send`` raises on failure — the dispatch task marks the row failed and
    retries on the next tick (bounded by ``attempts``).
    """

    #: The registry key this connector handles (e.g. "email", "webhook").
    channel_type: str = ""

    async def send(self, ctx: DeliveryContext) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<{type(self).__name__} channel_type={self.channel_type!r}>"


class ConnectorRegistry:
    """Name → connector-instance registry.

    One process-wide registry (``registry`` below). Register a connector once at
    import time; the dispatch task resolves by ``channel_type``.
    """

    def __init__(self) -> None:
        self._connectors: dict[str, Connector] = {}

    def register(self, connector: Connector) -> None:
        if not connector.channel_type:
            raise ValueError("connector must declare a channel_type")
        self._connectors[connector.channel_type] = connector
        log.info("registered connector: %s", connector.channel_type)

    def get(self, channel_type: str) -> Optional[Connector]:
        return self._connectors.get(channel_type)

    def types(self) -> list[str]:
        return sorted(self._connectors)


# Process-wide registry. Built by ``connectors/__init__.py``.
registry = ConnectorRegistry()
