"""The building's own record — the few facts no sensor sends, and what each one
switches on.

Four things about a building are statements, not measurements: how big it is,
what a unit of electricity costs, how much carbon a unit of grid electricity
carries, and which published yardstick it should be graded against (with the
climate zone and air-conditioned share that yardstick reads). Nothing derives
any of them — a city name is not a climate zone, and a floor plan is not an AC
share.

This endpoint assembles the whole record in one read: what is ON FILE, with
where it came from and when it was recorded, and what is MISSING, with the
figure that stays off until it is answered. Which facts are worth asking for is
read from the metric definitions (`nameplate.effective_rows`) the way the plate
facts and the reading roles are — an input whose `source` is `site_fact` or
`emission_factor` names one. Two columns the mirror still carries, `occupancy`
and `city`, are NOT here: no effective definition reads either, and a box
nobody's figure reads is not a box worth filling.

Nothing is written. The writes stay where they already are — core owns the area,
the tariff and the emission factors (`PATCH /sites/{id}`, `PUT
/sites/{id}/emission-factors`), and the benchmark inputs are `PUT
/bi/rating/benchmark-config`.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .nameplate import effective_rows
from .queries import _rows

#: What the star rating is, as something a fact can BLOCK. It is not a metric
#: definition, so it could not come out of the definitions table.
STAR_BAND = "bee_star_band"

_DEMANDS_SQL = """
    SELECT d.key, d.version, d.tenant_id,
           i.value->>'source' AS source, i.value->>'fact' AS fact
      FROM metric_definitions d
      JOIN LATERAL jsonb_each(d.inputs) i ON TRUE
     WHERE i.value->>'source' IN ('site_fact', 'emission_factor')
       AND (d.tenant_id IS NULL OR CAST(:tenant AS uuid) IS NULL
            OR d.tenant_id = CAST(:tenant AS uuid))
"""

_FACTS_SQL = """
    SELECT f.site_id, f.site_name, f.gross_floor_area_sqm, f.energy_tariff_per_kwh,
           f.tariff_currency, f.occupancy, f.facts_updated_at
      FROM site_facts f
     WHERE f.site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR f.tenant_id = CAST(:tenant AS uuid))
"""

#: The zones a standard version publishes bands for. A zone is an operator
#: statement, so the screen offers exactly the words the seeded table carries —
#: never a list of its own, which would drift from the document.
_ZONES_SQL = """
    SELECT jsonb_object_keys(b.bands->'zones') AS zone
      FROM benchmark_standards b
     WHERE b.key = :standard AND b.version = :version
"""

_FACTORS_SQL = """
    SELECT e.position, e.kg_co2_per_kwh, e.source, e.effective_from, e.mirrored_at
      FROM site_emission_factors e
     WHERE e.site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR e.tenant_id = CAST(:tenant AS uuid))
     ORDER BY e.position
"""


async def demands(db: AsyncSession, tenant: uuid.UUID | None) -> dict[str, set[str]]:
    """`{fact: {metric keys}}` for the EFFECTIVE definitions. An emission-factor
    input has no `fact` name of its own, so it is keyed by its source."""
    out: dict[str, set[str]] = {}
    rows = _rows(await db.execute(text(_DEMANDS_SQL), {"tenant": str(tenant) if tenant else None}))
    for r in effective_rows(rows):
        key = r["fact"] if r["source"] == "site_fact" and r["fact"] else r["source"]
        out.setdefault(key, set()).add(r["key"])
    return out


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def area_fact(row: dict, reads: set[str]) -> dict:
    """The floor area. Every per-square-metre figure divides by it, and the
    January-2022 star bands read the building's size category off it."""
    value = _num(row.get("gross_floor_area_sqm"))
    return {
        "key": "area",
        "label": "Floor area",
        "value": value,
        "unit": "m²",
        "source": None,
        "recorded_at": row.get("facts_updated_at") if value is not None else None,
        "reads": sorted(reads | {STAR_BAND}),
        "why": "Every per-square-metre figure divides by it, and the star bands read the building's size from it.",
    }


def tariff_fact(row: dict, reads: set[str]) -> dict:
    value = _num(row.get("energy_tariff_per_kwh"))
    return {
        "key": "tariff",
        "label": "Electricity rate",
        "value": value,
        "unit": f"{row.get('tariff_currency') or ''} / kWh".strip(),
        "source": None,
        "recorded_at": row.get("facts_updated_at") if value is not None else None,
        "reads": sorted(reads),
        "why": "What a unit of electricity costs — a rupee figure has no meaning without it.",
    }


