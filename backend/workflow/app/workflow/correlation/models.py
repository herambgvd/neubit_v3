"""Correlation ORM model — the trigger-firing dedup slots.

    correlation_dedup — idempotency slots (INSERT … ON CONFLICT DO NOTHING)

The one table in this service that does NOT carry ``_TenantTimestamped``, and it
must not gain it: the ``key`` already embeds trigger_id (itself tenant-scoped) +
dedup_key + window bucket, so a slot is globally unique, and adding a
``tenant_id`` would give the offboard eraser a second, redundant handle on rows
that carry no tenant data.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.primitives import utcnow

# ── Correlation dedup ──────────────────────────────────────────────────


class CorrelationDedup(Base):
    """Idempotency slots for trigger firings (INSERT … ON CONFLICT DO NOTHING).

    Not tenant-scoped by column: the ``key`` already embeds trigger_id (which is
    tenant-scoped) + dedup_key + window bucket, so a slot is globally unique.
    """

    __tablename__ = "correlation_dedup"

    key: Mapped[str] = mapped_column(String(512), primary_key=True)
    trigger_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    dedup_key: Mapped[str] = mapped_column(String(512), nullable=False)
    claimed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
