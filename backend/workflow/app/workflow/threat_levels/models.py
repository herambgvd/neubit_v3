"""Threat-level ORM model — the deployment / site threat-posture register.

    threat_levels — one deployment-wide row per tenant (``site_id`` NULL) plus
                    optional per-site rows

Its own feature rather than a corner of ``triggers`` even though the correlation
engine matches on posture changes: this is operator-SET state with its own router
(``/workflow/threat-levels``), its own permission pair
(``workflow.threat_level.read`` / ``.update``) and a change history that is read
as a record in its own right, not a launcher.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.enums import ThreatLevelValue
from ..core.mixins import _TenantTimestamped
from ..core.primitives import utcnow, uuid_str

# ── Threat level ───────────────────────────────────────────────────────


class ThreatLevel(Base, _TenantTimestamped):
    """Deployment- or site-wide threat-posture register (workflow trigger source).

    A tenant has one deployment-wide row (``site_id`` NULL) plus optional per-site
    rows. The correlation engine can match triggers on posture changes.
    """

    __tablename__ = "threat_levels"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    # NULL == deployment-wide for the tenant.
    site_id: Mapped[str | None] = mapped_column(String(36), index=True)
    level: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text(f"'{ThreatLevelValue.NORMAL.value}'")
    )
    reason: Mapped[str | None] = mapped_column(String(1024))
    set_by: Mapped[str | None] = mapped_column(String(64))
    set_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    # [{from_level, to_level, reason, set_by, set_at}] — change history.
    history: Mapped[list | None] = mapped_column(JSON)


