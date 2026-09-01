"""Writing `device_locations` — the device→building join this store reads from.

This module used to BE the placement feature: an API, a screen, and an HTTP
resolver that asked core to confirm every id. The feature was a duplicate.
Placement already had a home — Configurations → Sites → floor plan, backed by
`neubit_control.device_placements`, which has always carried `site_id` /
`floor_id` / `zone_id` beside the pin's `{x, y, rotation}` and has always emitted
an event on every write.

So the routes are gone and the CALLER is now `app/placement_sync.py`, a durable
consumer of `tenant.*.sites.device_placement.>`. What is left here is the write
itself, unchanged in every property that mattered:

* **The truth is one row per DEVICE** (`device_locations`), not one per point. A
  placement is a fact about a box; this estate is 29 devices and 314 points.
* **`points`' six columns are a DERIVATION** of that row, recomputed by
  `reporting.placement.reconcile_placement`, which also runs on the write path so
  a point that reports for the FIRST TIME inherits its device's placement.
* **A point-level override exists** (`points.placement_source = 'point'`) for the
  sub-meter that genuinely is not where its panel is.

WHERE THE NAMES COME FROM NOW
------------------------------
`sites` / `floors` / `zones` live in `neubit_control` and this store may not read
it (contract §1) — which is why `points` carries `site_name` beside `site_id` at
all: the label has to be COPIED at write time or every floor legend on the
platform reads `a7f3…`.

The old answer was an HTTP round-trip to core with the caller's own token, made
because a name from a BROWSER is a label nothing checked (contract §4). The new
answer is stronger and cheaper: core publishes the name ON THE EVENT, read from
its own `sites` / `floors` / `zones` rows at the moment it writes the placement.
The authority states the label instead of being asked to confirm one, and there
is no third party in between to state a different one.

`Location` below is therefore a plain value object — every field in it came from
core, and nothing in this module invents one.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

from kernel.errors import ValidationError
from reporting.placement import reconcile_placement
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# How many devices (or points) one call may place. An unbounded list is an
# unbounded transaction. The floor-plan consumer places one device per event, so
# this is now a ceiling nothing reaches rather than a working limit.
MAX_BULK = 500


# ── where a device is ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Location:
    """A verified place. Every field here came from core, not from a request.

    Core validated the site/floor/zone against each other before it wrote the
    placement (`app/sites/device/service.py` refuses a floor of another site and a
    zone of another floor), and it published the names with the ids. There is
    nothing left for this module to check and nothing for it to guess.
    """

    site_id: uuid.UUID
    site_name: str
    floor_id: uuid.UUID | None = None
    floor_name: str | None = None
    zone_id: uuid.UUID | None = None
    zone_name: str | None = None


# ── the device→building join ─────────────────────────────────────────────────

# One row per (tenant, device). ON CONFLICT UPDATE because re-placing a device is
# the ordinary case (a meter moves, or an operator corrects a mistake), and a
# placement has no history worth keeping here — `placed_at`/`placed_by` say who
# asserted the CURRENT one, and the audit trail of the change is core's job.
_UPSERT_SQL = text(
    """
    INSERT INTO device_locations (
        tenant_id, device_id, site_id, site_name, floor_id, floor_name,
        zone_id, zone_name, device_tag, placed_by, source, placed_at, updated_at)
    SELECT CAST(:tenant AS uuid), d.device_id,
           CAST(:site_id AS uuid), :site_name,
           CAST(:floor_id AS uuid), :floor_name,
           CAST(:zone_id AS uuid), :zone_name,
           d.device_tag, CAST(:placed_by AS uuid), :source, :now, :now
      FROM (
            SELECT p.device_id, max(p.device_tag) AS device_tag
              FROM points p
             WHERE p.tenant_id = CAST(:tenant AS uuid)
               AND p.device_id = ANY(CAST(:device_ids AS uuid[]))
             GROUP BY p.device_id
           ) d
    ON CONFLICT (tenant_id, device_id) DO UPDATE
       SET site_id = excluded.site_id, site_name = excluded.site_name,
           floor_id = excluded.floor_id, floor_name = excluded.floor_name,
           zone_id = excluded.zone_id, zone_name = excluded.zone_name,
           device_tag = excluded.device_tag,
           placed_by = excluded.placed_by, source = excluded.source,
           updated_at = excluded.updated_at
    RETURNING device_id
    """
)

_DELETE_SQL = text(
    """
    DELETE FROM device_locations
     WHERE tenant_id = CAST(:tenant AS uuid)
       AND device_id = ANY(CAST(:device_ids AS uuid[]))
    RETURNING device_id
    """
)


def _require_tenant(tenant: uuid.UUID | None) -> uuid.UUID:
    """A placement needs a tenant to belong to.

    A platform super-admin reads across every tenant (NULL means "no filter"
    everywhere on the read path), but a WRITE has to land in exactly one — a row
    keyed on a NULL tenant would be nobody's. So a super-admin cannot place a
    device without picking a tenant, and is told so rather than writing one
    somewhere arbitrary.
    """
    if tenant is None:
        raise ValidationError(
            "a placement belongs to a tenant; a platform super-admin must call "
            "this with a tenant-scoped token"
        )
    return tenant


async def place_devices(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    device_ids: list[uuid.UUID],
    where: Location,
    placed_by: uuid.UUID | None,
    source: str = "operator",
) -> dict:
    """Place one or more devices, then push the placement down to their points."""
    t = _require_tenant(tenant)
    if not device_ids:
        raise ValidationError("no devices given")
    if len(device_ids) > MAX_BULK:
        raise ValidationError(f"at most {MAX_BULK} devices per call")

    rows = (
        await db.execute(
            _UPSERT_SQL,
            {
                "tenant": str(t),
                "device_ids": [str(d) for d in device_ids],
                "site_id": str(where.site_id),
                "site_name": where.site_name,
                "floor_id": str(where.floor_id) if where.floor_id else None,
                "floor_name": where.floor_name,
                "zone_id": str(where.zone_id) if where.zone_id else None,
                "zone_name": where.zone_name,
                "placed_by": str(placed_by) if placed_by else None,
                "source": source,
                "now": dt.datetime.now(dt.timezone.utc),
            },
        )
    ).scalars().all()

    # The INSERT selects from `points`, so a device id that has never reported
    # writes no row. That is deliberate — this API places devices the store knows
    # about, and silently accepting an id it has never seen would let a typo look
    # like a success — but it must be VISIBLE, not silent.
    placed = {uuid.UUID(str(r)) for r in rows}
    unknown = [str(d) for d in device_ids if d not in placed]

    points_changed = await reconcile_placement(db, t, device_ids=sorted(placed))
    await db.commit()
    return {
        "devices_placed": len(placed),
        "points_updated": points_changed,
        "unknown_device_ids": unknown,
        "location": {
            "site_id": str(where.site_id),
            "site_name": where.site_name,
            "floor_id": str(where.floor_id) if where.floor_id else None,
            "floor_name": where.floor_name,
            "zone_id": str(where.zone_id) if where.zone_id else None,
            "zone_name": where.zone_name,
        },
    }


async def unplace_devices(
    db: AsyncSession, tenant: uuid.UUID | None, *, device_ids: list[uuid.UUID]
) -> dict:
    """Remove the placement. The points go back to UNPLACED, not to a default.

    Unplacing is a real answer — "we no longer know where this is" — and it is
    stored as the absence it is. Points carrying an explicit point-level
    override keep it: that override was never derived from this row.
    """
    t = _require_tenant(tenant)
    if not device_ids:
        raise ValidationError("no devices given")
    if len(device_ids) > MAX_BULK:
        raise ValidationError(f"at most {MAX_BULK} devices per call")
    rows = (
        await db.execute(
            _DELETE_SQL,
            {"tenant": str(t), "device_ids": [str(d) for d in device_ids]},
        )
    ).scalars().all()
    removed = [uuid.UUID(str(r)) for r in rows]
    points_changed = await reconcile_placement(db, t, device_ids=sorted(removed))
    await db.commit()
    return {"devices_unplaced": len(removed), "points_updated": points_changed}


# ── the point-level override ─ NO CALLER TODAY ───────────────────────────────
#
# KNOWN GAP, recorded rather than quietly dropped. `/bi/placement/points` was the
# only way to say "this sub-meter is NOT where its panel is", and it went with the
# rest of that API. Nothing reaches the SQL or the two functions below now.
#
# What still holds: `reconcile_placement` refuses to touch any point row marked
# `placement_source = 'point'`, so an override that EXISTS is still honoured
# forever, including when its device is re-placed or unplaced from the floor plan.
# What is missing is a way to CREATE or CLEAR one — the floor plan is device-level
# by construction. The mechanism is kept whole here so restoring it is a route,
# not a rewrite.

_PLACE_POINTS_SQL = text(
    """
    UPDATE points
       SET site_id = CAST(:site_id AS uuid), site_name = :site_name,
           floor_id = CAST(:floor_id AS uuid), floor_name = :floor_name,
           zone_id = CAST(:zone_id AS uuid), zone_name = :zone_name,
           placement_source = 'point'
     WHERE tenant_id = CAST(:tenant AS uuid)
       AND point_id = ANY(CAST(:point_ids AS uuid[]))
    RETURNING point_id
    """
)

# Clearing an override does NOT clear the placement — it hands the point back to
# its device. Setting the columns to NULL here and letting the reconcile refill
# them is the only way to get that right in one place: if the device is placed
# the point ends up where the device is, and if it is not, the point ends up
# unplaced. Two states, one statement, no branch that can disagree.
_RESET_POINTS_SQL = text(
    """
    UPDATE points
       SET site_id = NULL, site_name = NULL, floor_id = NULL, floor_name = NULL,
           zone_id = NULL, zone_name = NULL, placement_source = NULL
     WHERE tenant_id = CAST(:tenant AS uuid)
       AND point_id = ANY(CAST(:point_ids AS uuid[]))
       AND placement_source = 'point'
    RETURNING point_id
    """
)


async def place_points(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    where: Location,
) -> dict:
    """Override the device's placement for specific points.

    The escape hatch, not the main road: a device's points are in the device's
    room unless somebody says otherwise about a named point. Marking the row
    `placement_source='point'` is what makes the reconcile leave it alone
    forever after — including when the device is re-placed or unplaced.
    """
    t = _require_tenant(tenant)
    if not point_ids:
        raise ValidationError("no points given")
    if len(point_ids) > MAX_BULK:
        raise ValidationError(f"at most {MAX_BULK} points per call")
    rows = (
        await db.execute(
            _PLACE_POINTS_SQL,
            {
                "tenant": str(t),
                "point_ids": [str(p) for p in point_ids],
                "site_id": str(where.site_id),
                "site_name": where.site_name,
                "floor_id": str(where.floor_id) if where.floor_id else None,
                "floor_name": where.floor_name,
                "zone_id": str(where.zone_id) if where.zone_id else None,
                "zone_name": where.zone_name,
            },
        )
    ).scalars().all()
    await db.commit()
    return {"points_placed": len(rows)}


async def reset_points(
    db: AsyncSession, tenant: uuid.UUID | None, *, point_ids: list[uuid.UUID]
) -> dict:
    """Drop a point-level override; the point follows its device again."""
    t = _require_tenant(tenant)
    if not point_ids:
        raise ValidationError("no points given")
    if len(point_ids) > MAX_BULK:
        raise ValidationError(f"at most {MAX_BULK} points per call")
    rows = (
        await db.execute(
            _RESET_POINTS_SQL,
            {"tenant": str(t), "point_ids": [str(p) for p in point_ids]},
        )
    ).scalars().all()
    cleared = [uuid.UUID(str(r)) for r in rows]
    # Now that the override is gone the reconcile can speak: it refills from the
    # device if the device is placed, and leaves the point unplaced if it is not.
    refilled = await reconcile_placement(db, t, point_ids=cleared)
    await db.commit()
    return {"overrides_cleared": len(cleared), "points_updated": refilled}
