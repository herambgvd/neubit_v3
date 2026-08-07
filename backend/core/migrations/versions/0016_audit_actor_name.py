"""audit_log.actor_name — snapshot the actor's display name

Revision ID: 0016_audit_actor_name
Revises: 0015_user_site_scope
Create Date: 2026-08-07

The trail showed raw emails, which reads badly in a console ("who deleted that
user?" is answered by a person, not an address). Snapshot the name alongside the
email — same reason the email is snapshotted: the row must stay readable after a
rename or a delete. Existing rows are backfilled from ``users`` by actor_id where
the user still exists; the rest stay NULL and fall back to the email in the UI.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016_audit_actor_name"
down_revision = "0015_user_site_scope"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("audit_log", sa.Column("actor_name", sa.String(), nullable=True))
    # Correlated subquery rather than UPDATE…FROM — portable across Postgres and SQLite.
    op.execute(
        """
        UPDATE audit_log
           SET actor_name = (SELECT full_name FROM users WHERE users.id = audit_log.actor_id)
         WHERE actor_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("audit_log", "actor_name")
