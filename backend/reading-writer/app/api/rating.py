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
3. **A benchmark standard** — the bands that turn a number into a grade.
   Since migration 0016 one IS loaded (BEE Star Rating for Office Buildings,
   February 2009, cited verbatim), but a band still renders only when the
   site's climate zone and AC-share category are RECORDED and the EPI is
   computable — see `benchmark_state()` for how each missing input is named.

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

    if delta == 0 and int(reg["buckets"] or 0) > 1:
        # first == last across the whole window. Arithmetically that is zero
        # consumption; physically, over any real window, it is a register that
        # has stopped reporting. The distinction matters downstream: an EPI of
        # 0.0 built on frozen registers would fall into the BEST benchmark band
        # and print five stars for a dead meter. So the zero is kept — it IS the
        # measurement — but carries its own status, and the band logic refuses
        # to grade a rating whose every register is frozen.
        out["consumption_kwh"] = 0.0
        out["status"] = "register_frozen"
        out["reason"] = (
            f"the register held {first:g} across all {out['buckets']} hourly "
            f"buckets — a building that consumed literally nothing is not what a "
            f"flat register means; the meter has stopped moving"
        )
        return out

    out["consumption_kwh"] = delta
    out["status"] = "ok"
    out["reason"] = f"{last:g} − {first:g} = {delta:g} kWh over {out['buckets']} hourly buckets"
    return out


async def benchmark_state(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    site_id: uuid.UUID,
    epi_value: float | None,
) -> dict:
    """What band this EPI falls into — or exactly which input is missing.

    A rating scheme is a PUBLISHED document, and since migration 0016 one IS
    loaded: BEE Star Rating for Office Buildings (February 2009), Annexure 4,
    seeded verbatim with its citation (`benchmark_standards`). A band still
    renders ONLY when everything it needs exists:

      1. the standard        — loaded, cited (available=True names it);
      2. the site's climate zone and AC-share category — OPERATOR inputs on
         `benchmark_site_config` (BEE's bands differ by both). NULL means NOT
         RECORDED and the band is blocked naming which one;
      3. a computable EPI    — blocked upstream (no area → no EPI, and the
         `blocked` list already says so).

    The blocked state names BOTH what exists and what is missing: a standard
    sitting loaded while the zone is unset is a different situation from no
    standard at all, and the screen should say which one it is in.
    """
    from ..metric_registry.evaluator import _band_for, resolve_benchmark

    resolved = await resolve_benchmark(db, tenant, site_id)
    if not resolved.get("ok"):
        has_standard = resolved.get("standard") is not None
        return {
            "available": has_standard,
            "standard": resolved.get("standard"),
            "version": resolved.get("version"),
            "reason": resolved["reason"],
            "what_it_needs": (
                "Record the site's climate zone and air-conditioned-share "
                "category on the benchmark config (PUT /bi/rating/benchmark-config); "
                "nothing derives a zone from a city name."
                if has_standard
                else "A benchmark table — standard name, version, climate zone and "
                     "the EPI boundaries — seeded WITH its citation."
            ),
        }
    out = {
        "available": True,
        "standard": resolved["standard"],
        "version": resolved["version"],
        "title": resolved.get("title"),
        "citation": resolved.get("citation"),
        "zone": resolved["zone"],
        "ac_category": resolved["ac_category"],
        "band_table": resolved.get("band_table"),
        "band_unit": resolved.get("unit"),
        "what_it_needs": None,
    }
    if epi_value is None:
        out["reason"] = (
            f"{resolved['title']} ({resolved['version']}) is loaded and the "
            f"site's zone ({resolved['zone']}) and AC category "
            f"({resolved['ac_category']}) are set — the band renders as soon as "
            f"the EPI is computable; see `blocked` for what still stops it."
        )
        return out
    band = _band_for(resolved["band_table"], float(epi_value))
    if band is None:
        out["reason"] = (
            f"EPI {epi_value:.1f} {resolved.get('unit') or ''} is above the "
            f"1-star upper bound — the scheme awards no star at this intensity. "
            f"Graded against {resolved['title']} ({resolved['version']}), zone "
            f"{resolved['zone']}, {resolved['ac_category']}."
        )
        return out
    out["band"] = band
    out["reason"] = (
        f"{band['stars']}-star band per {resolved['title']} "
        f"({resolved['version']}), zone {resolved['zone']}, "
        f"{resolved['ac_category']}. NOTE the scheme's EPI excludes on-site "
        f"renewable generation and basement area — confirm the measured supply "
        f"matches that definition before quoting the star."
    )
    return out


# ── Baseline (contract §21) ──────────────────────────────────────────────────
#
# THE RULE, decided 2026-09-01 and recorded in §21: a "vs baseline" comparison
# means SAME CALENDAR MONTH, PREVIOUS YEAR. Weather drives HVAC load, and
# August answers August; a rolling-30-days baseline would compare a monsoon to
# a summer and call the difference savings. Until thirteen months of history
# exist (twelve to reach the same month last year, one to have the current
# month to compare), every baseline surface states the absence and the arith-
# metic of the gap — never a partial baseline, never a different month standing
# in.
BASELINE_RULE = {
    "rule": "same-calendar-month, previous year",
    "needs_months": 13,
    "statement": (
        "A baseline comparison is the same calendar month one year earlier. "
        "It needs ≥13 months of stored history; until then the comparison is "
        "stated as unavailable — with the day count — rather than substituted."
    ),
}

_HISTORY_SQL = """
    SELECT min(r.bucket) AS first_bucket
      FROM readings_1h r
      JOIN points p ON p.point_id = r.point_id
     WHERE p.site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
"""


async def baseline_state(
    db: AsyncSession, tenant: uuid.UUID | None, site_id: uuid.UUID
) -> dict:
    """The baseline rule, and whether this site's history can honour it yet."""
    rows = _rows(
        await db.execute(
            text(_HISTORY_SQL),
            {"site": str(site_id), "tenant": str(tenant) if tenant else None},
        )
    )
    first = rows[0]["first_bucket"] if rows else None
    now = dt.datetime.now(dt.timezone.utc)
    out = {**BASELINE_RULE, "first_bucket": first}
    if first is None:
        out.update(
            available=False,
            history_days=0.0,
            reason=(
                "baseline unavailable — needs ≥13 months of history, have "
                "0 days (no hourly bucket stored for this site yet)"
            ),
        )
        return out
    days = (now - first).total_seconds() / 86400.0
    months = days / 30.44
    if months < BASELINE_RULE["needs_months"]:
        out.update(
            available=False,
            history_days=days,
            reason=(
                f"baseline unavailable — needs ≥{BASELINE_RULE['needs_months']} "
                f"months of history, have {days:.1f} days. The rule is "
                f"same-calendar-month previous year; a shorter window would "
                f"compare different seasons and call the difference savings."
            ),
        )
        return out
    out.update(
        available=True,
        history_days=days,
        reason=(
            f"{days:.0f} days of history — the same calendar month last year "
            f"exists in the store and a baseline comparison is answerable."
        ),
    )
    return out
