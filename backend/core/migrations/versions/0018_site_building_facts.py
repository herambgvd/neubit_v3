"""sites: the BUILDING FACTS a rating needs — area, tariff, occupancy

Revision ID: 0018_site_building_facts
Revises: 0017_permission_registrations
Create Date: 2026-08-31

WHY THESE COLUMNS EXIST
-----------------------
Building Intelligence → Ratings was SOON because an energy performance index is
``kWh / m² / year``, and this platform could not express the ``m²``. Not "did not
know it for this estate" — could not SAY it. `neubit_control.sites` had a name, a
type, an address and a threat level, and nothing about the building as a physical
or commercial thing. Nor did anywhere else: not `floors`, not `zones`, not the
reporting store, not the gateway's device config.

So a rating had no denominator, and the only ways to produce one anyway would
have been to infer an area (there is nothing to infer it from), to default one,
or to substitute a national average — all three of which are the fabrication this
platform's contracts forbid. The honest fix is not a cleverer estimate; it is a
column and a screen where an operator states the fact.

WHY THEY LIVE ON `sites` AND NOT ON A BI SCREEN
-------------------------------------------------
The same reasoning that moved device placement onto the floor plan (pipeline
contract §18): the platform already has ONE place where facts about a site are
recorded and edited — Configurations → Sites. A second surface owning a second
half of "what this building is" is two answers waiting to disagree. Area, tariff
and occupancy are site facts. They belong beside the address.

WHAT EACH ONE IS, AND WHAT IT IS NOT
-------------------------------------
* ``gross_floor_area_sqm`` — the denominator of an EPI. NULLABLE, and null means
  NOT RECORDED. A rating for a site with no area is not computed, not estimated
  and not defaulted: it renders as "no area recorded", with a link to here.
* ``energy_tariff_per_kwh`` + ``tariff_currency`` — what a unit of energy costs
  at this site. Also nullable, also never guessed; without it a cost figure is
  simply absent. The currency is stored beside the number rather than assumed,
  because a bare 8.5 is not a price.
* ``occupancy`` — people the building is designed for / typically holds. It is
  the denominator of a per-occupant figure and an input to some rating schemes;
  it is stated, never derived from access-control counts (which measure a
  different thing on a different day).

``building_facts_updated_at`` / ``_by`` are here because these are an OPERATOR'S
ASSERTIONS, not measurements, and a number a rating divides by should carry who
last stood behind it and when. `updated_at` on the row cannot say that — it moves
when anyone edits a phone number.

NO SERVER DEFAULT ON ANY OF THE THREE VALUES. A default area would be a
fabricated denominator that renders as a real rating, which is the single worst
outcome this feature can have.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018_site_building_facts"
down_revision = "0017_permission_registrations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sites", sa.Column("gross_floor_area_sqm", sa.Float(), nullable=True))
    op.add_column("sites", sa.Column("energy_tariff_per_kwh", sa.Float(), nullable=True))
    op.add_column("sites", sa.Column("tariff_currency", sa.String(8), nullable=True))
    op.add_column("sites", sa.Column("occupancy", sa.Integer(), nullable=True))
    op.add_column(
        "sites", sa.Column("building_facts_updated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("sites", sa.Column("building_facts_updated_by", sa.String(36), nullable=True))


def downgrade() -> None:
    for col in (
        "building_facts_updated_by",
        "building_facts_updated_at",
        "occupancy",
        "tariff_currency",
        "energy_tariff_per_kwh",
        "gross_floor_area_sqm",
    ):
        op.drop_column("sites", col)
