"""Connector framework package — pluggable notification delivery.

Built-in connectors are registered here at import time. To add a new channel
(e.g. WhatsApp, mobile push) later:

    1. Create ``connectors/whatsapp.py`` with a ``WhatsAppConnector(Connector)``
       whose ``channel_type = "whatsapp"`` and whose ``send()`` calls the provider
       API (config resolved from the tenant's ``NotificationChannel.config``).
    2. Import + ``registry.register(WhatsAppConnector())`` below.
    3. Create a ``NotificationChannel`` row (channel_type="whatsapp") per tenant.

That's the whole extension surface — the dispatch Celery task, the notification
model, and the REST channel CRUD already handle arbitrary channel types.

TODO(whatsapp): WhatsAppConnector — Cloud API / provider (Twilio/Gupshup) send.
"""

from __future__ import annotations

from .base import Connector, ConnectorRegistry, DeliveryContext, registry
from .email import EmailConnector
from .push import PushConnector
from .webhook import WebhookConnector

# Register the built-in connectors. New connectors register the same way.
registry.register(EmailConnector())
registry.register(WebhookConnector())
# Mobile push (FCM/APNs) — channel_type "push"; recipient == target user_id, fanned
# out to that user's registered device tokens (tenant-scoped).
registry.register(PushConnector())

# --- Future connectors (stubs — implement + register when the provider is wired) ---
#
# from .whatsapp import WhatsAppConnector
# registry.register(WhatsAppConnector())

__all__ = [
    "Connector",
    "ConnectorRegistry",
    "DeliveryContext",
    "registry",
    "EmailConnector",
    "WebhookConnector",
    "PushConnector",
]
