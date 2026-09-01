"""reporting baseline — points dimension + readings hypertable

Revision ID: 0001_reporting
Revises:
Create Date: 2026-08-30

Creates the reporting store's two tables in its own DB (neubit_reporting), then
turns `readings` into a TimescaleDB hypertable.

Follows the v3 baseline pattern (see ingest/0001): tables are created from the
live ORM metadata with ``Table.create(checkfirst=True)``, so the migration is
idempotent and can never drift from ``reporting.models``.

Unlike core, this service's start command is a plain ``alembic upgrade head`` —
every revision here is incremental and runs in order, so there is no
``upgrade 0001 && stamp head`` shortcut to work around and no revision that gets
silently skipped.
"""

from alembic import op
from sqlalchemy import text

from reporting.policies import PolicyConfig

revision = "0001_reporting"
down_revision = None
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from reporting.models import Point, Reading

    # Dimension before fact (no FK today, but keep the honest order).
    return [Point.__table__, Reading.__table__]


def upgrade() -> None:
    bind = op.get_bind()

    # The timescale/timescaledb image preloads the extension into template1, so a
    # freshly created database already has it — but say so explicitly rather than
    # depending on that, in case the reporting DB is ever created some other way.
    bind.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))

    for table in _tables():
        table.create(bind, checkfirst=True)

    # `readings` → hypertable, partitioned on ts. `if_not_exists` keeps the
    # revision replayable against a partially-built database.
    #
    # The chunk interval is a deployment knob (VE_READINGS_CHUNK_INTERVAL): a site
    # with a handful of slow sensors and one with thousands of fast ones want very
    # different chunk sizes, and this is only applied at creation time.
    chunk = PolicyConfig.from_env().chunk_interval
    bind.execute(
        text(
            "SELECT create_hypertable('readings', 'ts', "
            f"chunk_time_interval => INTERVAL '{chunk}', "
            "if_not_exists => TRUE, migrate_data => TRUE)"
        )
    )

    # Compression settings on the raw hypertable. Segment by point_id so one
    # series' history compresses together (that is the access pattern), order by
    # ts DESC so "the last N readings for this point" reads the head of a segment.
    #
    # This also satisfies Timescale's rule that every column of a unique
    # constraint must appear in segmentby or orderby — PRIMARY KEY (point_id, ts)
    # is exactly covered, which is what lets the writer keep doing
    # `ON CONFLICT DO NOTHING` against compressed chunks.
    bind.execute(
        text(
            "ALTER TABLE readings SET ("
            "  timescaledb.compress,"
            "  timescaledb.compress_segmentby = 'point_id',"
            "  timescaledb.compress_orderby = 'ts DESC'"
            ")"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    # Dropping the table drops its chunks and hypertable catalog entry.
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
