"""EPI — energy performance index, and the reasons it usually cannot be computed.

WHAT A RATING ACTUALLY NEEDS, AND WHERE EACH PIECE COMES FROM
--------------------------------------------------------------
``EPI = annualised kWh / gross floor area``. Three inputs, three different
owners, and until this change the platform could state none of them:

1. **kWh** — a MEASUREMENT, but only once somebody says the register is in
   kilowatt-hours. `points.unit` is NULL for every point because the wire carries
   no `env.u` (contract §11/§12). It becomes a fact when an OPERATOR confirms it
   (`app/api/units.py`), never when a tag looks like it says so.
2. **Area** — a fact about the BUILDING. It lives in `neubit_control.sites`
   (core, migration 0018), typed beside the address, and reaches this store as
   `site_facts` through the site-facts event mirror. NULL means NOT RECORDED.
3. **A benchmark standard** — the bands that turn a number into a grade. This
   repository holds NONE, and see `benchmark_state()` at the bottom of this file
   for why nothing is invented to fill the gap.

EVERY ONE OF THOSE CAN BE MISSING, AND MISSING IS AN ANSWER
------------------------------------------------------------
A rating renders only where every input it needs is present. What this module
returns when one is not is a REASON and a place to go and fix it — never a
partial score, never a default area, never a national average standing in for a
building nobody measured. `blocked` on the response is the list of those reasons,
and the screen prints it instead of a number.

WHICH METERS COUNT IS THE OPERATOR'S CALL, NOT OURS
-----------------------------------------------------
An estate has an incomer, sub-incomers, floor boards and solar. Summing every
confirmed kWh register at a site double-counts, and picking "the main one" by
tag would be exactly the naming-convention fabrication §17 forbids. There is also
no stored fact anywhere that says which meter measures the whole supply.

So the METERS ARE AN INPUT. The caller names the point ids that constitute the
site's incoming supply, the response echoes each one with its own arithmetic, and
the screen shows that list beside the score. Nothing is stored, nothing is
assumed, and a reader can check the total by adding up the rows.

HOW CONSUMPTION IS DERIVED FROM A CUMULATIVE REGISTER
-------------------------------------------------------
A kWh point is a lifetime counter, so consumption over a window is
``last − first`` — read from `readings_1h` (a ROLLUP, per contract §5, never the
hypertable) using its own `num_first` / `num_last` columns. Two cases are called
out rather than smoothed over:

* **The register went DOWN.** A meter reset, a rollover, or a replaced device.
  The delta is meaningless and is reported as `register_decreased` with no
  consumption — not as a negative and certainly not as an absolute value.
* **The register did not MOVE.** Perfectly possible (it is what every energy
  point on this deployment is doing right now), and it means zero measured
  consumption over the window. That is a real measurement and renders as 0, with
  the buckets and the register values beside it so nobody mistakes it for a fault
  in the arithmetic.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows

# What an operator must have confirmed for a point to be usable as an energy
# register. Compared case-insensitively after stripping; nothing else is
# accepted, and in particular no unit is INFERRED to get a point into this set.
KWH_UNITS = {"kwh", "kw h", "kilowatt-hour", "kilowatt hour"}

# Consumption is read from the HOURLY rollup. A rating is a question about months
# and years; the 1-minute rollup would answer it identically at many times the
# cost, and the raw table is off limits for analysis (contract §5).
RESOLUTION = "1h"
RESOLUTION_REASON = (
    "1-hour rollup (readings_1h); real-time aggregate, so the current partial "
    "hour is included. A rating is a question about months — the raw table is "
    "never read for one."
)


def is_energy_unit(unit: str | None) -> bool:
    return bool(unit) and unit.strip().lower() in KWH_UNITS


# ── Sites ────────────────────────────────────────────────────────────────────

_SITES_SQL = """
    SELECT f.site_id,
           f.site_name,
           f.is_active,
           f.gross_floor_area_sqm,
           f.energy_tariff_per_kwh,
           f.tariff_currency,
           f.occupancy,
           f.facts_updated_at,
           f.mirrored_at,
           (SELECT count(*) FROM points p
             WHERE p.site_id = f.site_id
               AND p.tenant_id = f.tenant_id
               AND p.retired_at IS NULL)                        AS points,
           (SELECT count(*) FROM points p
             WHERE p.site_id = f.site_id
               AND p.tenant_id = f.tenant_id
               AND p.retired_at IS NULL
               AND p.unit_source = 'operator'
               AND lower(btrim(p.unit)) = 'kwh')                AS kwh_points
      FROM site_facts f
     WHERE (CAST(:tenant AS uuid) IS NULL OR f.tenant_id = CAST(:tenant AS uuid))
     ORDER BY f.site_name NULLS LAST
"""


async def sites(db: AsyncSession, tenant: uuid.UUID | None) -> list[dict]:
    """Every site this store has been TOLD about, with its rating inputs.

    A site appears here because core published it, not because it has readings —
    "this building has an area recorded and nothing reporting" is a state worth
    seeing, and so is its opposite.
    """
    return _rows(
        await db.execute(text(_SITES_SQL), {"tenant": str(tenant) if tenant else None})
    )


# ── Candidate meters ─────────────────────────────────────────────────────────

_METERS_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.device_type,
           p.unit, p.unit_source, p.unit_confirmed_at, p.unit_confirmed_by,
           p.last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND p.site_id = CAST(:site AS uuid)
       AND {live}
       AND p.type = 'num'
       AND p.unit_source = 'operator'
       AND lower(btrim(p.unit)) = 'kwh'
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
"""


