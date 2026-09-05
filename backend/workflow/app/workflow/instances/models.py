"""Workflow-instance ORM model — a running incident.

One table, because one row IS the incident: its position in the SOP's state
machine, who owns it, its SLA clock, and its transition/audit trail (``timeline``,
a JSON list rather than a child table — the trail is only ever read whole, with
the row).

    workflow_instances — a running incident (the state machine in motion)
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.enums import InstancePriority, InstanceStatus
from ..core.mixins import _TenantTimestamped
from ..core.primitives import uuid_str

# ── Workflow Instance ──────────────────────────────────────────────────


class WorkflowInstance(Base, _TenantTimestamped):
    """A running incident — one execution of a SOP's state machine."""

    __tablename__ = "workflow_instances"

    instance_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sop_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    sop_name: Mapped[str] = mapped_column(String(255), nullable=False)
    sop_version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    name: Mapped[str | None] = mapped_column(String(512))
    description: Mapped[str | None] = mapped_column(String(2048))
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False,
        server_default=text(f"'{InstancePriority.MEDIUM.value}'"), index=True,
    )
    site_id: Mapped[str | None] = mapped_column(String(36), index=True)
    current_state: Mapped[str | None] = mapped_column(String(36))
    current_state_name: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(
        String(16), nullable=False,
        server_default=text(f"'{InstanceStatus.ACTIVE.value}'"), index=True,
    )
    # Who owns this incident (a core user_id).
    assigned_to: Mapped[str | None] = mapped_column(String(64), index=True)
    # {assigned_to, assigned_to_name, assigned_role, assigned_role_name, assigned_at}
    assignment: Mapped[dict | None] = mapped_column(JSON)

    # The originating event envelope + its identifiers (for traceability / dedup).
    trigger_data: Mapped[dict | None] = mapped_column(JSON)
    event_id: Mapped[str | None] = mapped_column(String(128), index=True)
    event_type: Mapped[str | None] = mapped_column(String(255))

    # SLA / escalation tracking.
    sla_hours: Mapped[float | None] = mapped_column(Float)
    sla_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_sla_breached: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    state_entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # {level, escalated_at, escalated_by, reason}
    escalation: Mapped[dict | None] = mapped_column(JSON)

    tags: Mapped[list | None] = mapped_column(JSON)
    # The transition/audit trail: [{transition_id, from_state, to_state, executed_by,
    # notes, form_data, form_labels, executed_at}, ...]
    timeline: Mapped[list | None] = mapped_column(JSON)
    extra: Mapped[dict | None] = mapped_column("metadata_json", JSON)

    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(String(512))


