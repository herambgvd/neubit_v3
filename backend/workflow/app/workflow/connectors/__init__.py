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
TODO(mobile_push): MobilePushConnector — FCM / APNs push to a device token.
"""

from __future__ import annotations

from .base import Connector, ConnectorRegistry, DeliveryContext, registry
from .email import EmailConnector
from .webhook import WebhookConnector

# Register the built-in connectors. New connectors register the same way.
registry.register(EmailConnector())
registry.register(WebhookConnector())

# --- Future connectors (stubs — implement + register when the provider is wired) ---
#
# from .whatsapp import WhatsAppConnector
# registry.register(WhatsAppConnector())
#
# from .mobile_push import MobilePushConnector
# registry.register(MobilePushConnector())

__all__ = [
    "Connector",
    "ConnectorRegistry",
    "DeliveryContext",
    "registry",
    "EmailConnector",
    "WebhookConnector",
]
