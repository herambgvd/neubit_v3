"""workflow — notification claim columns (claimed_at / claimed_by)

Revision ID: 0006_notification_claim
Revises: 0005_device_tokens
Create Date: 2026-09-05

Adds the two columns that let exactly one worker own a pending notification.

WHY A MIGRATION AT ALL, when ``status`` already had room for the string
``'claimed'``: a claim needs a CLOCK. Without one, a worker that dies between
claiming a row and recording its outcome leaves that row in ``claimed`` forever —
drained by nothing, counted by nothing, and for a life-safety-adjacent alert that
is worse than the duplicate this whole change removes. ``claimed_at`` is the lease
the reaper measures against; ``claimed_by`` is so an operator at a psql prompt can
name the container that is holding a row.

DELIBERATELY NOT reusing ``last_attempt_at`` as that clock. It is the same instant
today and stops being so the first time anything is added between the claim and the
send, and by then the reaper is silently measuring the wrong thing.

SAFE ON A LIVE TABLE. Both columns are nullable with no default, so Postgres
records them in the catalog and rewrites no rows and takes no long lock. The index
is on the new (all-NULL) column. Existing rows read as "not claimed", which is what
they are. Forward-only in effect: ``downgrade`` drops the columns, which would
strand any row sitting in ``claimed`` at that moment, so it is for a dev database
and not for a rollback of a running estate.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006_notification_claim"
down_revision = "0005_device_tokens"
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
    if not _has_column(bind, "notifications", "claimed_at"):
        op.add_column(
            "notifications", sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True)
        )
    if not _has_column(bind, "notifications", "claimed_by"):
        op.add_column("notifications", sa.Column("claimed_by", sa.String(128), nullable=True))
    if not _has_index(bind, "notifications", "ix_notifications_claimed_at"):
        op.create_index("ix_notifications_claimed_at", "notifications", ["claimed_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "notifications", "ix_notifications_claimed_at"):
        op.drop_index("ix_notifications_claimed_at", table_name="notifications")
    for col in ("claimed_by", "claimed_at"):
        if _has_column(bind, "notifications", col):
            op.drop_column("notifications", col)
