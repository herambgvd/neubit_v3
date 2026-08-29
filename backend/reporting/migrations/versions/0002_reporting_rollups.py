"""reporting: 1-minute and 1-hour continuous aggregates + background policies

Revision ID: 0002_reporting_rollups
Revises: 0001_reporting
Create Date: 2026-08-30

Dashboards read the rollups, never the raw table (contract §5). That is what
makes query cost independent of ingest rate, which matters here because sensors
have wildly different turnaround times and the platform cannot assume any of them.

SHAPE
-----
`readings_1h` is built ON TOP OF `readings_1m` (a hierarchical continuous
aggregate), not on the raw table. An hour of a 1-second sensor is 3600 raw rows
but only 60 rollup rows, so the hourly refresh does ~60x less work. TimescaleDB
2.17 supports this; it requires the child (`readings_1m`) to be
`materialized_only = true`, which it is.

`readings_1h` is left `materialized_only = false` (real-time), so a dashboard
querying the current hour gets the materialised part UNIONed with a live read of
the 1-minute rollup, instead of a hole where the current hour should be.
`readings_1m` cannot be real-time — a hierarchical parent is not allowed on a
real-time child — so the pipeline's freshness floor is the 1-minute refresh lag
(refresh every minute, end_offset 1 minute → roughly two minutes behind live).
Anything that must be fresher than that reads the NATS stream, not this database.

WHAT THE ROLLUPS AGGREGATE
--------------------------
Numeric (`num`): count / min / max / avg / sum / first / last. `sum` is carried
explicitly because the hourly view needs it: `avg(num_avg)` would average the
minutes rather than the readings and would be wrong for any point that reports
at an uneven rate, so the hourly average is computed as `sum(num_sum) /
sum(num_count)`. Note `count(num)` — not `count(*)` — so a text reading does not
inflate the numeric sample count. `sample_count` counts everything.

Text (`txt`): `last(txt, ts)` and `count(txt)`.

  Why those two and not something else. A text reading is a mode or a status —
  "RUNNING", "FAULT", "AUTO". The two honest questions about a bucket are "what
  was it at the end of this bucket" (last) and "how much did it move" (count).
  Averaging a status is meaningless, and so is min/max — lexicographic order over
  status strings ranks "AUTO" before "FAULT" for no reason anyone would want.

  On "number of changes" specifically: the brief called it defensible, and it is,
  but the version that would be genuinely useful — `count(DISTINCT txt)`, or a
  true transition count — is NOT expressible as a continuous aggregate.
  TimescaleDB requires aggregates that can be combined from partials, and
  DISTINCT-based ones cannot be. Rather than silently degrade the whole rollup to
  a plain view to get it, this stores `txt_count` (how many text readings landed
  in the bucket) and `txt_last`. A dashboard that needs true transitions gets
  them from the raw table over a bounded window, where the cost is bounded too;
  a dashboard that needs "was this point chattering" gets it from `txt_count`,
  which is what that question usually means in practice.

`quality_max` carries the worst quality flag seen in the bucket, so a rollup can
never quietly present a bucket built from bad readings as clean.

POLICIES
--------
Refresh, compression and retention are NOT hard-coded here. This revision creates
the aggregates and then hands off to ``reporting.reconcile.reconcile_policies``,
which reads the ``VE_READINGS_*`` environment. The same function runs on every
start of the `reporting-migrate` container, so changing a retention window is an
env change plus a restart — not a migration. See ``reporting/policies.py`` for
the variable list and where an operator sets them.
"""

from alembic import op
from sqlalchemy import text

from reporting.reconcile import reconcile_policies

revision = "0002_reporting_rollups"
down_revision = "0001_reporting"
branch_labels = None
depends_on = None


# WITH NO DATA: creating the aggregate must not block the migration on a full
# backfill of an existing table. The refresh policy fills it in, and an operator
# backfilling history calls refresh_continuous_aggregate() deliberately.
AGG_1M = """
CREATE MATERIALIZED VIEW readings_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
    time_bucket(INTERVAL '1 minute', ts) AS bucket,
    tenant_id,
    point_id,
    count(*)                AS sample_count,
    count(num)              AS num_count,
    min(num)                AS num_min,
    max(num)                AS num_max,
    avg(num)                AS num_avg,
    sum(num)                AS num_sum,
    first(num, ts)          AS num_first,
    last(num, ts)           AS num_last,
    count(txt)              AS txt_count,
    last(txt, ts)           AS txt_last,
    max(quality)            AS quality_max
FROM readings
GROUP BY bucket, tenant_id, point_id
WITH NO DATA
"""

AGG_1H = """
CREATE MATERIALIZED VIEW readings_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '1 hour', bucket) AS bucket,
    tenant_id,
    point_id,
    sum(sample_count)               AS sample_count,
    sum(num_count)                  AS num_count,
    min(num_min)                    AS num_min,
    max(num_max)                    AS num_max,
    -- Reading-weighted, not minute-weighted. See the module docstring.
    sum(num_sum) / nullif(sum(num_count), 0)::double precision AS num_avg,
    sum(num_sum)                    AS num_sum,
    first(num_first, bucket)        AS num_first,
    last(num_last, bucket)          AS num_last,
    sum(txt_count)                  AS txt_count,
    last(txt_last, bucket)          AS txt_last,
    max(quality_max)                AS quality_max
FROM readings_1m
GROUP BY 1, tenant_id, point_id
WITH NO DATA
"""


def upgrade() -> None:
    bind = op.get_bind()

    # CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) cannot run inside
    # a transaction block. Alembic wraps the migration in one, so commit it first
    # and let each statement run on its own.
    bind.execute(text("COMMIT"))

    bind.execute(text(AGG_1M))
    bind.execute(text(AGG_1H))

    # Compress the rollups too — they are the long-lived copy, so they are the
    # ones that accumulate. segmentby point_id mirrors the raw table.
    bind.execute(
        text(
            "ALTER MATERIALIZED VIEW readings_1m SET ("
            "  timescaledb.compress = true,"
            "  timescaledb.compress_segmentby = 'point_id'"
            ")"
        )
    )
    bind.execute(
        text(
            "ALTER MATERIALIZED VIEW readings_1h SET ("
            "  timescaledb.compress = true,"
            "  timescaledb.compress_segmentby = 'point_id'"
            ")"
        )
    )

    # Refresh + compression + retention, from the environment (see module doc).
    # reconcile_policies applies refresh policies BEFORE compression policies,
    # which TimescaleDB 2.17 requires for continuous aggregates.
    reconcile_policies(bind)


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("COMMIT"))
    # Dropping the aggregate drops its policies with it.
    bind.execute(text("DROP MATERIALIZED VIEW IF EXISTS readings_1h"))
    bind.execute(text("DROP MATERIALIZED VIEW IF EXISTS readings_1m"))
