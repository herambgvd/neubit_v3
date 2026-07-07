"""workflow — notification exponential-backoff column

Revision ID: 0002_notification_backoff
Revises: 0001_workflow
Create Date: 2026-07-08

Adds ``notifications.next_attempt_at`` — the earliest time a pending notification
may be (re)dispatched. Drives exponential backoff in the dispatch task: on a
delivery failure the row is rescheduled at ``now + min(base * 2**attempts, cap)``
(± jitter) and only rows with ``next_attempt_at`` NULL or <= now are picked up.

Idempotent: only adds the column + its index if absent, so re-running on a DB
already built from the current metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_notification_backoff"
down_revision = "0001_workflow"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(c["name"] == column for c in insp.get_columns(table))


def _has_index(bind, table: str, index: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(ix["name"] == index for ix in insp.get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "notifications", "next_attempt_at"):
        op.add_column(
            "notifications",
            sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        )
    if not _has_index(bind, "notifications", "ix_notifications_next_attempt_at"):
        op.create_index(
            "ix_notifications_next_attempt_at", "notifications", ["next_attempt_at"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "notifications", "ix_notifications_next_attempt_at"):
        op.drop_index("ix_notifications_next_attempt_at", table_name="notifications")
    if _has_column(bind, "notifications", "next_attempt_at"):
        op.drop_column("notifications", "next_attempt_at")
