"""reporting: which GATEWAY a point arrives through

Revision ID: 0022_points_gateway
Revises: 0021_iot_alerts_gateway
Create Date: 2026-09-17

THE HOLE THIS FILLS
-------------------
`points` has carried `conn_id` since the baseline — the conflux CONNECTION a
point arrives on. It has never carried the gateway behind that connection,
because until now the platform had no way to learn one: the readings wire does
not say (contract §23, and deliberately so), and there was no channel on which
to ask.

The consequence is a console that cannot be built. The IoT drill-down is
Gateways → Connections → Devices → Points. Levels three and four are this table.
Levels one and two now come from conflux's fleet API. Nothing joined them, so
"show me everything this gateway is measuring" had no query.

One column closes it: given `points.gateway_id`, every level below a gateway is
a filter on a table this database already holds.

WHERE THE VALUE COMES FROM, AND WHY NOT THE WIRE
-------------------------------------------------
Filled by the fleet sync (`app/fleet_sync.py`), which reads conflux's fleet
inventory — each gateway with the connections inside it — and stamps the
gateway onto every point of each connection.

Deliberately NOT from the reading payload. §23 settled that split and it holds
here: a reading is a hot path carrying 460k rows, the gateway is an attribute
that changes approximately never, and §5 already put "gateway" in this dimension
rather than on the fact. What the wire DOES carry is the gateway on an ALERT,
because an alert is a statement about a moment that must stay true afterwards,
and the connection→gateway mapping is not stable across an HA promotion.

So this column answers "who owns this point NOW", and `iot_alerts.gateway_id`
answers "who was carrying it THEN". They are allowed to disagree, and when they
do, both are right.

WHAT THIS DOES NOT DO: RETIRE ANYTHING
--------------------------------------
The plan for this phase said the sync would also retire points whose connection
had disappeared from the gateway. It does not, and should not.

0006 already built retirement with TWO ways in, and the first of them covers
this case better than a sync could: a HORIZON, applied at query time, on
`last_seen_at` older than `VE_READINGS_RETIRE_AFTER_DAYS`. It needs no operator,
it writes nothing, and it SELF-HEALS — a point that starts reporting again is
live again the moment a reading lands.

A sync-driven retire would be a third way in, and a worse one: it would fire on
"conflux did not mention this connection", which is also what a gateway being
rebuilt, migrated, or temporarily offline looks like. That is precisely the
failure this deployment already hit — a laptop was off, and a connection that
was merely unreachable looked deleted. The horizon rides that out. An
authoritative retire would not.

The sync therefore only ever ENRICHES: it sets a gateway where it knows one and
never clears one it does not.

NULLABLE, NO BACKFILL
---------------------
NULL is the honest value: this point's gateway is not known yet. Every existing
row is NULL until the first sync runs, and a point on a gateway that has never
reported an inventory stays NULL rather than being guessed from its connection.

NOT REGISTERED AS A DIMENSION
-----------------------------
Same reasoning as 0021: the values are raw uuids and nothing here can turn one
into a name yet. The index is what makes the drill-down query fast; registering
a dimension of uuids would only put uuids in a dropdown.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0022_points_gateway"
down_revision = "0021_iot_alerts_gateway"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "points",
        sa.Column("gateway_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    # The drill-down's query is "this tenant's points on this gateway", and the
    # tenant is the first filter on every query in this database.
    op.create_index("ix_points_tenant_gateway", "points", ["tenant_id", "gateway_id"])


def downgrade() -> None:
    op.drop_index("ix_points_tenant_gateway", table_name="points")
    op.drop_column("points", "gateway_id")