async def candidate_meters(
    db: AsyncSession, tenant: uuid.UUID | None, site_id: uuid.UUID
) -> list[dict]:
    """Points at this site an operator has CONFIRMED are kilowatt-hour registers.

    The filter is on `unit_source = 'operator'`, not on the unit alone: a value
    the wire happened to send is not somebody standing behind it, and a rating is
    the one place that distinction has to be load-bearing.
    """
    return _rows(
        await db.execute(
            text(_METERS_SQL.format(live=LIVE_POINT)),
            {
                "tenant": str(tenant) if tenant else None,
                "site": str(site_id),
                "retire_days": RETIRE_AFTER_DAYS,
            },
        )
    )


# ── The arithmetic ───────────────────────────────────────────────────────────

_REGISTER_SQL = """
    SELECT r.point_id,
           count(*)                                             AS buckets,
           sum(r.sample_count)                                  AS samples,
           min(r.bucket)                                        AS first_bucket,
           max(r.bucket)                                        AS last_bucket,
           min(r.num_min)                                       AS min,
           max(r.num_max)                                       AS max,
           (array_agg(r.num_first ORDER BY r.bucket ASC)
              FILTER (WHERE r.num_first IS NOT NULL))[1]        AS first_value,
           (array_agg(r.num_last ORDER BY r.bucket DESC)
              FILTER (WHERE r.num_last IS NOT NULL))[1]         AS last_value
      FROM readings_1h r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.bucket >= :start AND r.bucket < :end
     GROUP BY r.point_id
"""


async def registers(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    start: dt.datetime,
    end: dt.datetime,
) -> dict[uuid.UUID, dict]:
    """First and last register value per meter, from the HOURLY rollup."""
    rows = _rows(
        await db.execute(
            text(_REGISTER_SQL),
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "start": start,
                "end": end,
            },
        )
    )
    return {r["point_id"]: r for r in rows}


def meter_row(meta: dict, reg: dict | None) -> dict:
    """One meter's contribution, with everything a reader needs to check it."""
    out = {
        "point_id": meta["point_id"],
        "point_tag": meta["point_tag"],
        "device_tag": meta["device_tag"],
        "unit": meta["unit"],
        "unit_source": meta["unit_source"],
        "unit_confirmed_at": meta["unit_confirmed_at"],
        "unit_confirmed_by": meta["unit_confirmed_by"],
        "buckets": int(reg["buckets"]) if reg else 0,
        "first_bucket": reg["first_bucket"] if reg else None,
        "last_bucket": reg["last_bucket"] if reg else None,
        "first_value": reg["first_value"] if reg else None,
        "last_value": reg["last_value"] if reg else None,
        "consumption_kwh": None,
        "status": "no_data",
        "reason": "no hourly bucket in this window — nothing was measured to count",
    }
    if not reg or reg["first_value"] is None or reg["last_value"] is None:
        return out

    first = float(reg["first_value"])
    last = float(reg["last_value"])
    delta = last - first
    if delta < 0:
        # A meter reset, a rollover, or a replaced device. There is no honest
        # consumption to report; an absolute value would silently invent one.
        out["status"] = "register_decreased"
        out["reason"] = (
            f"the register went from {first:g} down to {last:g}. A cumulative meter "
            f"does not go backwards, so this window spans a reset, a rollover or a "
            f"device replacement and no consumption can be derived from it"
        )
        return out

    out["consumption_kwh"] = delta
    out["status"] = "ok"
    out["reason"] = f"{last:g} − {first:g} = {delta:g} kWh over {out['buckets']} hourly buckets"
    return out


def benchmark_state() -> dict:
    """What band this EPI falls into — and why this platform does not say.

    A rating scheme is a PUBLISHED document. BEE's star bands for office
    buildings and IGBC's credit thresholds are real numbers, set per building
    type and per climate zone, and revised between versions of the standard. This
    repository holds none of them, and a threshold typed from memory would be a
    fabricated grade wearing a real EPI's credibility — the exact failure the
    honesty rules exist to prevent (dashboard-builder contract §4).

    So the EPI ships as what it is: a measured figure with its inputs shown. The
    band is absent, and it is absent for a stated reason rather than quietly
    missing. When a standard is loaded — a document, a version, a table of bands
    per building type and climate zone — this returns it and cites it on screen.
    """
    return {
        "available": False,
        "standard": None,
        "version": None,
        "reason": (
            "No benchmark standard is loaded on this platform. BEE star bands and "
            "IGBC thresholds are published per building type, per climate zone and "
            "per version of the standard, and this deployment holds no such "
            "document. The EPI above is a measured figure; a band drawn against a "
            "threshold nobody can cite would be an invented grade, so none is shown."
        ),
        "what_it_needs": (
            "A benchmark table — standard name, version, building type, climate "
            "zone, and the EPI boundaries — recorded on the platform and citable "
            "on screen beside every grade it produces."
        ),
    }
