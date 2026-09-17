"""reporting: record WHICH GATEWAY delivered an alert

Revision ID: 0021_iot_alerts_gateway
Revises: 0020_ccei_carbon_intensity
Create Date: 2026-09-17

WHY THIS CANNOT BE DERIVED
--------------------------
`iot_alerts.conn_id` already says which connection raised a fault, and a
connection lives on exactly one gateway — so it looks as though the gateway is
a join away and needs no column. It is not, for one reason: **the connection ->
gateway mapping is not stable over time.**

Conflux HA promotes a standby by importing the primary's configuration
wholesale. The survivor comes up carrying the SAME connection, device and point
ids under a DIFFERENT gateway id. A live lookup against a fleet registry
therefore answers "who owns this connection now", which is not the question an
operator asks of a fault. They ask "what was carrying this when it fired", and
that can only be recorded at the moment it fires.

So the gateway rides on the alert wire (conflux
`edge/internal/publish/nats.go`, `alertPayload.GatewayID`) and lands here.

WHY READINGS DO NOT GET THE SAME TREATMENT
------------------------------------------
Pipeline contract §5 lists "gateway" among the things that belong in the
`points` dimension and NOT on a reading row, and that judgement stands: this
database holds 460k readings against 73 alerts. Paying ~40 bytes per reading for
an attribute that changes approximately never is the trade §5 already refused.
Readings get their gateway from `points.gateway_id`, filled by the fleet sync,
which answers "who owns it now" — the correct question for a live inventory.

The asymmetry is deliberate and is the whole design: **facts that must stay true
about the past ride on the wire; inventory that describes the present is
synced.**

A COLUMN AND AN INDEX, DELIBERATELY NOT A DIMENSION
---------------------------------------------------
0011 registered `device_category` and `device_type` as dimensions and kept
`device_id`/`point_id` as plain columns, on cardinality grounds: a uuid per
device would force the hourly rollup's GROUP BY to approach a copy of the fact
table.

`gateway_id` fails that test for a different reason and passes the cardinality
one easily — a deployment has a handful of gateways, so grouping by it would not
bloat the rollup at all. It is left unregistered because **its values are raw
uuids and nothing on this platform can yet turn one into a name.** A dimension
whose dropdown lists `8f1d0e2a-…` is a dimension no operator can use.

The gateway registry that supplies those names arrives with the fleet sync. When
it does, registering this as a dimension is a spec UPDATE and no DDL, because
the column and its index are already here. That is the point of splitting it
this way rather than waiting.

THE COALESCE RULE STILL GOVERNS
-------------------------------
`gateway_id` is `omitempty` on the wire, like every other optional field on this
payload (contract §11). An alert buffered in conflux's outbox before this
existed replays without it, and the projection's `on_conflict: "enrich"` — set
by 0011 — already renders that as COALESCE. Missing never clobbers.

NO AGGREGATE REBUILD
--------------------
0011 had to drop `iot_alerts_1h` because it added GROUP BY columns and a
continuous aggregate's SELECT list is fixed at creation. This migration adds no
GROUP BY column, so the aggregate is untouched and no dashboard blinks.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0021_iot_alerts_gateway"
down_revision = "0020_ccei_carbon_intensity"
branch_labels = None
depends_on = None


NEW_COLUMN = {
    "name": "gateway_id",
    "type": "uuid",
    "source": "payload.gateway_id",
}

# Alerts are read newest-first and, once the console can drill into a gateway,
# "this gateway's faults" is the query. Leading with gateway_id and trailing
# with ts serves both that filter and its ordering from one index.
NEW_INDEX = {"name": "ix_iot_alerts_gateway_ts", "columns": ["gateway_id", "ts"]}

# The old description explained the category fields and said nothing about
# provenance. A reader of this dataset needs to know that the gateway here is
# the one that DELIVERED the alert, because that is the claim the column makes
# and the one case where it differs from "raised" is not obvious.
NEW_DESCRIPTION = (
    "Alerts raised by the gateway's rule engine and its comms watchdog: "
    "out-of-range values, poll failures, stale points and recoveries. Charts read "
    "the 1-hour rollup; raw is available inside a 48-hour window. Each alert "
    "carries the device's category and type, so a fault is attributable to energy "
    "vs hvac vs water without a lookup — but an alert older than that wire change, "
    "or one from an unclassified device, has none and renders as absent rather "
    "than as a guess. It also carries the id of the gateway that DELIVERED it, "
    "which is the one that raised it except after an HA promotion, when a replayed "
    "alert is attributed to the survivor. Alerts carry no unit: this dataset "
    "counts events and never converts them."
)


def _patch(spec: dict) -> dict:
    target = spec["target"]

    if not any(c["name"] == NEW_COLUMN["name"] for c in target["columns"]):
        target["columns"].append(dict(NEW_COLUMN))

    if not any(i["name"] == NEW_INDEX["name"] for i in target.setdefault("indexes", [])):
        target["indexes"].append(dict(NEW_INDEX))

    # 0011 set this; assert it rather than assume, because the COALESCE
    # behaviour is what makes a replay safe for the column being added here.
    target["on_conflict"] = "enrich"

    dataset = spec.get("dataset") or {}
    if dataset:
        dataset["description"] = NEW_DESCRIPTION

    return spec


def _load(conn):
    row = conn.execute(
        sa.text("SELECT spec FROM reporting_projections WHERE key = 'iot_alerts'")
    ).first()
    if row is None:
        return None
    return row[0] if isinstance(row[0], dict) else json.loads(row[0])


def _save(conn, spec: dict) -> None:
    conn.execute(
        sa.text(
            "UPDATE reporting_projections "
            "   SET spec = CAST(:spec AS jsonb), updated_at = now() "
            " WHERE key = 'iot_alerts'"
        ).bindparams(spec=json.dumps(spec))
    )


def upgrade() -> None:
    conn = op.get_bind()
    spec = _load(conn)
    if spec is None:
        # 0007 inserts it. A deployment that deliberately deleted the projection
        # should not have it resurrected by a migration whose job is to widen one.
        return
    _save(conn, _patch(spec))


def downgrade() -> None:
    """Unregister the column. The column itself stays.

    Same rule as 0011: dropping it would destroy values the gateway published
    and this migration never wrote, and the projector never drops a column.
    Taking it out of the spec is enough to make it stop being maintained.
    """
    conn = op.get_bind()
    spec = _load(conn)
    if spec is None:
        return
    spec["target"]["columns"] = [
        c for c in spec["target"]["columns"] if c["name"] != NEW_COLUMN["name"]
    ]
    spec["target"]["indexes"] = [
        i for i in spec["target"].get("indexes") or [] if i["name"] != NEW_INDEX["name"]
    ]
    _save(conn, spec)
