"""SOP ORM models — the playbook and the graph it is made of.

Three tables, one feature: a SOP is a state machine, and a state or a transition
has no meaning outside the SOP that owns it (their REST routes are nested under
``/workflow/sops/{sop_id}`` for the same reason). Splitting them into three
packages would buy three ``__init__`` files and a cross-import for every read.

Portable generic column types (String / Boolean / JSON / Integer / Float) keep the
same model on Postgres and SQLite (tests). Graph shape and trigger conditions are
JSON blobs validated by the pydantic schemas before they reach the DB.

    sops                  — the incident playbook (state machine root)
    workflow_states       — per-SOP states (nodes)
    workflow_transitions  — from_state → to_state edges
"""

from __future__ import annotations

from sqlalchemy import JSON, Boolean, Float, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.enums import InstancePriority
from ..core.mixins import _TenantTimestamped
from ..core.primitives import uuid_str

# ── SOP ────────────────────────────────────────────────────────────────


class SOP(Base, _TenantTimestamped):
    """A Standard Operating Procedure — the incident playbook (state machine root)."""

    __tablename__ = "sops"

    sop_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(2048))
    # The SOP's initial state id (denormalized for quick launch). States also carry
    # is_initial; this is a convenience pointer the service keeps in sync.
    initial_state: Mapped[str | None] = mapped_column(String(36))
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text(f"'{InstancePriority.MEDIUM.value}'")
    )
    # Which event types this SOP responds to (informational; triggers own the match).
    trigger_event_types: Mapped[list | None] = mapped_column(JSON)
    sla_hours: Mapped[float | None] = mapped_column(Float)
    tags: Mapped[list | None] = mapped_column(JSON)
    # [{after_hours, to_priority, notify_role_ids:[...]}] — SOP-level escalation rules.
    escalation_rules: Mapped[list | None] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )


# ── State ──────────────────────────────────────────────────────────────


class State(Base, _TenantTimestamped):
    """A node in a SOP's state machine."""

    __tablename__ = "workflow_states"

    state_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sop_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2048))
    color: Mapped[str] = mapped_column(String(16), server_default=text("'#6366F1'"))
    position_x: Mapped[float] = mapped_column(Float, server_default=text("0"))
    position_y: Mapped[float] = mapped_column(Float, server_default=text("0"))
    is_initial: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), index=True)
    # is_terminal == v2 is_final: closing this state RESOLVES the instance.
    is_terminal: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # entering this state CANCELS the instance (a cancellation terminal).
    is_cancellation: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Optional per-state timeout (drives escalation).
    sla_hours: Mapped[float | None] = mapped_column(Float)
    # Optional action hooks fired on entry / exit (JSON list of action descriptors).
    entry_actions: Mapped[list | None] = mapped_column(JSON)
    exit_actions: Mapped[list | None] = mapped_column(JSON)
    required_role_ids: Mapped[list | None] = mapped_column(JSON)
    order: Mapped[int] = mapped_column(Integer, server_default=text("0"))


# ── Transition ─────────────────────────────────────────────────────────


class Transition(Base, _TenantTimestamped):
    """A directed edge between two states in a SOP."""

    __tablename__ = "workflow_transitions"

    transition_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sop_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    from_state_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    to_state_id: Mapped[str] = mapped_column(String(36), nullable=False)
    # label == v2 name (the button text on the transition).
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2048))
    requires_note: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    confirmation_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    required_role_ids: Mapped[list | None] = mapped_column(JSON)
    # Optional dynamic form captured when this transition is executed.
    form_id: Mapped[str | None] = mapped_column(String(36))
    # Gate conditions evaluated against instance context ([{field,operator,value}]).
    conditions: Mapped[list | None] = mapped_column(JSON)
    # {type: email|sms|both|none, role_ids, user_ids, email_subject, email_body, ...}
    notification_config: Mapped[dict | None] = mapped_column(JSON)


