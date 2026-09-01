"""reporting: WHO said a point's unit, and the site facts a rating divides by

Revision ID: 0012_unit_provenance_site_facts
Revises: 0011_iot_alerts_identity
Create Date: 2026-08-31

TWO THINGS A RATING NEEDS THAT THIS STORE COULD NOT EXPRESS
-----------------------------------------------------------
An energy performance index is ``kWh / m² / year``. That sentence has three
inputs and this platform could state none of them:

1. **A unit per point.** `points.unit` exists but is NULL for all 314 points,
   because the source MQTT payloads carry no `env.u` (contract §11/§12). Worse,
   the column could not tell an OPERATOR'S assertion apart from a value the
   gateway happened to send — so there was no way to say "somebody confirmed
   this is kilowatt-hours" as distinct from "the wire said so" or "nobody knows".
2. **A built-up area per site.** Added on the core side (`sites`, migration
   0018) and mirrored HERE by the reading-writer's site-facts consumer, because
   the platform bans cross-service reads and `neubit_reporting` is where data is
   gathered for querying (contract §1).

(The third input, the BENCHMARK STANDARD, is not a column. See `app/api/rating.py`
— nothing ships a threshold this repository cannot cite.)

`points.unit_source` / `unit_confirmed_at` / `unit_confirmed_by`
----------------------------------------------------------------
`unit_source` is one of:

* ``NULL``       nobody has said. The unit is NULL and the point is UNCONFIRMED.
* ``'reading'``  the value arrived on the wire in `env.u`. Nothing does this on
                 this deployment; the column exists so that the day something
                 does, its provenance is not confused with an operator's.
* ``'operator'`` a human asserted it, through `POST /bi/units/confirm`.

**The tag is never evidence.** `KWH_kwh`, `Freq_Hz`, `VoltL1_V` look like they
carry their unit, and the API DOES offer that reading as a SUGGESTION the
operator confirms — including in bulk over a matched set. What it must never do
is store one silently. This is exactly the mistake §17/§18 record about floor
prefixes: `4F_Solar_Panel01` looks like a floor until `4F-3F AC DB` names two. A
naming convention is a convention. An unconfirmed point keeps a NULL unit and is
counted as unconfirmed.

`'operator'` also makes the writer's COALESCE strictly stronger: a stored unit an
operator asserted is not merely protected from a message that says NOTHING (which
is all `COALESCE(excluded, stored)` gives you), it is protected from a message
that says something DIFFERENT. An operator's assertion being erased by the next
reading is the worst outcome this feature can have.

`site_facts`
------------
A read-model of `neubit_control.sites`, exactly as `device_locations` is a
read-model of `device_placements` (contract §18). Core owns the fact and
publishes it on the sites event spine; this table is how Building Intelligence
joins to it without opening a database it does not own. Every value is nullable
and NULL means NOT RECORDED — the state a rating renders as "cannot rate".
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0012_unit_provenance_site_facts"
down_revision = "0011_iot_alerts_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("points", sa.Column("unit_source", sa.String(16), nullable=True))
    op.add_column(
        "points", sa.Column("unit_confirmed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("points", sa.Column("unit_confirmed_by", sa.String(320), nullable=True))

    op.create_table(
        "site_facts",
        # (tenant, site) is the key: a site id is core's, and this store is
        # tenant-scoped on every read, so the tenant is part of the identity
        # rather than a column that has to be remembered in a WHERE clause.
        sa.Column("tenant_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("site_name", sa.String(255), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        # THE RATING INPUTS. All nullable. NULL is NOT RECORDED and must render
        # as absence — never as zero and never as a default.
        sa.Column("gross_floor_area_sqm", sa.Float(), nullable=True),
        sa.Column("energy_tariff_per_kwh", sa.Float(), nullable=True),
        sa.Column("tariff_currency", sa.String(8), nullable=True),
        sa.Column("occupancy", sa.Integer(), nullable=True),
        # When the OPERATOR last asserted the facts (core's own timestamp,
        # carried on the event), distinct from when this mirror last saw a
        # message. Both matter: the first is provenance, the second is lag.
        sa.Column("facts_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "mirrored_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
    )


def downgrade() -> None:
    op.drop_table("site_facts")
    op.drop_column("points", "unit_confirmed_by")
    op.drop_column("points", "unit_confirmed_at")
    op.drop_column("points", "unit_source")
