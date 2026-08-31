"""reporting: WHERE a point IS — site / floor / zone on the points dimension

Revision ID: 0008_points_spatial
Revises: 0007_iot_alerts_projection
Create Date: 2026-08-31

WHAT WAS MISSING
----------------
`neubit_control` has had `sites`, `floors` and `zones` tables for a long time.
`points` had no reference to any of them, so nothing measured by this platform
was anchored in space: there was no way to ask "what is floor 4 drawing", to
scope a dashboard to one building, or to say that a chiller is on the roof.

Every serious building-intelligence surface is built on that axis — a site
selector at the top of the page, a floor-wise breakdown down the side — and none
of it was expressible. Not because the data was wrong, but because the column did
not exist.

SCHEMA NOW, PLACEMENTS LATER — AND THE ORDER MATTERS
-----------------------------------------------------
This revision adds the columns and threads them through the registry as
dimensions. It places NOTHING. Every one of the 314 points is unplaced when this
runs and stays unplaced until somebody says otherwise, because:

* **Nothing on the wire carries a placement.** The gateway knows a device's
  connection, tag, category and equipment kind (contract §11/§12). It does not
  know which floor the device is on, and it has no field in which to say so.
* **A guessed placement is worse than none.** `4F Khem Chiller01` looks like it
  names a floor, and parsing floors out of device tags would place perhaps eighty
  percent of this estate correctly and the rest silently wrongly — and a
  floor-wise energy chart that is silently wrong for one floor in five is worse
  than one that says "unplaced". That is contract §4 in a new place: absence
  renders as absence.

Doing the schema FIRST is the point of this revision. Widgets saved from here on
can group and filter by site, floor and zone; the day placements arrive, those
widgets start answering rather than needing to be rebuilt.

WHY BOTH AN ID AND A NAME PER LEVEL
------------------------------------
Because the id is the identity and the name is the label, and this store cannot
look the second one up. `sites` / `floors` / `zones` live in `neubit_control`, the
platform bans cross-service reads, and `neubit_reporting` exists precisely so
nothing has to do that. This is the same rule the access projection follows —
"put the LABELS on the wire" (builder contract §9.3) — applied to a dimension
table instead of an event: whoever writes a placement writes the name with it, or
every floor legend on the platform reads `a7f3…`.

A name here is therefore a COPY, and a copy goes stale when a floor is renamed.
That is the accepted cost, and it is the same one `points.device_tag` already
carries. Grouping is on the id; the name is only ever displayed.

THE WRITER DOES NOT TOUCH THESE COLUMNS, ON PURPOSE
----------------------------------------------------
`reading-writer`'s points upsert names its columns explicitly (`store.py`), and
these six are not among them. So a reading can never blank a placement — which is
the same failure the `category` COALESCE exists to prevent, avoided here by
construction rather than by a coalesce. A placement is an operator's statement
about the building, not something the gateway reports, and nothing that consumes
the gateway should be able to overwrite it.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008_points_spatial"
down_revision = "0007_iot_alerts_projection"
branch_labels = None
depends_on = None


# The dimensions added to the `iot_readings` dataset. Appended to the definition
# rather than the whole row being rewritten: the definition is DATA, and a
# migration that reprinted it wholesale would silently revert anything a later
# projection or an operator had changed.
#
# All six hang off the `points` join the dataset already declares, so no new
# relation and no new join is involved — a widget that does not group by
# placement pays for none of this.
SPATIAL_DIMENSIONS = [
    {"key": "site_id", "label": "Site", "source": "points", "column": "site_id", "type": "uuid",
     "description": "The site this point's device belongs to. Unplaced points have none."},
    {"key": "site_name", "label": "Site name", "source": "points", "column": "site_name",
     "type": "text",
     "description": "Display name copied from neubit_control when the placement was made."},
    {"key": "floor_id", "label": "Floor", "source": "points", "column": "floor_id", "type": "uuid",
     "description": "The floor this point's device is on. Unplaced points have none."},
    {"key": "floor_name", "label": "Floor name", "source": "points", "column": "floor_name",
     "type": "text",
     "description": "Display name copied from neubit_control when the placement was made."},
    {"key": "zone_id", "label": "Zone", "source": "points", "column": "zone_id", "type": "uuid",
     "description": "The zone within the floor. Unplaced points have none."},
    {"key": "zone_name", "label": "Zone name", "source": "points", "column": "zone_name",
     "type": "text",
     "description": "Display name copied from neubit_control when the placement was made."},
]


def upgrade() -> None:
    # NULLable, with no default and no backfill. NULL is the honest value: this
    # point has not been placed. A default would place every point somewhere.
    op.add_column("points", sa.Column("site_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("points", sa.Column("site_name", sa.String(255), nullable=True))
    op.add_column("points", sa.Column("floor_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("points", sa.Column("floor_name", sa.String(255), nullable=True))
    op.add_column("points", sa.Column("zone_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("points", sa.Column("zone_name", sa.String(255), nullable=True))

    # "every point in this tenant's site / on this floor" — the two scopes a
    # building console actually filters on. Zone is not indexed: it is only ever
    # reached through a floor, and an index nothing uses is a write cost.
    op.create_index("ix_points_tenant_site", "points", ["tenant_id", "site_id"])
    op.create_index("ix_points_tenant_floor", "points", ["tenant_id", "floor_id"])

    # Append the dimensions to the registered dataset. Idempotent and additive:
    # the guard means re-running it (or running it against a definition somebody
    # has already extended) changes nothing.
    op.execute(
        sa.text(
            """
            UPDATE dashboard_datasets
               SET definition = jsonb_set(
                       definition, '{dimensions}',
                       (definition->'dimensions') || CAST(:dims AS jsonb)),
                   updated_at = now()
             WHERE key = 'iot_readings'
               AND NOT (definition->'dimensions' @> CAST(:probe AS jsonb))
            """
        ).bindparams(
            dims=json.dumps(SPATIAL_DIMENSIONS),
            probe=json.dumps([{"key": "floor_id"}]),
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE dashboard_datasets
               SET definition = jsonb_set(
                       definition, '{dimensions}',
                       (SELECT coalesce(jsonb_agg(d), '[]'::jsonb)
                          FROM jsonb_array_elements(definition->'dimensions') d
                         WHERE d->>'key' NOT IN ('site_id','site_name','floor_id',
                                                 'floor_name','zone_id','zone_name'))),
                   updated_at = now()
             WHERE key = 'iot_readings'
            """
        )
    )
    op.drop_index("ix_points_tenant_floor", table_name="points")
    op.drop_index("ix_points_tenant_site", table_name="points")
    for col in ("zone_name", "zone_id", "floor_name", "floor_id", "site_name", "site_id"):
        op.drop_column("points", col)
