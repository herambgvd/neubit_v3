"""alerts + broadcasts — platform alert state & announcements (Phase 4.2 / 4.3)

Revision ID: 0013_alerts_broadcasts
Revises: 0012_billing
Create Date: 2026-07-09

Two tables:
  * alert_states — per-admin read/dismiss flags for the derived alert inbox.
  * broadcasts   — scheduled, targeted platform announcements.

Created idempotently (guarded by ``_has_table``) so re-running on a DB already
built from the baseline metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013_alerts_broadcasts"
down_revision = "0012_billing"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "alert_states"):
        op.create_table(
            "alert_states",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("alert_key", sa.String(), nullable=False),
            sa.Column("actor_id", sa.Uuid(), nullable=False),
            sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("dismissed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_alert_states"),
            sa.UniqueConstraint("alert_key", "actor_id", name="uq_alert_states_key_actor"),
        )
        op.create_index("ix_alert_states_alert_key", "alert_states", ["alert_key"])
        op.create_index("ix_alert_states_actor_id", "alert_states", ["actor_id"])

    if not _has_table(bind, "broadcasts"):
        op.create_table(
            "broadcasts",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("body", sa.String(), nullable=False, server_default=sa.text("''")),
            sa.Column("severity", sa.String(), nullable=False, server_default=sa.text("'info'")),
            sa.Column("target_type", sa.String(), nullable=False, server_default=sa.text("'all'")),
            sa.Column("target_tenant_ids", sa.JSON(), nullable=False),
            sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_by", sa.Uuid(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_broadcasts"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "broadcasts"):
        op.drop_table("broadcasts")
    if _has_table(bind, "alert_states"):
        op.drop_index("ix_alert_states_actor_id", table_name="alert_states")
        op.drop_index("ix_alert_states_alert_key", table_name="alert_states")
        op.drop_table("alert_states")
