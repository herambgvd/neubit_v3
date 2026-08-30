"""dashboards baseline — dashboards + dashboard_widgets

Revision ID: 0001_dashboards
Revises:
Create Date: 2026-08-30

Creates the dashboards service's own tables in its own DB (neubit_dashboards).
Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata, so it
is safe to re-run and always matches the ORM (the v3 baseline pattern).

NOTE for whoever adds revision 0002: this service starts with
``alembic upgrade head``, NOT core's ``upgrade 0001 && stamp head``. That pairing
exists in core only because its 0001 builds the whole schema from ORM metadata
and would collide with its own later deltas — and the cost of it is that every
future revision is stamped as applied without ever running. Do not copy it here.
"""

from alembic import op

revision = "0001_dashboards"
down_revision = None
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.dashboards.models import Dashboard, DashboardWidget

    # Order matters for the FK: dashboards before widgets.
    return [Dashboard.__table__, DashboardWidget.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
