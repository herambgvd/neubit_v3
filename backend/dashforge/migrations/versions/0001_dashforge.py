"""dashforge baseline — dashforge_embeds

Revision ID: 0001_dashforge
Revises:
Create Date: 2026-09-03

Creates the dashforge service's own table in its own DB (neubit_dashforge).
Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata, so it
is safe to re-run and always matches the ORM (the v3 baseline pattern).

NOTE for whoever adds revision 0002: this service starts with
``alembic upgrade head``, NOT core's ``upgrade 0001 && stamp head``. That pairing
exists in core only because its 0001 builds the whole schema from ORM metadata
and would collide with its own later deltas — and the cost of it is that every
future revision is stamped as applied without ever running. Do not copy it here.

``down_revision = None`` because this is THIS service's baseline. Naming another
service's baseline here is a real mistake with a confusing symptom — alembic
answers `Can't locate revision identified by '...'` and the container
restart-loops forever; see the note on the dashboards service in compose.
"""

from alembic import op

revision = "0001_dashforge"
down_revision = None
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.embeds.models import DashForgeEmbed

    return [DashForgeEmbed.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
