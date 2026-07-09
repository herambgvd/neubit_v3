"""Alert read/dismiss state — the only persisted part of the alert inbox.

Alerts themselves are derived on the fly (see service.compute_alerts); this table
records, per super-admin, which alert keys they've read or dismissed so the inbox
badge and list stay meaningful across sessions.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, UniqueConstraint, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class AlertState(Base):
    """One row per (alert_key, super-admin) capturing read/dismissed flags."""

    __tablename__ = "alert_states"
    __table_args__ = (
        UniqueConstraint("alert_key", "actor_id", name="uq_alert_states_key_actor"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Deterministic key of the derived alert, e.g. "license-expired:<tenant_id>".
    alert_key: Mapped[str] = mapped_column(String, index=True, nullable=False)
    # The super-admin this state belongs to.
    actor_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True, nullable=False)
    read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    dismissed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
