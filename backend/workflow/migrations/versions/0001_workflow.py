"""workflow — SOP / incident-automation engine tables (baseline)

Revision ID: 0001_workflow
Revises:
Create Date: 2026-07-08

Creates every table for the workflow service's OWN db (``neubit_workflow``): the
SOP state machine (sops / workflow_states / workflow_transitions), the event-keyed
launchers (workflow_triggers), the running incidents (workflow_instances), dynamic
forms (workflow_forms), the notification stack (notification_templates /
notification_channels / notifications), the threat-level register (threat_levels),
and the correlation dedup slots (correlation_dedup).

Every domain table is TENANT-SCOPED: it carries a nullable ``tenant_id`` (owning
tenant; NULL = platform/super-admin/system). Row-scoping is enforced in the
services via ``kernel.auth`` (``scoped`` / ``assert_owned``).

Created idempotently: each table is only created if missing, so re-running on a
DB already built from the metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001_workflow"
down_revision = None
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def _tenant_audit_columns() -> list[sa.Column]:
    """The shared tenant + audit columns present on every domain table."""
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    bind = op.get_bind()

    # ── sops ──────────────────────────────────────────────────────────
    if not _has_table(bind, "sops"):
        op.create_table(
            "sops",
            sa.Column("sop_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("initial_state", sa.String(length=36), nullable=True),
            sa.Column("priority", sa.String(length=16), nullable=False, server_default=sa.text("'medium'")),
            sa.Column("trigger_event_types", sa.JSON(), nullable=True),
            sa.Column("sla_hours", sa.Float(), nullable=True),
            sa.Column("tags", sa.JSON(), nullable=True),
            sa.Column("escalation_rules", sa.JSON(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("sop_id", name="pk_sops"),
        )
        op.create_index("ix_sops_tenant_id", "sops", ["tenant_id"])
        op.create_index("ix_sops_name", "sops", ["name"])
        op.create_index("ix_sops_is_active", "sops", ["is_active"])

    # ── workflow_states ───────────────────────────────────────────────
    if not _has_table(bind, "workflow_states"):
        op.create_table(
            "workflow_states",
            sa.Column("state_id", sa.String(length=36), nullable=False),
            sa.Column("sop_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("color", sa.String(length=16), server_default=sa.text("'#6366F1'")),
            sa.Column("position_x", sa.Float(), server_default=sa.text("0")),
            sa.Column("position_y", sa.Float(), server_default=sa.text("0")),
            sa.Column("is_initial", sa.Boolean(), server_default=sa.text("false")),
            sa.Column("is_terminal", sa.Boolean(), server_default=sa.text("false")),
            sa.Column("is_cancellation", sa.Boolean(), server_default=sa.text("false")),
            sa.Column("sla_hours", sa.Float(), nullable=True),
            sa.Column("entry_actions", sa.JSON(), nullable=True),
            sa.Column("exit_actions", sa.JSON(), nullable=True),
            sa.Column("required_role_ids", sa.JSON(), nullable=True),
            sa.Column("order", sa.Integer(), server_default=sa.text("0")),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("state_id", name="pk_workflow_states"),
        )
        op.create_index("ix_workflow_states_tenant_id", "workflow_states", ["tenant_id"])
        op.create_index("ix_workflow_states_sop_id", "workflow_states", ["sop_id"])
        op.create_index("ix_workflow_states_is_initial", "workflow_states", ["is_initial"])

    # ── workflow_transitions ──────────────────────────────────────────
    if not _has_table(bind, "workflow_transitions"):
        op.create_table(
            "workflow_transitions",
            sa.Column("transition_id", sa.String(length=36), nullable=False),
            sa.Column("sop_id", sa.String(length=36), nullable=False),
            sa.Column("from_state_id", sa.String(length=36), nullable=False),
            sa.Column("to_state_id", sa.String(length=36), nullable=False),
            sa.Column("label", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("requires_note", sa.Boolean(), server_default=sa.text("false")),
            sa.Column("confirmation_required", sa.Boolean(), server_default=sa.text("false")),
            sa.Column("required_role_ids", sa.JSON(), nullable=True),
            sa.Column("form_id", sa.String(length=36), nullable=True),
            sa.Column("conditions", sa.JSON(), nullable=True),
            sa.Column("notification_config", sa.JSON(), nullable=True),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("transition_id", name="pk_workflow_transitions"),
        )
        op.create_index("ix_workflow_transitions_tenant_id", "workflow_transitions", ["tenant_id"])
        op.create_index("ix_workflow_transitions_sop_id", "workflow_transitions", ["sop_id"])
        op.create_index("ix_workflow_transitions_from_state_id", "workflow_transitions", ["from_state_id"])

    # ── workflow_triggers ─────────────────────────────────────────────
    if not _has_table(bind, "workflow_triggers"):
        op.create_table(
            "workflow_triggers",
            sa.Column("trigger_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("sop_id", sa.String(length=36), nullable=False),
            sa.Column("event_source", sa.String(length=128), server_default=sa.text("''")),
            sa.Column("event_type", sa.String(length=255), server_default=sa.text("''")),
            sa.Column("conditions", sa.JSON(), nullable=True),
            sa.Column("dedup", sa.JSON(), nullable=True),
            sa.Column("priority", sa.String(length=16), server_default=sa.text("'medium'")),
            sa.Column("auto_assign", sa.JSON(), nullable=True),
            sa.Column("assign_users", sa.JSON(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("last_fired_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("fire_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("trigger_id", name="pk_workflow_triggers"),
        )
        op.create_index("ix_workflow_triggers_tenant_id", "workflow_triggers", ["tenant_id"])
        op.create_index("ix_workflow_triggers_name", "workflow_triggers", ["name"])
        op.create_index("ix_workflow_triggers_sop_id", "workflow_triggers", ["sop_id"])
        op.create_index("ix_workflow_triggers_event_type", "workflow_triggers", ["event_type"])
        op.create_index("ix_workflow_triggers_enabled", "workflow_triggers", ["enabled"])

    # ── workflow_instances ────────────────────────────────────────────
    if not _has_table(bind, "workflow_instances"):
        op.create_table(
            "workflow_instances",
            sa.Column("instance_id", sa.String(length=36), nullable=False),
            sa.Column("sop_id", sa.String(length=36), nullable=False),
            sa.Column("sop_name", sa.String(length=255), nullable=False),
            sa.Column("sop_version", sa.Integer(), server_default=sa.text("1")),
            sa.Column("name", sa.String(length=512), nullable=True),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("priority", sa.String(length=16), nullable=False, server_default=sa.text("'medium'")),
            sa.Column("site_id", sa.String(length=36), nullable=True),
            sa.Column("current_state", sa.String(length=36), nullable=True),
            sa.Column("current_state_name", sa.String(length=255), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'active'")),
            sa.Column("assigned_to", sa.String(length=64), nullable=True),
            sa.Column("assignment", sa.JSON(), nullable=True),
            sa.Column("trigger_data", sa.JSON(), nullable=True),
            sa.Column("event_id", sa.String(length=128), nullable=True),
            sa.Column("event_type", sa.String(length=255), nullable=True),
            sa.Column("sla_hours", sa.Float(), nullable=True),
            sa.Column("sla_deadline", sa.DateTime(timezone=True), nullable=True),
            sa.Column("is_sla_breached", sa.Boolean(), server_default=sa.text("false")),
            sa.Column("state_entered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("escalation", sa.JSON(), nullable=True),
            sa.Column("tags", sa.JSON(), nullable=True),
            sa.Column("timeline", sa.JSON(), nullable=True),
            sa.Column("metadata_json", sa.JSON(), nullable=True),
            sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("outcome", sa.String(length=512), nullable=True),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("instance_id", name="pk_workflow_instances"),
        )
        op.create_index("ix_workflow_instances_tenant_id", "workflow_instances", ["tenant_id"])
        op.create_index("ix_workflow_instances_sop_id", "workflow_instances", ["sop_id"])
        op.create_index("ix_workflow_instances_priority", "workflow_instances", ["priority"])
        op.create_index("ix_workflow_instances_site_id", "workflow_instances", ["site_id"])
        op.create_index("ix_workflow_instances_status", "workflow_instances", ["status"])
        op.create_index("ix_workflow_instances_assigned_to", "workflow_instances", ["assigned_to"])
        op.create_index("ix_workflow_instances_event_id", "workflow_instances", ["event_id"])

    # ── workflow_forms ────────────────────────────────────────────────
    if not _has_table(bind, "workflow_forms"):
        op.create_table(
            "workflow_forms",
            sa.Column("form_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("fields", sa.JSON(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("form_id", name="pk_workflow_forms"),
        )
        op.create_index("ix_workflow_forms_tenant_id", "workflow_forms", ["tenant_id"])
        op.create_index("ix_workflow_forms_name", "workflow_forms", ["name"])
        op.create_index("ix_workflow_forms_is_active", "workflow_forms", ["is_active"])

    # ── notification_templates ────────────────────────────────────────
    if not _has_table(bind, "notification_templates"):
        op.create_table(
            "notification_templates",
            sa.Column("template_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("channel_type", sa.String(length=32), nullable=False),
            sa.Column("subject", sa.String(length=512), nullable=True),
            sa.Column("body", sa.String(length=8192), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("template_id", name="pk_notification_templates"),
        )
        op.create_index("ix_notification_templates_tenant_id", "notification_templates", ["tenant_id"])
        op.create_index("ix_notification_templates_name", "notification_templates", ["name"])
        op.create_index("ix_notification_templates_channel_type", "notification_templates", ["channel_type"])
        op.create_index("ix_notification_templates_is_active", "notification_templates", ["is_active"])

    # ── notification_channels ─────────────────────────────────────────
    if not _has_table(bind, "notification_channels"):
        op.create_table(
            "notification_channels",
            sa.Column("channel_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("channel_type", sa.String(length=32), nullable=False),
            sa.Column("config", sa.JSON(), nullable=True),
            sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("is_default", sa.Boolean(), server_default=sa.text("false")),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("channel_id", name="pk_notification_channels"),
        )
        op.create_index("ix_notification_channels_tenant_id", "notification_channels", ["tenant_id"])
        op.create_index("ix_notification_channels_channel_type", "notification_channels", ["channel_type"])
        op.create_index("ix_notification_channels_is_enabled", "notification_channels", ["is_enabled"])

    # ── notifications (outbox) ────────────────────────────────────────
    if not _has_table(bind, "notifications"):
        op.create_table(
            "notifications",
            sa.Column("notification_id", sa.String(length=36), nullable=False),
            sa.Column("channel_type", sa.String(length=32), nullable=False),
            sa.Column("recipient", sa.String(length=512), nullable=False),
            sa.Column("subject", sa.String(length=512), nullable=True),
            sa.Column("body", sa.String(length=8192), nullable=False),
            sa.Column("metadata_json", sa.JSON(), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'pending'")),
            sa.Column("error", sa.String(length=2048), nullable=True),
            sa.Column("instance_id", sa.String(length=36), nullable=True),
            sa.Column("channel_id", sa.String(length=36), nullable=True),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("notification_id", name="pk_notifications"),
        )
        op.create_index("ix_notifications_tenant_id", "notifications", ["tenant_id"])
        op.create_index("ix_notifications_channel_type", "notifications", ["channel_type"])
        op.create_index("ix_notifications_status", "notifications", ["status"])
        op.create_index("ix_notifications_instance_id", "notifications", ["instance_id"])

    # ── threat_levels ─────────────────────────────────────────────────
    if not _has_table(bind, "threat_levels"):
        op.create_table(
            "threat_levels",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("site_id", sa.String(length=36), nullable=True),
            sa.Column("level", sa.String(length=16), nullable=False, server_default=sa.text("'normal'")),
            sa.Column("reason", sa.String(length=1024), nullable=True),
            sa.Column("set_by", sa.String(length=64), nullable=True),
            sa.Column("set_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("history", sa.JSON(), nullable=True),
            *_tenant_audit_columns(),
            sa.PrimaryKeyConstraint("id", name="pk_threat_levels"),
        )
        op.create_index("ix_threat_levels_tenant_id", "threat_levels", ["tenant_id"])
        op.create_index("ix_threat_levels_site_id", "threat_levels", ["site_id"])

    # ── correlation_dedup (idempotency slots; NOT tenant-scoped by column) ──
    if not _has_table(bind, "correlation_dedup"):
        op.create_table(
            "correlation_dedup",
            sa.Column("key", sa.String(length=512), nullable=False),
            sa.Column("trigger_id", sa.String(length=36), nullable=False),
            sa.Column("dedup_key", sa.String(length=512), nullable=False),
            sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("key", name="pk_correlation_dedup"),
        )
        op.create_index("ix_correlation_dedup_trigger_id", "correlation_dedup", ["trigger_id"])
        op.create_index("ix_correlation_dedup_expires_at", "correlation_dedup", ["expires_at"])


def downgrade() -> None:
    for table in (
        "correlation_dedup",
        "threat_levels",
        "notifications",
        "notification_channels",
        "notification_templates",
        "workflow_forms",
        "workflow_instances",
        "workflow_triggers",
        "workflow_transitions",
        "workflow_states",
        "sops",
    ):
        op.drop_table(table)
