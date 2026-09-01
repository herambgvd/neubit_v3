"""reporting: WHO says where a device is — the device→building join, and its
derivation onto `points`

Revision ID: 0010_device_locations
Revises: 0009_derived_delta_t
Create Date: 2026-08-31

WHAT WAS MISSING
----------------
0008 added `site_id` / `floor_id` / `zone_id` to `points` and placed nothing,
deliberately. It said so in its own docstring: *"There is no way to place a
point. No API, no screen, no wire field."* The columns were an empty frame, and
every surface built on the spatial axis — Portfolio's "Floor-wise" panel, a site
selector, the floor plan that already places CAMERAS — was permanently empty.

This revision makes a placement writable, and the shape of it is the whole
decision.

WHERE THE TRUTH LIVES: ONE ROW PER DEVICE, NOT ONE PER POINT
-------------------------------------------------------------
A placement is a fact about a BOX, not about each of the box's measurements.
`4F_Solar_Panel01` reports 21 points and every one of them is in the same room;
asking an operator to say so 21 times is how the feature does not get used. This
estate is 29 devices and 314 points, so device-level placement is the same fact
stated ten times less often — and it is also the shape the gateway uses, where a
point exists only as a child of a device.

So `device_locations` is the truth, and `points.site_id` / `floor_id` /
`zone_id` become a DERIVATION of it. Two consequences, both of which are why the
truth could not simply be the six columns 0008 added:

* **A placement must travel to a point that does not exist yet.** The writer
  creates a `points` row the first time a point reports (contract §6). A device
  placed today whose 22nd point first reports tomorrow must have that point
  placed too — otherwise the estate silently un-places itself as it grows, one
  point at a time, and nothing says so.
* **A placement must survive a device being un-placed and re-placed**, and it
  must be answerable as "what did the operator SAY" rather than reconstructed
  from 314 denormalised copies that could disagree with each other.

This is the same shape as the tenant mapping in pipeline contract §10 — a join
between two systems' identifiers, the gateway's `device_id` and the platform's
`site_id`/`floor_id`/`zone_id` — and it is stored here precisely because of what
went wrong there: that mapping lived only in `VE_READINGS_TENANT_MAP`, in a
gitignored env file, and therefore did not travel. A row in a table travels with
a `pg_dump`, is visible to an operator, and carries who made it and when.

WHY IT IS IN `neubit_reporting` AND NOT IN `neubit_control`
------------------------------------------------------------
The building half of the join (sites, floors, zones) lives in `neubit_control`.
The device half (`device_id`) is the gateway's identifier, and `neubit_control`
has never heard of it — its own `sites.devices` table is about cameras and
access controllers, not about conflux points. Putting the row in core would mean
core holding an identifier it cannot resolve and BI joining across a database it
is banned from reading.

Here, the join sits beside the thing it decorates, in the store that exists to be
the one place data is gathered for querying, and `/bi/...` — the ONE read path
over this store (§14) — can answer a floor-wise question without a second
service in the request path.

The COST of putting it here is that this store cannot validate a `floor_id`
against `neubit_control`, and cannot look a floor's NAME up. Both are solved
where the write happens, not by a cross-database read: the placement API calls
core's own `/api/v1/floors/{id}` with the CALLER's token, and copies the name
from core's answer. See `app/api/placement.py`. That is 0008's "put the LABELS on
the wire" rule with an authority behind it — the name is core's, not the
browser's.

WHY IT IS NOT CORE'S `device_placements`, WHICH ALREADY EXISTS
---------------------------------------------------------------
`neubit_control.device_placements` (core, `app/sites/device/`) already joins a
`device_id` to a floor — that is what puts a camera on the VMS floor plan. It is
deliberately NOT reused here, and the reason is in its own column list:
`floor_id` is NOT NULL and `floor_position` — `{x, y, rotation}` — is NOT NULL.

Both are wrong for this. Registering 29 IoT devices there would mean inventing an
x/y for every one of them, which is a coordinate nobody measured on a drawing
nobody has opened; and it would make "this meter is on the site, on no particular
storey" — a true and common statement about a rooftop or a plant room —
unexpressible.

The two are different facts and this one comes first: `device_locations` says
WHICH ROOM, `device_placements` says WHERE ON THE DRAWING. A device can have the
first without the second, and the day someone drags a sensor onto a floor plan
that pin is core's row to write, not this one's. The name differs on purpose so
the two are never confused in a grep.

THE DERIVATION, AND THE RULE THAT MAKES IT SAFE
-------------------------------------------------
`points` gains `placement_source`:

    NULL      — this point's placement (if any) is derived from its device
    'device'  — derived from `device_locations`; may be recomputed at any time
    'point'   — an operator placed THIS POINT explicitly. Never recomputed.

`reconcile_placement()` (in `reporting.placement`) is the ONE statement that
writes the six columns from `device_locations`, and it never touches a row whose
`placement_source` is `'point'`. That is the point-level override: precise where
precision is genuinely needed (a sub-meter on a different floor from its panel),
and never the thing an operator has to do 314 times.

WHAT THE WRITER DOES, AND WHY THAT IS NOT A CLOBBER
-----------------------------------------------------
0008 said "the writer cannot touch these columns" and made that true by
construction — the points upsert names its columns and these six were not among
them. That is still true of the UPSERT, and it is what stops a reading blanking a
placement (contract §11's no-clobber rule, the same shape as `category`'s
COALESCE).

The writer now runs `reconcile_placement()` for the points it upserted, in the
SAME transaction. That is not a relaxation of the rule, because the writer is not
the author of the value: the statement's only source is `device_locations`,
which only the placement API writes. A message can never carry a placement,
cannot blank one, and cannot move one. What it CAN now do is cause a brand-new
point to inherit the placement its device already has — which is the only way a
placement travels to a point that did not exist when it was made.

The reconcile is guarded by `IS DISTINCT FROM`, so in the steady state — every
point already agreeing with its device — it updates zero rows.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010_device_locations"
down_revision = "0009_derived_delta_t"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── the truth ────────────────────────────────────────────────────────────
    # One row per (tenant, device). The device half is the GATEWAY's id; the
    # building half is `neubit_control`'s. Neither database can validate the
    # other's, which is exactly why the row records who asserted the join and
    # when — a placement is an operator's statement, and a statement has an
    # author.
    op.create_table(
        "device_locations",
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=False),
        # The building half. `site_id` is required — a placement that names no
        # site is not a placement. Floor and zone are optional and INDEPENDENT of
        # each other in the same way `/bi/summary`'s three counts are: a rooftop
        # meter belongs to the building and to no storey, and that is a real
        # answer rather than a half-finished one.
        sa.Column("site_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("site_name", sa.String(255), nullable=False),
        sa.Column("floor_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("floor_name", sa.String(255), nullable=True),
        sa.Column("zone_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("zone_name", sa.String(255), nullable=True),
        # The label the device carried WHEN IT WAS PLACED. Stored so an operator
        # reviewing the placement list sees what they placed even for a device
        # that has since been renamed or has stopped reporting entirely (a
        # retired device keeps its `points` rows, but a purged one would not).
        sa.Column("device_tag", sa.String(255), nullable=True),
        # Provenance. `placed_by` is the core user id from the JWT `sub`.
        # `source` is how the placement was made, and it exists so that a future
        # import or a suggestion-accepted-in-bulk is distinguishable from a
        # person choosing one device at a time. It is NOT a confidence score:
        # nothing here is ever written by a guess.
        sa.Column("placed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source", sa.String(32), nullable=False, server_default="operator"),
        sa.Column(
            "placed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("tenant_id", "device_id", name="pk_device_locations"),
    )
    # "every device this tenant has placed on this floor" — the reverse lookup a
    # floor-plan screen makes.
    op.create_index(
        "ix_device_locations_floor", "device_locations", ["tenant_id", "floor_id"]
    )
    op.create_index(
        "ix_device_locations_site", "device_locations", ["tenant_id", "site_id"]
    )

    # ── the derivation marker ────────────────────────────────────────────────
    # NULL for every existing row, which is correct: nothing has been placed, so
    # nothing is derived from anything. `'point'` is the only value the reconcile
    # refuses to overwrite, so a NULL row is safe to recompute — it has no
    # placement to lose.
    op.add_column(
        "points", sa.Column("placement_source", sa.String(16), nullable=True)
    )
    op.create_check_constraint(
        "ck_points_placement_source",
        "points",
        "placement_source IS NULL OR placement_source IN ('device','point')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_points_placement_source", "points", type_="check")
    op.drop_column("points", "placement_source")
    op.drop_index("ix_device_locations_site", table_name="device_locations")
    op.drop_index("ix_device_locations_floor", table_name="device_locations")
    op.drop_table("device_locations")
