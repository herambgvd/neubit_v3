"""points: a retire path, so a dead point stops counting

Revision ID: 0006_points_retire
Revises: 0005_projection_registry
Create Date: 2026-08-31

A point that stops reporting counted toward every Building Intelligence figure
forever. `points` had `last_seen_at` and nothing that consumed it for anything
but the 15-minute "reporting" freshness badge, so a decommissioned meter, a
renamed tag and a one-off test point were all permanent members of
`total_points`. The only way out was `DELETE FROM points`, which is destructive:
`readings` has no foreign key to it, so deleting the dimension row orphans the
history rather than removing it.

So: `retired_at`. NULL = live and counted. Non-NULL = retired and excluded from
BI's counts, with its readings untouched — retiring a point never deletes a
measurement, and un-retiring one restores its place in the counts unchanged.

Two ways in, deliberately, because they answer different questions:
  * the HORIZON — `last_seen_at` older than VE_READINGS_RETIRE_AFTER_DAYS (30 by
    default) is treated as retired at query time, without writing anything. It
    needs no operator and it self-heals: a point that starts reporting again is
    live again the moment a reading lands.
  * the EXPLICIT retire — `retired_at` set through the API, for a point that is
    genuinely gone and should stop counting NOW rather than in a month. The
    writer clears it on the next reading, so an explicit retire is a statement
    about the present, not a permanent ban.

The index is partial. Almost every point is live, so an index over the live ones
is small and the retired tail costs nothing to carry.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006_points_retire"
down_revision = "0005_projection_registry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "points",
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_points_tenant_live",
        "points",
        ["tenant_id", "last_seen_at"],
        postgresql_where=sa.text("retired_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_points_tenant_live", table_name="points")
    op.drop_column("points", "retired_at")
