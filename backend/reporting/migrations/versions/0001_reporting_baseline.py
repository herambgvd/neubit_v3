"""reporting baseline — points dimension + readings hypertable

Revision ID: 0001_reporting
Revises:
Create Date: 2026-08-30

Creates the reporting store's two tables in its own DB (neubit_reporting), then
turns `readings` into a TimescaleDB hypertable.

WHY THE TABLES ARE SPELLED OUT HERE AND NOT BUILT FROM ``Base.metadata``
------------------------------------------------------------------------
They used to be. This revision called ``Point.__table__.create(bind,
checkfirst=True)``, on the reasoning that a baseline built from the live models
"can never drift from ``reporting.models``". That reasoning is exactly backwards:
it cannot drift from the models, so it drifts from ITSELF. A migration is a fixed
step in a chain — "the schema as it stood at 0001" — and reading the live ORM
makes that step a moving target that changes every time somebody adds a column.

The failure mode is not subtle. Add ``device_type`` to ``Point`` (which you must,
or autogenerate proposes dropping it and the DPDP erasure walk never sees it) and
a FRESH database gets that column from the BASELINE. `0003_points_device_class`,
whose entire job is to add it, then dies:

    alembic upgrade head
    -> column "device_type" of relation "points" already exists

Measured on a throwaway timescale/timescaledb:2.17.2-pg16. `0008` and `0022` had
the same shape waiting behind it. EXISTING deployments never saw any of it,
because their `points` was created before the model grew — which is why this sat
latent: the only database that can hit it is one nobody has built yet.

So the two tables below are the schema AS IT WAS AT 0001, written out. The
columns a later revision adds are NOT here, by construction:

    0003  device_type, ix_points_tenant_category
    0006  retired_at, ix_points_tenant_live
    0008  site_id/site_name/floor_id/floor_name/zone_id/zone_name,
          ix_points_tenant_site, ix_points_tenant_floor
    0010  placement_source, ck_points_placement_source
    0012  unit_source, unit_confirmed_at, unit_confirmed_by
    0022  gateway_id, ix_points_tenant_gateway
    0024  superseded_by, retire_reason, ix_points_superseded_by

The column ORDER below is not cosmetic either: it is the order the live
deployment's `points` actually has in `information_schema.columns` (1..12, with
each later revision's ADD COLUMN appended after it). A fresh database built from
this file therefore lands on the same physical layout as the one running in
production, rather than a rearrangement of it that happens to have the same names.

Anything that is NOT a column — the hypertable conversion, the compression
settings, the continuous aggregates in 0002 — is still raw SQL, because none of
it is expressible in SQLAlchemy metadata. That has not changed.

Unlike core, this service's start command is a plain ``alembic upgrade head`` —
every revision here is incremental and runs in order, so there is no
``upgrade 0001 && stamp head`` shortcut to work around and no revision that gets
silently skipped.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

from reporting.policies import PolicyConfig

revision = "0001_reporting"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # The timescale/timescaledb image preloads the extension into template1, so a
    # freshly created database already has it — but say so explicitly rather than
    # depending on that, in case the reporting DB is ever created some other way.
    bind.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))

    # ── the dimension ────────────────────────────────────────────────────────
    # Dimension before fact (no FK today — see `readings.point_id` — but keep the
    # honest order).
    #
    # Everything that is not a measurement lives here, keyed by the gateway's
    # `point_id`. Renaming a device rewrites ONE row here instead of a hundred
    # million rows over there.
    op.create_table(
        "points",
        sa.Column("point_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Tenant that owns the point. Every query filters on this.
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        # The gateway connection (conflux conn_id) this point arrives on.
        sa.Column("conn_id", postgresql.UUID(as_uuid=True), nullable=True),
        # Owning device, and the tags. `point_tag` (e.g. "PF_pf") is unique only
        # within a device, which is why the browse index below is a triple.
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("device_tag", sa.String(255), nullable=True),
        sa.Column("point_tag", sa.String(255), nullable=True),
        # Engineering unit ("kW", "degC", ""). Free text, and NULL means NOBODY
        # HAS SAID rather than "dimensionless" — it is never filled by inference.
        sa.Column("unit", sa.String(64), nullable=True),
        # What the device is, as the gateway classifies it: `category` is the BI
        # domain ("energy", "hvac", ...), `type` is the READING KIND ("num" /
        # "text"), i.e. which of readings.num/readings.txt this point fills.
        # Those are two different things and neither column is overloaded with
        # the other. (The equipment kind — "meter", "chiller" — arrives as
        # `device_type` in 0003.)
        sa.Column("category", sa.String(128), nullable=True),
        sa.Column("type", sa.String(64), nullable=True),
        # Anything else the gateway knows that is not worth a column yet. Kept
        # out of the fact table on purpose.
        sa.Column("meta", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("point_id", name="points_pkey"),
    )
    op.create_index("ix_points_tenant", "points", ["tenant_id"])
    op.create_index("ix_points_conn", "points", ["conn_id"])
    op.create_index("ix_points_device", "points", ["device_id"])
    # "show me the points on this device, by tag" — the browse path.
    op.create_index(
        "ix_points_tenant_device_tag", "points", ["tenant_id", "device_tag", "point_tag"]
    )

    # ── the fact ─────────────────────────────────────────────────────────────
    # Deliberately NARROW. What decides whether this stays fast is CARDINALITY
    # (distinct series), not rows/sec, and every extra column multiplies the cost
    # of every one of those rows.
    #
    # `num` and `txt` are separate columns (contract §3/§5): a text reading
    # carries no measurement, so it has `num IS NULL` and `txt` set. Coercing it
    # to 0 would put a fake zero into every min/avg on the dashboard.
    op.create_table(
        "readings",
        # Measurement time (contract §3) — when it was measured, not when it was
        # published. Partition key, and the trailing half of the primary key.
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        # Denormalised so a tenant-scoped query never joins the dimension table.
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Deliberately NOT a foreign key to `points`: an FK check on every insert
        # would serialise the batch write path against the dimension table, and
        # the writer upserts the dimension row itself.
        sa.Column("point_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("num", sa.Float(), nullable=True),
        sa.Column("txt", sa.Text(), nullable=True),
        # Envelope quality flag (`q`). 0 = good.
        sa.Column("quality", sa.SmallInteger(), nullable=False, server_default="0"),
        # PRIMARY KEY (point_id, ts), IN THAT ORDER — the contract's key, and the
        # right index for "one point over a time range". Replays from the outbox
        # are expected and normal, so the writer inserts with ON CONFLICT DO
        # NOTHING and lets the database make a redelivery a no-op.
        sa.PrimaryKeyConstraint("point_id", "ts", name="readings_pkey"),
    )
    # Tenant-wide scans over a window, without touching `points`.
    op.create_index("ix_readings_tenant_ts", "readings", ["tenant_id", "ts"])

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
    # Dropping the table drops its chunks, its hypertable catalog entry and the
    # index create_hypertable() made for itself (`readings_ts_idx`), so none of
    # those need naming here. Fact before dimension — the reverse of the order
    # upgrade() built them in.
    op.drop_table("readings")
    op.drop_table("points")
