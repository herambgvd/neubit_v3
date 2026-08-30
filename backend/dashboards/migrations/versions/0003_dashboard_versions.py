"""dashboard_versions — a restorable snapshot after every saved change

Revision ID: 0003_dashboard_versions
Revises: 0002_dashboard_config
Create Date: 2026-08-30

`Table.create(checkfirst=True)` off the live model metadata, the same pattern as
the 0001 baseline: this revision adds a WHOLE table rather than a column, so the
ORM definition is the authority and there is nothing to hand-write twice.

This service runs `alembic upgrade head`, so this revision actually runs.
"""

from alembic import op

revision = "0003_dashboard_versions"
down_revision = "0002_dashboard_config"
branch_labels = None
depends_on = None


def _table():
    from app.dashboards.models import DashboardVersion

    return DashboardVersion.__table__


def upgrade() -> None:
    _table().create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    _table().drop(op.get_bind(), checkfirst=True)
