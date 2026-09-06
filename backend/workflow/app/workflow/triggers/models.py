"""Trigger + alert-format ORM models — the two ways an event starts an incident.

One feature because both answer the same question from opposite ends: a trigger
matches an event by TYPE plus conditions, an alert format matches it by CODE. The
correlation engine consults both on every message.

    workflow_triggers — event-keyed launchers (match → create instance)
    alert_formats     — alert_code → SOP mapping (category/severity/priority/icon)
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.enums import InstancePriority
from ..core.mixins import _TenantTimestamped
from ..core.primitives import uuid_str

# ── Trigger ────────────────────────────────────────────────────────────


class Trigger(Base, _TenantTimestamped):
    """An event-keyed launcher: match an incoming event → create a SOP instance."""

    __tablename__ = "workflow_triggers"

    trigger_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(2048))
    sop_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    # The event key this trigger listens for (e.g. "ingest.event.received",
    # "fire.alarm.raised"). Empty == match any event type.
    event_source: Mapped[str] = mapped_column(String(128), server_default=text("''"))
    event_type: Mapped[str] = mapped_column(String(255), server_default=text("''"), index=True)
    # [{field, operator, value}] — ALL must match the event payload.
    conditions: Mapped[list | None] = mapped_column(JSON)
    # {strategy, key_field, window_seconds} — firing dedup.
    dedup: Mapped[dict | None] = mapped_column(JSON)
    priority: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{InstancePriority.MEDIUM.value}'")
    )
    auto_assign: Mapped[dict | None] = mapped_column(JSON)
    assign_users: Mapped[list | None] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fire_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))



# ── Alert format ───────────────────────────────────────────────────────


class AlertFormat(Base, _TenantTimestamped):
    """Maps an alert code (e.g. "TEST_ALERT", "unknown_card") → a SOP.

    An event carrying a matching alert code makes the correlation engine spin up
    an incident from the mapped SOP, in its initial state. ``alert_code`` is unique
    per tenant. category/severity/priority are plain String columns, not enums, to
    avoid the asyncpg enum footgun.
    """

    __tablename__ = "alert_formats"

    format_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    # Unique per tenant (enforced by a composite index below).
    alert_code: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(2048))
    # security | performance | maintenance | system | custom (free string, v2-parity).
    category: Mapped[str] = mapped_column(String(32), nullable=False, server_default=text("'custom'"))
    severity: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'medium'"))
    priority: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'medium'"))
    color_code: Mapped[str] = mapped_column(String(16), server_default=text("'#6B7280'"))
    icon: Mapped[str | None] = mapped_column(String(64))
    alert_sound: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # The SOP this alert maps to (nullable — an unmapped format matches but can't fire).
    sop_id: Mapped[str | None] = mapped_column(String(36), index=True)
    # automatic → new incident is ACTIVE; manual → PENDING (operator must activate).
    sop_mode: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'manual'"))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )

    # alert_code is unique PER TENANT (NULL tenant is the platform/system row).
    __table_args__ = (
        Index("uq_alert_formats_tenant_code", "tenant_id", "alert_code", unique=True),
    )


