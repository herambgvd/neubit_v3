"""Notification ORM models — template, channel, outbox, device token.

Four tables, one feature, and they are one feature because a single delivery walks
all four: a TEMPLATE renders the message, a CHANNEL supplies the provider config,
an outbox row (``notifications``) holds it until the dispatch job drains it
through a connector, and for a push that connector resolves the recipient's
DEVICE TOKENS. They also share one router prefix (``/workflow/notifications``) and
one permission family (``workflow.notification.*``).

    notification_templates — reusable message templates
    notification_channels  — per-tenant delivery config (email/webhook/whatsapp…)
    notifications          — the outbox (dispatched by the connector framework)
    device_tokens          — per-user mobile push tokens (FCM/APNs)
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.mixins import _TenantTimestamped
from ..core.primitives import uuid_str

# ── Notification template / channel / outbox ───────────────────────────


class NotificationTemplate(Base, _TenantTimestamped):
    """A reusable message template (subject + body, with {placeholders})."""

    __tablename__ = "notification_templates"

    template_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(2048))
    # email | sms | webhook | whatsapp | mobile_push — the connector kind.
    channel_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    subject: Mapped[str | None] = mapped_column(String(512))
    body: Mapped[str] = mapped_column(String(8192), nullable=False)
    # Provider-side template id (WhatsApp / Meta Cloud API pre-approved template).
    provider_template_ref: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )


class NotificationChannel(Base, _TenantTimestamped):
    """A per-tenant delivery channel — provider config for a connector.

    ``config`` is a provider-specific JSON blob (SMTP host/port/creds, webhook URL
    + headers, WhatsApp API token, mobile-push app key, …). The connector registry
    (``app.workflow.notifications.connectors``) looks up the enabled channel of a given
    ``channel_type`` for the tenant at dispatch time.
    """

    __tablename__ = "notification_channels"

    channel_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # email | webhook | whatsapp | mobile_push | sms
    channel_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    config: Mapped[dict | None] = mapped_column(JSON)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    is_default: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class Notification(Base, _TenantTimestamped):
    """The notification outbox — dispatched by the connector framework."""

    __tablename__ = "notifications"

    notification_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    # The connector kind to route through: email | webhook | whatsapp | mobile_push | sms
    channel_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    recipient: Mapped[str] = mapped_column(String(512), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(512))
    body: Mapped[str] = mapped_column(String(8192), nullable=False)
    extra: Mapped[dict | None] = mapped_column("metadata_json", JSON)
    # pending | sent | failed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'pending'"), index=True
    )
    error: Mapped[str | None] = mapped_column(String(2048))
    instance_id: Mapped[str | None] = mapped_column(String(36), index=True)
    channel_id: Mapped[str | None] = mapped_column(String(36))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Earliest time a pending row may be (re)dispatched — drives exponential backoff.
    # NULL == dispatch immediately (never attempted).
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ── Device token (mobile push registration) ────────────────────────────


class DeviceToken(Base, _TenantTimestamped):
    """A registered mobile push token for one user's device.

    The push connector (``connectors/push.py``) looks up a user's enabled tokens
    at dispatch time and sends to each. Tokens are TENANT-SCOPED: a push only ever
    reaches tokens belonging to the target tenant's users (isolation lives in the
    ``(tenant_id, user_id)`` filter). A token the provider reports as
    invalid/unregistered is disabled (``is_active = False``) rather than deleted so
    the audit trail survives.

    ``platform`` is the connector provider kind: ``fcm`` (Android / web) or
    ``apns`` (iOS). ``token`` is the opaque provider registration token (FCM
    registration id, or APNs device token hex). ``(tenant_id, platform, token)`` is
    unique so re-registering the same device is an upsert, not a duplicate.
    """

    __tablename__ = "device_tokens"

    device_token_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    # The user (a core user_id) this device belongs to.
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # fcm | apns — routes to the matching provider inside the push connector.
    platform: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    # The opaque provider registration token (FCM reg id / APNs device token).
    token: Mapped[str] = mapped_column(String(512), nullable=False)
    # Optional human label ("Pixel 8", "iPad — front desk").
    label: Mapped[str | None] = mapped_column(String(255))
    # Disabled when the provider reports the token invalid/unregistered (pruning).
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # A device registers once per (tenant, platform, token). Re-registration upserts.
    __table_args__ = (
        Index("uq_device_tokens_tenant_platform_token", "tenant_id", "platform", "token", unique=True),
    )


