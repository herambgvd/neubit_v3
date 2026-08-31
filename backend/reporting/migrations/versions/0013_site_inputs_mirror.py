"""reporting: mirror the CITY, TARIFF SLABS and EMISSION FACTORS beside site_facts

Revision ID: 0013_site_inputs_mirror
Revises: 0012_unit_provenance_site_facts
Create Date: 2026-08-31

WHAT THIS ADDS AND WHY
----------------------
Building Intelligence's portfolio view shows a city per building, a Time-of-Use
tariff strip and CO2 figures. All three are OPERATOR INPUTS owned by core
(`neubit_control.sites` + migration 0019's `site_tariff_slabs` /
`site_emission_factors`), and this store is banned from reading core's database
(contract §1). So, exactly as `site_facts` mirrors area/tariff/occupancy
(migration 0012, contract §19), this migration gives the remaining inputs a
read-model here:

* ``site_facts.city`` — the human location, resolved by CORE from its own
  `sites.address` json and carried on every site event. Null when the address
  (or its city) was never recorded; BI renders that as an em dash, never a
  guess.
* ``site_tariff_slabs`` — the ToU windows. Core publishes the WHOLE list on
  every site event, so the mirror is a full replace per site (delete+insert)
  and a missed message is corrected by the next site edit of any kind.
* ``site_emission_factors`` — kg CO2/kWh with its REQUIRED source citation,
  mirrored verbatim so a CO2 figure on a BI screen can always say where its
  factor came from.

PK ``(tenant_id, site_id, position)``: mirror rows have no identity of their
own — they are a projection of core's list, replaced wholesale, and the
position is the order core stated.

THESE TABLES SHIP EMPTY and are written only by the reading-writer's
`site_facts_sync` consumer. Every value arrived on an event, having been typed
by an operator into Configurations → Sites → Building. NULL / absent rows mean
NOT RECORDED, never zero and never a default.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0013_site_inputs_mirror"
down_revision = "0012_unit_provenance_site_facts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("site_facts", sa.Column("city", sa.String(255), nullable=True))

    op.create_table(
        "site_tariff_slabs",
        sa.Column("tenant_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        # Minutes since midnight; end < start wraps midnight (22:00 -> 06:00).
        sa.Column("start_minute", sa.Integer(), nullable=False),
        sa.Column("end_minute", sa.Integer(), nullable=False),
        sa.Column("rate_per_kwh", sa.Float(), nullable=False),
        sa.Column("currency", sa.String(8), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column(
            "mirrored_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "site_emission_factors",
        sa.Column("tenant_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("kg_co2_per_kwh", sa.Float(), nullable=False),
        # The citation travels WITH the number. A factor that lost its source
        # in transit would be an uncited figure, so the column is NOT NULL
        # here too.
        sa.Column("source", sa.String(512), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column(
            "mirrored_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("site_emission_factors")
    op.drop_table("site_tariff_slabs")
    op.drop_column("site_facts", "city")
