"""reporting: an alert can be acknowledged now

Revision ID: 0023_iot_alerts_ack
Revises: 0022_points_gateway
Create Date: 2026-09-18

WHAT WAS MISSING, AND WHY NOBODY NOTICED
----------------------------------------
`iot_alerts` had no acknowledgement at all, and the fault queue that reads it
said so in its own comments: *"There is no MTTA, no time to acknowledge, no
open/closed split. `alert.acked` is on the wire and is ALWAYS false: an alert is
published the instant it is raised, and acknowledging one is a store-only
mutation inside the gateway that publishes nothing at all."*

That was exactly right, and it is why the console was honest rather than wrong.
Both halves are fixed now: the gateway republishes an alert when its
acknowledgement changes (conflux `api.republishAlert` →
`engine.RepublishAlert`), and this is the column that receives it.

TWO COLUMNS, AND THE DIFFERENCE MATTERS
---------------------------------------
``ack_state``   text, "acked" or "open". THE TRUTH about the alert now.
``acked_at``    timestamptz, LAST acknowledged at. History, and never cleared.

They are allowed to disagree, and the disagreement is a real state: an alert
acknowledged at 14:02 and reopened at 14:40 has `ack_state = 'open'` and
`acked_at = 14:02`, which reads as "somebody closed this and somebody reopened
it". Reading `acked_at IS NOT NULL` as "acknowledged" is therefore wrong, and
that is deliberate — the two facts are separate because operators ask about
both.

WHY NOT A BOOLEAN, WHICH IS THE OBVIOUS THING
---------------------------------------------
Because of replay, and this is the whole reason the wire is shaped the way it
is.

The projection upserts with ENRICH: a field a message does not carry leaves the
stored one alone, a field it does carry wins (0011, contract §12). A boolean
would be present on EVERY message including a raise. So an alert raised at
14:00, acknowledged at 14:02, whose original publish was sitting in the
gateway's outbox and replayed at 14:05, would arrive carrying `acked: false`
and silently reopen an alert somebody had closed. Nothing would report it.

So the gateway omits `ack_state` entirely on a raise and sends it only on a
republish that exists BECAUSE the acknowledgement changed. Absent means "no
opinion", COALESCE keeps what is stored, and a replayed raise cannot reopen
anything. An explicit "open" still travels, so un-acknowledging works.

WHAT THIS UNBLOCKS
------------------
An open/closed split and a time-to-acknowledge on the fault queue, and — the
larger one — IoT alerts becoming eligible for the incident workflow at all.
A cross-domain queue cannot adopt an alert it can never mark as handled.

NOT A DIMENSION. `ack_state` is low cardinality and would group cleanly, but it
is MUTABLE: an alert moves between states after it is written. Registering it
would put it in the hourly rollup's GROUP BY, and a rollup bucket computed
before an acknowledgement would disagree with one computed after, with no way
to tell which is current. Filters read the fact table for this.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0023_iot_alerts_ack"
down_revision = "0022_points_gateway"
branch_labels = None
depends_on = None


NEW_COLUMNS = [
    {"name": "ack_state", "type": "text", "source": "payload.ack_state"},
    # The gateway sends epoch SECONDS (contract §3). The projector's timestamptz
    # coercion handles the scale, the same way it does for `ts`.
    {"name": "acked_at", "type": "timestamptz", "source": "payload.alert.ackedAt"},
]

# "Everything still open", newest first — the fault queue's only query.
NEW_INDEX = {"name": "ix_iot_alerts_ack_state_ts", "columns": ["ack_state", "ts"]}

NEW_DESCRIPTION = (
    "Alerts raised by the gateway's rule engine and its comms watchdog: "
    "out-of-range values, poll failures, stale points and recoveries. Charts read "
    "the 1-hour rollup; raw is available inside a 48-hour window. Each alert "
    "carries the device's category and type, so a fault is attributable to energy "
    "vs hvac vs water without a lookup — but an alert older than that wire change, "
    "or one from an unclassified device, has none and renders as absent rather "
    "than as a guess. It also carries the id of the gateway that DELIVERED it, "
    "which is the one that raised it except after an HA promotion, when a replayed "
    "alert is attributed to the survivor. `ack_state` is what the alert IS now and "
    "`acked_at` is when it was LAST acknowledged; they disagree on an alert that "
    "was closed and reopened, which is a real state and not an error. An alert "
    "with no `ack_state` predates the acknowledgement wire and is not known to be "
    "either. Alerts carry no unit: this dataset counts events and never converts "
    "them."
)


def _patch(spec: dict) -> dict:
    target = spec["target"]

    have = {c["name"] for c in target["columns"]}
    for col in NEW_COLUMNS:
        if col["name"] not in have:
            target["columns"].append(dict(col))

    if not any(i["name"] == NEW_INDEX["name"] for i in target.setdefault("indexes", [])):
        target["indexes"].append(dict(NEW_INDEX))

    # Set by 0011 and asserted rather than assumed: COALESCE is what makes an
    # absent ack_state leave the stored one alone, which is the only thing
    # stopping a replayed raise from reopening a closed alert.
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
        return
    _save(conn, _patch(spec))


def downgrade() -> None:
    """Unregister the columns. The columns themselves stay — same rule as 0011
    and 0021: dropping one would destroy values the gateway published and this
    migration never wrote."""
    conn = op.get_bind()
    spec = _load(conn)
    if spec is None:
        return
    names = {c["name"] for c in NEW_COLUMNS}
    spec["target"]["columns"] = [c for c in spec["target"]["columns"] if c["name"] not in names]
    spec["target"]["indexes"] = [
        i for i in spec["target"].get("indexes") or [] if i["name"] != NEW_INDEX["name"]
    ]
    _save(conn, spec)