def emission_fact(factors: list[dict], reads: set[str]) -> dict:
    """The grid's carbon per unit. Every factor carries its own citation, because
    a factor with no source is an invented figure."""
    return {
        "key": "emission_factor",
        "label": "Carbon per unit of grid electricity",
        "value": _num(factors[0]["kg_co2_per_kwh"]) if factors else None,
        "unit": "kg CO₂ / kWh",
        "source": factors[0].get("source") if factors else None,
        "recorded_at": factors[0].get("mirrored_at") if factors else None,
        "reads": sorted(reads),
        "why": "Published every year for the national grid; the carbon figure multiplies the electricity by it.",
        "factors": [
            {
                "position": f["position"],
                "kg_co2_per_kwh": _num(f["kg_co2_per_kwh"]),
                "source": f.get("source"),
                "effective_from": f.get("effective_from"),
            }
            for f in factors
        ],
    }


def benchmark_fact(resolved: dict, zones: list[str] | None = None) -> dict:
    """Which published yardstick grades this building, and the inputs its version
    in force reads. `missing` is the resolver's own word for what is unset."""
    ok = bool(resolved.get("ok"))
    zone = resolved.get("zone")
    share = resolved.get("ac_share_percent")
    return {
        "key": "benchmark",
        "label": "Which yardstick to grade against",
        "value": resolved.get("title") if resolved.get("standard") else None,
        "unit": None,
        "source": resolved.get("citation"),
        "recorded_at": None,
        "reads": [STAR_BAND],
        "why": "A star rating is a published scheme; its bands move with the climate zone and how much of the floor is air-conditioned.",
        "standard": resolved.get("standard"),
        "version": resolved.get("version"),
        "climate_zone": zone,
        "ac_category": resolved.get("ac_category"),
        "ac_share_percent": _num(share),
        "size_category": resolved.get("size_category"),
        # What the version in force still wants, in its own words.
        "missing": None if ok else resolved.get("missing"),
        "reason": resolved.get("reason"),
        "on_file": ok,
        # The words the seeded table itself publishes, for the one picker this
        # fact needs. Empty when no standard is loaded at all.
        "zone_options": sorted(zones or []),
    }


async def building_facts(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    site_id: uuid.UUID,
) -> dict:
    """One building's whole facts record: what is on file, and what is waiting."""
    from ..metric_registry.evaluator import resolve_benchmark

    params = {"tenant": str(tenant) if tenant else None, "site": str(site_id)}
    rows = _rows(await db.execute(text(_FACTS_SQL), params))
    if not rows:
        return {"site_id": str(site_id), "site_name": None, "on_file": [], "missing": [],
                "totals": {"on_file": 0, "missing": 0}, "known": False,
                "carried": {"occupancy": None, "tariff_currency": None}}
    row = rows[0]
    factors = _rows(await db.execute(text(_FACTORS_SQL), params))
    wanted = await demands(db, tenant)
    resolved = await resolve_benchmark(db, tenant, site_id, as_of=dt.datetime.now(dt.timezone.utc))
    zones: list[str] = []
    if resolved.get("standard") and resolved.get("version"):
        zones = [
            r["zone"]
            for r in _rows(
                await db.execute(
                    text(_ZONES_SQL),
                    {"standard": resolved["standard"], "version": resolved["version"]},
                )
            )
        ]

    facts = [
        area_fact(row, wanted.get("gross_floor_area_sqm", set())),
        tariff_fact(row, wanted.get("energy_tariff_per_kwh", set())),
        emission_fact(factors, wanted.get("emission_factor", set())),
        benchmark_fact(resolved, zones),
    ]
    on_file, missing = [], []
    for f in facts:
        # The benchmark is a set of inputs, so it says for itself whether it is
        # complete; the others are on file exactly when they carry a value.
        complete = f["on_file"] if f["key"] == "benchmark" else f["value"] is not None
        (on_file if complete else missing).append(f)

    return {
        "site_id": str(site_id),
        "site_name": row.get("site_name"),
        "known": True,
        # Core's building-facts write is a PUT of the WHOLE set, so a screen that
        # edits the area has to send back what it does not ask about or it would
        # clear it. `occupancy` is asked for nowhere and must still survive.
        "carried": {
            "occupancy": _num(row.get("occupancy")),
            "tariff_currency": row.get("tariff_currency"),
        },
        "on_file": on_file,
        "missing": missing,
        "totals": {"on_file": len(on_file), "missing": len(missing)},
    }
