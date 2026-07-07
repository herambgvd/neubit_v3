"""Workflow ORM models — the incident-automation engine, tenant-scoped.

Ported from neubit_v2's ``module/workflow`` Mongo-document models to SQLAlchemy 2
async ORM on this service's OWN ``Base`` (db ``neubit_workflow``). Every table
carries a nullable ``tenant_id`` (NULL = a platform/super-admin/system row); reads
and by-id lookups go through ``kernel.auth`` (``scoped`` / ``assert_owned``) so
tenant isolation lives in one place.

Portable generic column types (String / Boolean / DateTime / JSON / Integer /
Float / Uuid) keep the same model on Postgres and SQLite (tests). Graph shape,
history, dynamic form fields, and trigger conditions are all JSON blobs validated
by the pydantic schemas before they reach the DB.

Tables:
    sops                     — Standard Operating Procedure (the incident playbook)
    workflow_states          — per-SOP states (nodes of the state machine)
    workflow_transitions     — from_state → to_state edges
    workflow_triggers        — event-keyed launchers (match → create instance)
    workflow_instances       — a running incident (the state machine in motion)
    workflow_forms           — dynamic form definitions (captured on transitions)
    notification_templates   — reusable message templates
    notification_channels    — per-tenant delivery config (email/webhook/whatsapp…)
    notifications            — the outbox (dispatched by the connector framework)
    threat_levels            — deployment/site threat-posture register
    correlation_dedup        — trigger-firing dedup slots (idempotency)
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from .shared import (
    InstancePriority,
    InstanceStatus,
    ThreatLevelValue,
    utcnow,
    uuid_str,
)

# ── Mixins ─────────────────────────────────────────────────────────────


class _TenantTimestamped:
    """Shared columns: tenant scope + created/updated audit stamps."""

    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


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


# ── Form ───────────────────────────────────────────────────────────────


class Form(Base, _TenantTimestamped):
    """A dynamic form definition captured on a transition."""

    __tablename__ = "workflow_forms"

    form_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(2048))
    # [{id, label, type, placeholder, options, validation, order, width}, ...]
    fields: Mapped[list | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )


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
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )


class NotificationChannel(Base, _TenantTimestamped):
    """A per-tenant delivery channel — provider config for a connector.

    ``config`` is a provider-specific JSON blob (SMTP host/port/creds, webhook URL
    + headers, WhatsApp API token, mobile-push app key, …). The connector registry
    (``app.workflow.connectors``) looks up the enabled channel of a given
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
