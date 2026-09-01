"""reporting: the dashboard-builder DATASET REGISTRY (builder contract §2)

Revision ID: 0004_dashboard_datasets
Revises: 0003_points_device_class
Create Date: 2026-08-30

The v1 builder queried `readings`/`points` directly and its vocabulary was
IoT-shaped (`scope: points | device | category | all`). It could not chart a
door-access event or a fire panel state, which is the whole reason this table
exists.

A **dataset** is a queryable relation in `neubit_reporting` plus the metadata the
builder needs to ask honest questions of it: a time column, dimensions,
measures, which aggregates each measure permits, the rollup relations that stand
in for it over a wide window, and the permission needed to read it.

WHY A TABLE AND NOT A PYTHON MODULE
-----------------------------------
Contract §2: "Registration is data, not code. A new domain must not require a
builder release." A python dict of dataset definitions would mean VMS, access
control and fire each ship a change to the reading-writer before their data is
chartable — and that is precisely the coupling this phase exists to remove. A
domain that publishes into the reporting store registers itself with one INSERT.

The IoT readings dataset is seeded here and is NOT special-cased anywhere in the
executor: it goes through the same loader, the same validator and the same SQL
generator as a dataset inserted five minutes ago.

SAFETY
------
`definition` is trusted-ish data (it names relations and columns in a database
the platform owns), but it is still validated on load: every identifier in it is
checked against `^[A-Za-z_][A-Za-z0-9_]*$` before it is quoted into SQL, and the
aggregate mapping is a closed vocabulary of function names, never a SQL snippet.
A dataset row that fails validation is DROPPED from the listing with a logged
reason rather than being half-served — see `app/api/registry.py`.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_dashboard_datasets"
down_revision = "0003_points_device_class"
branch_labels = None
depends_on = None


# The physical column each (measure, aggregate) pair reads, per relation. The
# rollups carry `num_sum` explicitly, which is what makes `sum` — energy
# consumption — answerable at all; the v1 builder had no `sum` and so could not
# chart consumption honestly.
#
# `avg` on a rollup is a RATIO (sum(num_sum) / sum(num_count)), not avg(num_avg):
# averaging the bucket averages would weight a bucket holding two samples the
# same as one holding sixty, which on a feed whose devices report at different
# rates is simply the wrong number. The `ratio` form exists in the generator's
# closed function vocabulary for exactly this.
_ROLLUP_VALUE = {
    "avg": {
        "fn": "ratio",
        "numerator": {"fn": "sum", "column": "num_sum"},
        "denominator": {"fn": "sum", "column": "num_count"},
    },
    "sum": {"fn": "sum", "column": "num_sum"},
    "min": {"fn": "min", "column": "num_min"},
    "max": {"fn": "max", "column": "num_max"},
    "count": {"fn": "sum", "column": "num_count"},
    "first": {"fn": "first", "column": "num_first"},
    "last": {"fn": "last", "column": "num_last"},
}

_RAW_VALUE = {
    "avg": {"fn": "avg", "column": "num"},
    "sum": {"fn": "sum", "column": "num"},
    "min": {"fn": "min", "column": "num"},
    "max": {"fn": "max", "column": "num"},
    "count": {"fn": "count", "column": "num"},
    "first": {"fn": "first", "column": "num"},
    "last": {"fn": "last", "column": "num"},
}

IOT_DEFINITION = {
    "tenant_column": "tenant_id",
    # The stores that can answer, narrowest grain first. `max_window_minutes` on
    # `raw` is the honesty rule made data: asking for raw over a wider window is
    # an error naming the rollup to use, never a silent downgrade.
    "relations": [
        {
            "key": "raw",
            "relation": "readings",
            "time_column": "ts",
            "grain_sec": 0,
            "max_window_minutes": 180,
            "reason": "raw readings (bounded window) — every sample, no aggregation",
        },
        {
            "key": "1m",
            "relation": "readings_1m",
            "time_column": "bucket",
            "grain_sec": 60,
            "reason": (
                "1-minute rollup (readings_1m); materialized-only, so the newest "
                "~2 minutes may not be included yet"
            ),
        },
        {
            "key": "1h",
            "relation": "readings_1h",
            "time_column": "bucket",
            "grain_sec": 3600,
            "reason": (
                "1-hour rollup (readings_1h); real-time aggregate, current hour included"
            ),
        },
    ],
    # How `resolution=auto` picks. First rule whose window ceiling holds wins;
    # the last rule has no ceiling and is the fallback. Raw is never chosen
    # automatically — a caller has to ask for it.
    "auto": [{"max_hours": 3, "relation": "1m"}, {"relation": "1h"}],
    "joins": [
        {
            "key": "points",
            "relation": "points",
            "type": "left",
            "on": [["point_id", "point_id"]],
        }
    ],
    "dimensions": [
        {"key": "point_id", "label": "Point", "source": "base", "column": "point_id", "type": "uuid"},
        {"key": "point_tag", "label": "Point name", "source": "points", "column": "point_tag", "type": "text"},
        {"key": "device_id", "label": "Device", "source": "points", "column": "device_id", "type": "uuid"},
        {"key": "device_tag", "label": "Device name", "source": "points", "column": "device_tag", "type": "text"},
        {"key": "category", "label": "Category", "source": "points", "column": "category", "type": "text"},
        {"key": "device_type", "label": "Device type", "source": "points", "column": "device_type", "type": "text"},
        {"key": "reading_kind", "label": "Reading kind", "source": "points", "column": "type", "type": "text"},
    ],
    "measures": [
        {
            "key": "value",
            "label": "Reading value",
            "type": "number",
            "aggregates": ["avg", "sum", "min", "max", "first", "last", "count"],
            # THE honesty rule, generalised (contract §4). Averaging a power
            # factor with a voltage is meaningless, so a value aggregate must be
            # pinned to one series — grouped by a point, or filtered to one.
            # `unit` is NULL for every point on this deployment because the source
            # payloads carry none; nothing here invents one.
            "comparable": False,
            "comparable_within": ["point_id", "point_tag"],
            "incomparable_hint": (
                "values from different points are not comparable — no unit is on "
                "the wire. Group by Point, or chart Samples instead."
            ),
            "physical": {"raw": _RAW_VALUE, "1m": _ROLLUP_VALUE, "1h": _ROLLUP_VALUE},
        },
        {
            "key": "samples",
            "label": "Samples",
            "type": "number",
            # A COUNT of readings is the one quantity that IS comparable across
            # differently-measured points — the same reasoning `/bi/activity` uses.
            "aggregates": ["sum"],
            "comparable": True,
            "physical": {
                "raw": {"sum": {"fn": "count_star"}},
                "1m": {"sum": {"fn": "sum", "column": "sample_count"}},
                "1h": {"sum": {"fn": "sum", "column": "sample_count"}},
            },
        },
    ],
    # What the builder offers as a default series split and label column.
    "defaults": {
        "series_by": "point_id",
        "label_dimension": "point_tag",
        "measure": "value",
        "aggregate": "avg",
    },
}


def upgrade() -> None:
    op.create_table(
        "dashboard_datasets",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        # The permission a caller must hold to read this dataset. Pushed into
        # core's permission catalog so a role can actually GRANT it — the bug not
        # to repeat is ingest.read/ingest.manage, gated by the backend and never
        # registered, so only a wildcard admin could reach Ingest.
        sa.Column("permission", sa.String(128), nullable=False),
        sa.Column("permission_label", sa.String(200), nullable=False, server_default=""),
        sa.Column(
            "permission_group", sa.String(80), nullable=False, server_default="Dashboard datasets"
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("definition", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.execute(
        sa.text(
            """
            INSERT INTO dashboard_datasets
                (key, name, description, permission, permission_label,
                 permission_group, enabled, definition)
            VALUES
                ('iot_readings',
                 'IoT readings',
                 'Sensor and meter readings published by the gateway: energy, HVAC, '
                 'water and anything else conflux classifies. Charts read the 1-minute '
                 'or 1-hour rollup; raw is available inside a 3-hour window.',
                 'bi.read',
                 'View building intelligence (energy / HVAC / water readings)',
                 'Building Intelligence',
                 true,
                 CAST(:definition AS jsonb))
            """
        ).bindparams(definition=json.dumps(IOT_DEFINITION))
    )


def downgrade() -> None:
    op.drop_table("dashboard_datasets")
