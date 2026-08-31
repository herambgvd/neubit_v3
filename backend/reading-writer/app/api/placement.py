"""Placing a device in a building — the write half of the spatial axis.

Migration 0008 added `points.site_id` / `floor_id` / `zone_id` and placed
nothing, on purpose: nothing on the gateway wire carries a placement and a
guessed one is worse than none. This module is what finally writes them, and
migration 0010 is where the shape is argued. The short version:

* **The truth is one row per DEVICE** (`device_locations`), not one per point. A
  placement is a fact about a box; this estate is 29 devices and 314 points.
* **`points`' six columns are a DERIVATION** of that row, recomputed by
  `reporting.placement.reconcile_placement`, which also runs on the write path
  so a point reporting for the first time inherits its device's placement.
* **A point-level override exists** (`points.placement_source = 'point'`) for
  the sub-meter that genuinely is not where its panel is. It is the exception.

WHY THE NAMES COME FROM CORE AND NOT FROM THE BROWSER
------------------------------------------------------
`sites` / `floors` / `zones` live in `neubit_control` and this store may not read
it (contract §1) — which is also why `points` carries `site_name` beside
`site_id` at all: the label has to be COPIED at write time or every floor legend
on the platform reads `a7f3…`.

The obvious implementation is to let the client send the name it already has on
screen. This does not do that, and the reason is contract §4. A client-supplied
name is a label nothing checked: a request could place 22 points on "Level 4"
naming a floor id that does not exist, or name a floor `Roof` that core calls
`Level 9`, and `/bi/summary` would report both as fact. So the placement API
**resolves every id against core over HTTP** and copies the name from core's
answer, ignoring anything the client said about it.

That is a service-to-service call, not a cross-service database read — the same
thing `permsync` already does in the other direction — and it is made with the
CALLER's own bearer token rather than a system token. Two consequences, both
wanted: a caller who cannot read a site cannot place anything into it, and the
tenant scoping core already applies to `/sites` applies here for free. A caller
therefore needs `bi.manage` AND `sites.read` / `floors.read` / `zones.read`,
which is exactly what the screen needs anyway to offer the picker.

If core is unreachable the placement is REFUSED. Writing an unverified placement
because the validator was down is how a fixture gets into a dimension table.
"""

from __future__ import annotations

import datetime as dt
import os
import uuid
from dataclasses import dataclass

import httpx
from kernel.errors import ForbiddenError, NotFoundError, ValidationError
from reporting.placement import reconcile_placement
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_TIMEOUT = 6.0

# How many devices (or points) one call may place. A bulk placement is the whole
# reason this API exists — 29 devices one at a time is how the feature does not
# get used — but an unbounded list is an unbounded transaction.
MAX_BULK = 500


# ── resolving the building half against core ─────────────────────────────────


@dataclass(frozen=True)
class Location:
    """A verified place. Every field here came from core, not from the request."""

    site_id: uuid.UUID
    site_name: str
    floor_id: uuid.UUID | None = None
    floor_name: str | None = None
    zone_id: uuid.UUID | None = None
    zone_name: str | None = None


def _core_base() -> str:
    base = (os.getenv("VE_CORE_URL") or "").rstrip("/")
    if not base:
        # Not a warning-and-continue: without core there is nothing to verify a
        # placement against, and an unverified placement is the fixture problem.
        raise ValidationError(
            "placement is unavailable: VE_CORE_URL is not configured, so a site "
            "or floor id cannot be verified"
        )
    return f"{base}{os.getenv('VE_API_PREFIX', '/api/v1')}"


async def _fetch(client: httpx.AsyncClient, path: str, bearer: str, what: str) -> dict:
    try:
        r = await client.get(
            f"{_core_base()}{path}", headers={"Authorization": bearer}
        )
    except Exception as exc:  # noqa: BLE001
        raise ValidationError(
            f"could not verify {what} with core ({exc}); the placement was not written"
        ) from exc
    if r.status_code == 404:
        raise NotFoundError(f"no such {what}")
    if r.status_code in (401, 403):
        # The caller holds bi.manage but not the key that reads the building
        # tree. Say which one, rather than returning a bare 403 from a service
        # the caller never addressed.
        raise ForbiddenError(
            f"placing a device requires permission to read the {what} in core "
            f"(sites.read / floors.read / zones.read)"
        )
    if r.status_code >= 300:
        raise ValidationError(f"core refused the {what} lookup: {r.status_code}")
    return r.json()


async def resolve_location(
    *,
    bearer: str,
    site_id: uuid.UUID,
    floor_id: uuid.UUID | None,
    zone_id: uuid.UUID | None,
) -> Location:
    """Verify a site / floor / zone against core and take their NAMES from it.

    Also checks that the three agree with each other — a floor of another site or
    a zone of another floor is refused rather than stored as a placement that
    reads correctly on its own row and wrongly in a hierarchy.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        site = await _fetch(client, f"/sites/{site_id}", bearer, "site")
        floor = zone = None
        if floor_id is not None:
            floor = await _fetch(client, f"/floors/{floor_id}", bearer, "floor")
            if str(floor.get("site_id")) != str(site_id):
                raise ValidationError(
                    f"floor {floor_id} belongs to site {floor.get('site_id')}, "
                    f"not to {site_id}"
                )
        if zone_id is not None:
            if floor_id is None:
                # A zone is a subdivision OF a floor. Storing one without its
                # floor would make `floors` and `zones` disagree about the same
                # device.
                raise ValidationError("a zone cannot be set without its floor")
            zone = await _fetch(client, f"/zones/{zone_id}", bearer, "zone")
            if str(zone.get("floor_id")) != str(floor_id):
                raise ValidationError(
                    f"zone {zone_id} belongs to floor {zone.get('floor_id')}, "
                    f"not to {floor_id}"
                )
    return Location(
        site_id=site_id,
        site_name=site["name"],
        floor_id=floor_id,
        floor_name=floor["name"] if floor else None,
        zone_id=zone_id,
        zone_name=zone["name"] if zone else None,
    )


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


# ── the point-level override ─────────────────────────────────────────────────

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
