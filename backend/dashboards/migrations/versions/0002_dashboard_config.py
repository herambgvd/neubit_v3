"""dashboards.config — the page-level filters, variables and shared window

Revision ID: 0002_dashboard_config
Revises: 0001_dashboards
Create Date: 2026-08-30

One nullable-free JSON column with a `'{}'` server default, so every existing row
becomes a dashboard with no filters and no variables rather than a row this
build's readers have to special-case.

Written with `ALTER TABLE … IF NOT EXISTS` rather than `Table.create` because
0001 is the ORM-metadata baseline and this is a delta on top of it. This service
runs `alembic upgrade head` (see 0001's note), so this revision actually RUNS —
unlike core's, where everything after the baseline is stamped.
"""

from alembic import op

revision = "0002_dashboard_config"
down_revision = "0001_dashboards"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS config JSON NOT NULL DEFAULT '{}'")


def downgrade() -> None:
    op.execute("ALTER TABLE dashboards DROP COLUMN IF EXISTS config")
