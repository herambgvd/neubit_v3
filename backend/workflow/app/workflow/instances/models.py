"""Workflow-instance ORM model — a running incident.

One table: one row is the incident — its position in the SOP's state machine, its
owner, its SLA clock, and its audit trail. ``timeline`` is a JSON list rather than
a child table because the trail is only ever read whole, with the row.

    workflow_instances — a running incident (the state machine in motion)

``source_key`` is what makes a finding raise work ONCE. A producer that can say
what an incident is ABOUT — Building Intelligence's ``bi:equipment:<id>:metric:
chw_delta_t_in_band`` — names it here, and the partial unique index below holds
at most one OPEN incident per (tenant, key). Closing the incident frees the key,
so the same finding recurring next month raises new work rather than reopening
old work. NULL for everything else: an event-driven incident is keyed by its
trigger's dedup slots (``correlation_dedup``), not by this.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.enums import InstancePriority, InstanceStatus
from ..core.mixins import _TenantTimestamped
from ..core.primitives import uuid_str

#: The partial-index predicate: a keyed incident that is not closed.
OPEN_SOURCE_KEY_PREDICATE = (
    "source_key IS NOT NULL AND status NOT IN ('resolved', 'cancelled')"
)

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

    # The finding this incident is about — see the module docstring.
    source_key: Mapped[str | None] = mapped_column(String(255))

    # At most one OPEN incident per finding. "Open" is spelled as the complement of
    # ``core.enums.CLOSED_STATUSES`` because a partial index predicate must be a
    # literal; ``tests/test_instances_source_key.py`` pins that the two agree.
    #
    # NULLS NOT DISTINCT on tenant_id for the reason 0007 gives: a NULL tenant is a
    # real (platform) caller here, and under the default rule its keys would be the
    # only ones the constraint missed. The index also serves the "which of these
    # keys have open work" read — it is exactly that lookup.
    __table_args__ = (
        Index(
            "uq_workflow_instances_open_source_key", "tenant_id", "source_key", unique=True,
            postgresql_where=text(OPEN_SOURCE_KEY_PREDICATE),
            sqlite_where=text(OPEN_SOURCE_KEY_PREDICATE),
            postgresql_nulls_not_distinct=True,
        ),
    )


