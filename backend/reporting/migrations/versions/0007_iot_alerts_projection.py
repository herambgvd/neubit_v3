"""reporting: PROJECT THE IoT ALERTS the platform has been dropping since Phase C

Revision ID: 0007_iot_alerts_projection
Revises: 0006_points_retire
Create Date: 2026-08-31

WHAT WAS MISSING
----------------
The gateway has raised alerts since it had a rule engine, and it has published
them onto the spine since Phase C:

    tenant.{tenant}.iot.alert.{conn_id}
    {tenant_id, domain:"iot", event:"alert",
     payload:{conn_id, alert:{id,type,severity,src:{proto,conn,dev,addr},
                              message,ts,acked}}}

`IOT_READINGS` captures them (its subject list is `tenant.*.iot.>`), so they are
durable and replayable — and **nothing consumed them**. The reading-writer's
consumer filter deliberately excludes them (pipeline contract §10.4: alerts are
events, not measurements, and have no row in `readings`), and no other consumer
existed. So `neubit_reporting` had no alerts table at all: Building Intelligence
could say what a value IS and never what WENT WRONG.

Measured on this deployment before this revision: 19 alert messages held in
`IOT_READINGS`, 0 rows anywhere.

WHY THIS IS AN INSERT AND NOT A SERVICE
---------------------------------------
Because the projector already exists and consuming a subject into a relation is
what it does (builder contract §9). A projection is ONE row of
`reporting_projections`: the subject, the target relation and its columns, the
rollups, and the `dashboard_datasets` row to publish. Alerts need no code — they
need the recipe below.

Note the one thing this projection does that the access one does not: it reads
from **`IOT_READINGS`**, not `EVENTS`. The alert subject is `tenant.*.iot.alert.*`
and `tenant.*.iot.>` belongs to the IoT stream (contract §4 — the two streams may
not overlap). `spec.Source.stream` was already a field; nothing had used it.

THE BODY IS NOT THE PLATFORM ENVELOPE, AND THAT IS FINE
-------------------------------------------------------
Every projection so far consumed `kernel.events.envelope`
(`{event_id, tenant_id, type, occurred_at, source, payload}`). The gateway's is
the IoT event body (`{tenant_id, domain, event, payload}`) with conflux's own
alert nested inside `payload.alert`. The projector never assumed otherwise: a
column declares a DOTTED PATH into whatever was decoded, so `payload.alert.src.dev`
is just a path. This is the first projection to prove that, and it is worth
saying out loud — the projector is a bus→table mapper, not an envelope parser.

WHAT IS DELIBERATELY *NOT* A COLUMN
-----------------------------------
* **`acked`.** It is on the wire and it is ALWAYS `false`: an alert is published
  the moment it is raised, and acknowledging one is a store-only mutation in the
  gateway (`AckAlertScoped`) that publishes nothing. A column that can only ever
  hold one value would invite exactly the metric the mockup wants and cannot
  have — mean time to acknowledge — and MTTA computed from a column that is
  false by construction is a number nobody measured (builder contract §4). When
  the gateway publishes an ack event, that is a second projection or an added
  column; it is not something to fake now.

* **the device's CATEGORY.** `payload.alert` carries `src.{proto,conn,dev,addr}`
  and nothing about what the device IS. The reading payload gained
  `device_category`/`device_type` in Phase D but the alert payload did not, even
  though the gateway's `raiseAlert` already holds a `model.Origin` that carries
  both. So an alert can be grouped by device, connection and point address —
  never by `energy` vs `hvac`. That is a gateway gap with a known one-line shape
  (add the two `omitempty` fields to `alertPayload`, exactly as Phase D did for
  readings); until it is closed, this dataset must not claim a domain it was not
  told.

WHAT THE NATURAL KEY IS
-----------------------
`(alert_id, ts)` — the GATEWAY's own alert uuid (`payload.alert.id`, minted in
`raiseAlert` and persisted in conflux's store before publishing) plus the event
time. Replay on a durable consumer is normal, and re-delivering an alert must be
a no-op, not a duplicate row.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0007_iot_alerts_projection"
down_revision = "0006_points_retire"
branch_labels = None
depends_on = None


IOT_ALERTS_SPEC = {
    "source": {
        # IOT_READINGS, not EVENTS. `tenant.*.iot.>` is the IoT stream's subject
        # list; EVENTS explicitly does not include the iot domain, and the two
        # streams may not overlap (pipeline contract §4).
        "stream": "IOT_READINGS",
        # `tenant.*.iot.alert.*` — exactly the alert subject shape
        # (`…iot.alert.{conn_id}`), which cannot also match a reading
        # (`…iot.reading.{conn}.{device}.{point}`). A `>` here would swallow the
        # entire reading feed into this table.
        "subject": "tenant.*.iot.alert.*",
        "durable": "reporting-projector-iot-alerts",
    },
    "target": {
        "relation": "iot_alerts",
        "time_column": "ts",
        "natural_key": ["alert_id", "ts"],
        "chunk_interval": "7 days",
        "retention": "1825 days",
        "columns": [
            # The alert's OWN timestamp, epoch seconds, as the gateway stamped it
            # when the rule fired. Not the publish time and not now(): an alert
            # replayed from the outbox minutes later must keep when it happened.
            {"name": "ts", "type": "timestamptz", "source": "payload.alert.ts",
             "required": True},
            # `tenant` → run it through the tenant resolver. The gateway publishes
            # the literal key `default`, which is not a uuid; see
            # `VE_PROJECTOR_TENANT_MAP` and the note in the pipeline contract.
            {"name": "tenant_id", "type": "uuid", "source": "tenant_id",
             "tenant": True, "required": True},
            {"name": "alert_id", "type": "uuid", "source": "payload.alert.id",
             "required": True},
            {"name": "conn_id", "type": "uuid", "source": "payload.conn_id"},
            # conflux's ALERT TYPE: comm_fail | range | stale | recovered | rule.
            # `type` is a reserved-ish word and `points.type` already means
            # something else in this database, so it is spelled out.
            {"name": "alert_type", "type": "text", "source": "payload.alert.type"},
            {"name": "severity", "type": "text", "source": "payload.alert.severity"},
            # The connection's SLUG — its frozen wire identity, so it survives a
            # rename in the gateway UI.
            {"name": "conn_slug", "type": "text", "source": "payload.alert.src.conn"},
            {"name": "proto", "type": "text", "source": "payload.alert.src.proto"},
            {"name": "device_tag", "type": "text", "source": "payload.alert.src.dev"},
            # The point's source address (`aeonhwj/4F Khem Chiller01/IWT`). It is
            # the only thing on the alert that identifies WHICH measurement
            # faulted — there is no point_id on the wire.
            {"name": "point_addr", "type": "text", "source": "payload.alert.src.addr"},
            # Free text, and it carries the measured value
            # ("CAvg_A at 113.46 A — above 100 A"). Stored for the raw table, which
            # is where a forensic question is asked over a bounded window. NOT a
            # registered dimension and NOT in the rollup's GROUP BY: it is
            # effectively unique per alert, and grouping by it would make the
            # rollup a copy of the fact table.
            {"name": "message", "type": "text", "source": "payload.alert.message"},
        ],
        "indexes": [
            {"name": "ix_iot_alerts_tenant_ts", "columns": ["tenant_id", "ts"]},
            {"name": "ix_iot_alerts_device_ts", "columns": ["device_tag", "ts"]},
        ],
    },
    # One rollup, for the same reason access has one: a rule engine fires at human
    # rates, not sensor rates, so an hourly bucket makes a month-wide chart cheap
    # and a finer one would earn nothing. Raw answers anything inside 48 hours and
    # REFUSES a wider window by name.
    "rollups": [
        {
            "key": "1h",
            "relation": "iot_alerts_1h",
            "bucket": "1 hour",
            "time_column": "bucket",
            # Every registered `base` dimension must be a GROUP BY column here —
            # the registry has one dimension list for all of a dataset's
            # relations, so a dimension the rollup lacks would generate SQL naming
            # a column that does not exist in it.
            "group_by": [
                "tenant_id", "severity", "alert_type",
                "device_tag", "conn_slug", "point_addr", "proto",
            ],
            "aggregates": [{"name": "alert_count", "fn": "count_star"}],
            "real_time": True,
            "refresh": {"start_offset": "7 days", "end_offset": "1 hour",
                        "schedule_interval": "5 minutes"},
            "retention": "1825 days",
        }
    ],
    "dataset": {
        "name": "IoT faults & alerts",
        "description": (
            "Alerts raised by the gateway's rule engine and its comms watchdog: "
            "out-of-range values, poll failures, stale points and recoveries. "
            "Charts read the 1-hour rollup; raw is available inside a 48-hour "
            "window. Alerts carry no unit and no device category — the wire does "
            "not say — so this dataset counts events and never converts them."
        ),
        # Deliberately `bi.read` rather than a key of its own. A separate
        # permission that no role holds would hide the FAULTS from exactly the
        # people who can already see the readings that caused them, and an alert
        # discloses nothing the reading store does not. Access events got their
        # own key because they are another service's data about people.
        "permission": "bi.read",
        "permission_label": "View building intelligence (energy / HVAC / water readings)",
        "permission_group": "Building Intelligence",
        "definition": {
            "tenant_column": "tenant_id",
            "relations": [
                {
                    "key": "raw",
                    "relation": "iot_alerts",
                    "time_column": "ts",
                    "grain_sec": 0,
                    "max_window_minutes": 2880,
                    "reason": (
                        "raw alerts (bounded 48-hour window) — every alert, no aggregation"
                    ),
                },
                {
                    "key": "1h",
                    "relation": "iot_alerts_1h",
                    "time_column": "bucket",
                    "grain_sec": 3600,
                    "reason": (
                        "1-hour rollup (iot_alerts_1h); real-time aggregate, "
                        "current hour included"
                    ),
                },
            ],
            "auto": [{"max_hours": 6, "relation": "raw"}, {"relation": "1h"}],
            "joins": [],
            "dimensions": [
                {"key": "severity", "label": "Severity", "source": "base",
                 "column": "severity", "type": "text"},
                {"key": "alert_type", "label": "Alert type", "source": "base",
                 "column": "alert_type", "type": "text"},
                {"key": "device_tag", "label": "Device name", "source": "base",
                 "column": "device_tag", "type": "text"},
                {"key": "conn_slug", "label": "Connection", "source": "base",
                 "column": "conn_slug", "type": "text"},
                {"key": "point_addr", "label": "Point address", "source": "base",
                 "column": "point_addr", "type": "text"},
                {"key": "proto", "label": "Protocol", "source": "base",
                 "column": "proto", "type": "text"},
            ],
            "measures": [
                {
                    "key": "alerts",
                    "label": "Alerts",
                    "type": "number",
                    "aggregates": ["sum"],
                    # A COUNT of alerts is the same quantity everywhere and
                    # carries no unit to invent, so it is comparable across
                    # devices, severities and connections.
                    "comparable": True,
                    "physical": {
                        "raw": {"sum": {"fn": "count_star"}},
                        "1h": {"sum": {"fn": "sum", "column": "alert_count"}},
                    },
                },
                {
                    "key": "devices",
                    "label": "Devices affected",
                    "type": "number",
                    "aggregates": ["count_distinct"],
                    "comparable": True,
                    # Correct on the rollup too, and only because `device_tag` is
                    # one of its GROUP BY columns: the distinct set over rollup
                    # rows is the distinct set over raw rows.
                    "physical": {
                        "raw": {"count_distinct": {"fn": "count_distinct",
                                                   "column": "device_tag"}},
                        "1h": {"count_distinct": {"fn": "count_distinct",
                                                  "column": "device_tag"}},
                    },
                },
            ],
            "defaults": {
                "series_by": "severity",
                "label_dimension": "severity",
                "measure": "alerts",
                "aggregate": "sum",
            },
        },
    },
}


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            INSERT INTO reporting_projections (key, name, description, enabled, spec)
            VALUES ('iot_alerts',
                    'IoT faults & alerts',
                    'Gateway rule-engine and comms alerts published on '
                    'tenant.*.iot.alert.*, projected into a hypertable plus an hourly '
                    'rollup. Consumes IOT_READINGS, not EVENTS.',
                    true,
                    CAST(:spec AS jsonb))
            ON CONFLICT (key) DO UPDATE
               SET spec = EXCLUDED.spec,
                   name = EXCLUDED.name,
                   description = EXCLUDED.description,
                   updated_at = now()
            """
        ).bindparams(spec=json.dumps(IOT_ALERTS_SPEC))
    )


def downgrade() -> None:
    # The registry row goes; the projected relations do NOT. The projector's DDL
    # is additive-only by design and dropping a hypertable of real faults from a
    # downgrade path would destroy data a migration never wrote.
    op.execute(sa.text("DELETE FROM dashboard_datasets WHERE key = 'iot_alerts'"))
    op.execute(sa.text("DELETE FROM reporting_projections WHERE key = 'iot_alerts'"))
