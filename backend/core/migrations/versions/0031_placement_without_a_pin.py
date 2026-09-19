"""A device may belong to a BUILDING without being pinned to a floor plan

Revision ID: 0031_placement_without_a_pin
Revises: 0030_audit_log_tenant_ts
Create Date: 2026-09-19

WHAT WAS UNSAYABLE
------------------
`device_placements` required `floor_id` AND `floor_position`. A placement and a
PIN were therefore the same row, and the only way to make one was to open
Configurations → Sites → the floor-plan editor and drag the device onto a drawing
at `{x, y, rotation}`.

That is a reasonable contract for a camera, which is what the table was ported
for: a camera's coverage cone is meaningless without coordinates. It is the wrong
contract for everything else on the estate. A meter plainly belongs to a building
whether or not anyone has uploaded that building's floor plan, and Building
Intelligence asks for the BUILDING: EPI is kWh per square metre of a building,
and every rating, every portfolio row and every site comparison divides by a
site's area. The drawing answers a different and rarer question — WHERE ON THE
STOREY — and it is needed for that question and for nothing else.

The cost of conflating them was measured on the live estate rather than guessed:
the great majority of live points belonged to no site at all, and could not be
made to, because there is one site and almost no floor plans. `points.site_id` is
derived from `device_locations`, which is mirrored from THIS table, so the
requirement for a drawing propagated all the way to the top of the pipeline and
shut the gate that asks whether a reading belongs to a place.

`neubit_reporting.device_locations` had already reached this conclusion and said
so in migration 0010's own docstring: it refused to reuse `device_placements`
precisely because `floor_id` and `floor_position` are NOT NULL there, and made
its floor nullable. The read-model has modelled the floorless case since the day
it was created; nothing could write one. This revision is that argument applied
to the source of truth, which is where it belonged.

THREE ANSWERS, EACH COMPLETE
----------------------------
The two columns become independently nullable, so the row holds whichever of
these an operator can honestly make:

  * **a site** — "this meter is in Aeon Tower". Enough for EPI and for every
    rating, portfolio row and site comparison.
  * **a site and a floor** — "…on Level 4". Enough for every floor-wise question
    Building Intelligence asks, AND IT NEEDS NO DRAWING. This is the same
    argument as the one above, applied one level down: requiring an `{x, y}` to
    say which storey something is on forces an operator to invent a coordinate
    or stay silent, exactly as requiring a drawing to say which building it is in
    forced them to leave the estate unplaced. A floor is a fact about the world;
    a position is a fact about an image.
  * **a site, a floor and a position** — the pin, which is what the floor-plan
    editor writes and the only one of the three that needs an uploaded plan.

WHAT IS STILL REFUSED, AND WHY IT IS A CONSTRAINT AND NOT A VALIDATOR
----------------------------------------------------------------------
One combination, and it is not a weak statement but a meaningless one: a
`floor_position` with NO `floor_id`. An x/y is only ever an x/y ON some image, so
coordinates with no floor are coordinates on nothing, and no reader could do
anything with them but guess.

    floor_position IS NULL OR floor_id IS NOT NULL

as a CHECK. `service.py` enforces the same rule at the API edge, and that is not
a duplicate: the API is one writer among several a database sees over its life
(this migration, psql, a future importer), and this is the kind of invariant that
is cheap to state once at the bottom and expensive to discover missing at the top.

A `zone_id` gets its own constraint for the reason it was always true:
`zones.floor_id` is itself NOT NULL, so a zone with no floor is a room in no
storey.

WHAT THIS DOES NOT DO
---------------------
It places nothing. Every existing row already carries a floor and a position and
is untouched; no row is created, and a device's building stays an operator's
assertion. Widening a column and adding a CHECK that all existing rows satisfy
takes no table rewrite, so this is safe on a live table — but Postgres does
validate the constraint against the existing rows on `ADD CONSTRAINT`, which is
the intended proof that nothing already in the table violates it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0031_placement_without_a_pin"
down_revision = "0030_audit_log_tenant_ts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "device_placements", "floor_id",
        existing_type=sa.String(36), nullable=True,
    )
    op.alter_column(
        "device_placements", "floor_position",
        existing_type=sa.JSON(), nullable=True,
    )
    op.create_check_constraint(
        "ck_device_placements_pin_is_whole",
        "device_placements",
        "floor_position IS NULL OR floor_id IS NOT NULL",
    )
    op.create_check_constraint(
        "ck_device_placements_zone_needs_floor",
        "device_placements",
        "zone_id IS NULL OR floor_id IS NOT NULL",
    )


def downgrade() -> None:
    # Re-imposing NOT NULL is only possible while every placement still carries a
    # floor AND a position. Postgres will refuse rather than invent either for a
    # device somebody assigned to a building or to a storey, which is the correct
    # failure: those rows would have to be deleted deliberately first.
    op.drop_constraint(
        "ck_device_placements_zone_needs_floor", "device_placements", type_="check"
    )
    op.drop_constraint(
        "ck_device_placements_pin_is_whole", "device_placements", type_="check"
    )
    op.alter_column(
        "device_placements", "floor_position",
        existing_type=sa.JSON(), nullable=False,
    )
    op.alter_column(
        "device_placements", "floor_id",
        existing_type=sa.String(36), nullable=False,
    )
