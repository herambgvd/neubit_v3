"""The metric evaluator — computes a definition, or says exactly why it will not.

REFUSAL SEMANTICS (dashboard contract §4, mechanized)
-----------------------------------------------------
Every guard failure is a STRUCTURED ABSENCE: ``{"status": ..., "reason": ...}``
with a status the caller can branch on and a reason a human can read. Never 0,
never a null that renders as 0, never infinity. The statuses:

    ok                  a value, with the inputs and the arithmetic shown
    missing_role        no point on this device is confirmed in a needed role
    ambiguous_role      two points claim the same role — a human must pick one
    unit_unconfirmed    an input's point has no OPERATOR-confirmed unit; the
                        metric does not compute on an assumed unit, ever
    unit_mismatch       confirmed units break a guard (wrong dimension, or
                        `same_unit` with °C on one side and °F on the other —
                        conversion is not modelled, so this refuses)
    no_data             an input has no samples in the window
    undefined_frozen    an input has ONE distinct value over the window — zero
                        variance — and the definition demands `non_frozen`.
                        Names the flat input (Insights' discipline, inherited).
    missing_fact        a site-fact input (area, occupancy) is NOT RECORDED —
                        the refusal names the fact and where it is recorded
    missing_factor      a formula prices carbon and the site has no grid
                        emission factor effective at the window's end
    no_benchmark        the formula grades against a benchmark standard and one
                        of ITS inputs is missing: no standard seeded, or the
                        site's climate zone / AC-share category not set
    insufficient_coverage
                        an occupancy metric's inputs did not report together for
                        enough of the window (spec §7's coverage gate) — the
                        percentage is withheld, not computed from a partial one
    not_defined         a composite names a component that has no definition —
                        the component is DECLARED (with its weight) but nothing
                        computes it yet. Where the composite documents the
                        component, the refusal is that documentation: what the
                        metric is, what measures it, what is in the way
    slot_unbound        an equipment-scope input's slot is not bound to a point
    slot_unresolved     the slot's tag pair names no point in this store
    slot_ambiguous      the slot's tag pair names more than one live generation
                        and the window cannot say which one IS the meter
    missing_equipment   a site composite's equipment-scope component has no
                        equipment of its class at the site to evaluate
    blocked             arithmetic refused (division by zero) or a composite
                        component refused — a composite of a refusal is a
                        refusal, and the item carries EVERY component's own
                        {status, reason} so a dash can explain itself

SITE SCOPE (contract §21). `applies_to.scope: "site"` evaluates per SITE over
the `site_facts` mirror instead of per device. Inputs may then be site facts
(`source: "site_fact"`), the site's grid emission factor
(`source: "emission_factor"`, the row effective at the window's end, carrying
its own citation) or site-wide role bindings; aggregation `consumption`
is `last − first` per bound register (monotonic-guarded, a decreased register
is excluded and reported, exactly `/bi/rating`'s arithmetic), summed across
the role's registers. `annualize()` in a consumption formula scales over the
COVERED span (first→last bucket), not the requested window — the same
definition `/bi/rating` uses, so the two paths cannot disagree. A composite at
site scope fans device-scope components out over the site's devices and takes
the arithmetic mean of the ok values; ANY device refusal refuses the
component, naming each device's own status.

EQUIPMENT SCOPE. `applies_to.scope: "equipment"` evaluates per piece of
equipment in the registry mirror (`site_equipment`). A measured input names a
SLOT and is resolved to one point by `slots.resolve` over the SAME window — the
plant endpoint calls the same resolver, so a schematic and a metric cannot
disagree about which point CH-01's supply temperature is. A fact input
(`source: "equipment_fact"`) is the equipment's own design fact, injected into
the formula exactly as a site fact is at site scope; its published unit must be
the unit the vocabulary reads it in, and an absent one is `missing_fact`, never
a default. From binding on, the device path's guards, aggregates, frozen check
and per-bucket series are reused unchanged: an equipment metric refuses for the
same reasons any formula over the same points refuses.

READS ROLLUPS ONLY. `resolution=auto` picks 1m/1h exactly as the charts do and
the choice travels back with its reason; `raw` is refused by name, not
downgraded. Absence propagates: a bucket where only one input reported yields
no bucket, because on a ΔT a fabricated zero reads as a critical diagnosis.

VERSIONING. The definition used is the one EFFECTIVE AT the end of the
evaluated window. Yesterday evaluated under yesterday's formula.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows
from . import expr, registry
from . import slots as slot_store
from .units import UNIT_DIMENSION, DimensionError, Qty, compatible, qty_of_unit

# Mirrors the read API: 1m up to this many hours, 1h beyond.
_FINE_MAX_HOURS = 3
_MAX_DEVICES = 50
_MAX_COMPOSITE_DEPTH = 3


class EvaluationError(ValueError):
    """The REQUEST is malformed (unknown metric, bad resolution). HTTP 4xx."""


def _refusal(status: str, reason: str) -> dict:
    return {"status": status, "value": None, "reason": reason}


def pick_resolution(start: dt.datetime, end: dt.datetime, requested: str) -> tuple[str, str]:
    hours = (end - start).total_seconds() / 3600.0
    if requested == "raw":
        raise EvaluationError(
            "raw is refused: metrics read the rollups only (readings_1m / readings_1h)"
        )
    if requested in ("1m", "1h"):
        return requested, f"resolution {requested}, as requested"
    if requested != "auto":
        raise EvaluationError("resolution must be one of: auto, 1m, 1h")
    if hours <= _FINE_MAX_HOURS:
        return "1m", f"1-minute rollup: the window is {hours:.1f}h ≤ {_FINE_MAX_HOURS}h"
    return "1h", f"1-hour rollup: the window is {hours:.1f}h > {_FINE_MAX_HOURS}h"


_ROLE_POINTS_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.unit,
           p.unit_source, r.role
      FROM point_roles r
      JOIN points p ON p.point_id = r.point_id
     WHERE p.device_id = CAST(:device AS uuid)
       AND r.role = ANY(CAST(:roles AS varchar[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
"""

_DEVICES_SQL = """
    SELECT DISTINCT p.device_id, p.device_tag
      FROM points p
     WHERE p.device_id IS NOT NULL
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
     ORDER BY p.device_tag
     LIMIT :limit
"""

_AGG_SQL = """
    SELECT point_id,
           count(*)                                        AS buckets,
           min(bucket)                                     AS first_bucket,
           max(bucket)                                     AS last_bucket,
           sum(sample_count)                               AS samples,
           -- The SAMPLE-weighted mean, sum/count — the same definition the
           -- dataset registry's `ratio` aggregate uses, so the registry and a
           -- /bi/query widget over the same window cannot disagree on "avg".
           sum(num_sum) / NULLIF(sum(num_count), 0)        AS agg_avg,
           min(num_min)                                    AS agg_min,
           max(num_max)                                    AS agg_max,
           sum(num_sum)                                    AS agg_sum,
           (array_agg(num_first ORDER BY bucket ASC))[1]   AS agg_first,
           (array_agg(num_last  ORDER BY bucket DESC))[1]  AS agg_last
      FROM {table}
     WHERE point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
       AND bucket >= CAST(:start AS timestamptz)
       AND bucket <  CAST(:end AS timestamptz)
     GROUP BY point_id
"""

_BUCKETS_SQL = """
    SELECT point_id, bucket, num_avg, num_min, num_max, num_sum, num_first, num_last
      FROM {table}
     WHERE point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
       AND bucket >= CAST(:start AS timestamptz)
       AND bucket <  CAST(:end AS timestamptz)
     ORDER BY bucket
"""

_BUCKET_COL = {
    "avg": "num_avg",
    "last": "num_last",
    "first": "num_first",
    "min": "num_min",
    "max": "num_max",
    "sum": "num_sum",
}


async def _devices_for(
    db: AsyncSession, tenant, applies_to: dict, *, site_id=None
) -> list[dict]:
    where, params = "", {}
    if applies_to.get("category"):
        where += " AND p.category = :category"
        params["category"] = applies_to["category"]
    if applies_to.get("device_type"):
        where += " AND p.device_type = :device_type"
        params["device_type"] = applies_to["device_type"]
    if site_id is not None:
        where += " AND p.site_id = CAST(:site AS uuid)"
        params["site"] = str(site_id)
    sql = _DEVICES_SQL.format(live=LIVE_POINT, filters=where)
    return _rows(
        await db.execute(
            text(sql),
            {
                "tenant": str(tenant) if tenant else None,
                "retire_days": RETIRE_AFTER_DAYS,
                "limit": _MAX_DEVICES,
                **params,
            },
        )
    )


async def _items_over_sites(
    db: AsyncSession, tenant, defn: dict, site_id, start, end, res, table, depth
) -> list[dict]:
    """One item per site the metric applies to, each carrying its own outcome."""
    sites = await _sites_for(db, tenant, site_id)
    if site_id is not None and not sites:
        raise EvaluationError("no such site in this tenant's reporting store")
    items = []
    for site in sites:
        if defn["kind"] == "composite":
            item = await _evaluate_site_composite(
                db, tenant, defn, site, start, end, res, depth
            )
        else:
            item = await _evaluate_site_formula(
                db, tenant, defn, site, start, end, table
            )
        item["site_id"] = str(site["site_id"])
        if site.get("site_name"):
            item["site_name"] = site["site_name"]
        items.append(item)
    return items


async def _items_over_devices(
    db: AsyncSession, tenant, defn: dict, device_id, site_id,
    start, end, res, table, depth
) -> list[dict]:
    """One item per device the metric applies to, each carrying its own outcome."""
    if device_id is not None:
        devices = [{"device_id": device_id, "device_tag": None}]
    else:
        devices = await _devices_for(
            db, tenant, defn.get("applies_to") or {}, site_id=site_id
        )
    items = []
    for d in devices:
        if defn["kind"] == "composite":
            item = await _evaluate_composite(
                db, tenant, defn, d["device_id"], start, end, res, depth
            )
        elif defn["kind"] == "occupancy":
            item = await _evaluate_occupancy(
                db, tenant, defn, d["device_id"], start, end, table
            )
        else:
            item = await _evaluate_formula(db, tenant, defn, d["device_id"], start, end, table)
        item["device_id"] = str(d["device_id"])
        if d.get("device_tag"):
            item["device_tag"] = d["device_tag"]
        items.append(item)
    return items


# ── EQUIPMENT SCOPE ──────────────────────────────────────────────────────────

# A slot that does not name exactly one REPORTING point refuses with the status
# that says which of the four ways it failed; the sentence is the resolver's, so
# the metric and the plant schematic say the same thing about the same slot.
_SLOT_REFUSAL = {
    slot_store.UNBOUND: "slot_unbound",
    slot_store.UNRESOLVED: "slot_unresolved",
    slot_store.AMBIGUOUS: "slot_ambiguous",
    # Resolved, and silent: the binding is right and the signal stopped. That is
    # `no_data` everywhere else in this module, and it stays `no_data` here.
    slot_store.SILENT: "no_data",
}


def _bind_slots(equipment: dict, inputs: dict, resolutions: dict) -> dict:
    """The one reporting point behind each slot input, or why there is none."""
    bound: dict[str, dict] = {}
    for name, spec in inputs.items():
        slot = spec["slot"]
        r = resolutions.get((str(equipment["equipment_id"]), slot))
        if r is None:
            # The equipment has no such slot at all — the same statement, for a
            # metric, as a slot with no binding.
            r = slot_store.resolve({"slot": slot}, None)
        if r["readiness"] != slot_store.REPORTING:
            out = _refusal(
                _SLOT_REFUSAL[r["readiness"]],
                f"input `{name}` on {equipment['tag']}: {r['reason']}",
            )
            if r.get("candidates"):
                out["candidates"] = r["candidates"]
            return out
        bound[name] = r["point"]
    return {"status": "ok", "bound": bound}


def _equipment_facts(equipment: dict, inputs: dict) -> dict:
    """Each design-fact input as a number, stated in the unit it is read in.

    NOT RECORDED is a refusal naming the fact, and there is no fallback: a
    chiller with no design ΔT band is not graded against a typical one, because
    then a graded chiller and a guessed one would render identically.
    """
    env: dict[str, float] = {}
    report: list[dict] = []
    for name, spec in inputs.items():
        fact = spec["fact"]
        fact_def = slot_store.EQUIPMENT_FACT_DEFS[fact]
        want = fact_def["qty"].unit
        value = slot_store.fact_value(equipment["design"], fact)
        if value is None:
            return _refusal(
                "missing_fact",
                f"input `{name}`: {equipment['tag']} has no `{fact}` "
                f"({fact_def['label']}) recorded — record it on the equipment in "
                f"{slot_store.RECORDED_AT}; nothing is defaulted, and no typical "
                f"value stands in for it",
            )
        unit = (equipment.get("design_units") or {}).get(fact)
        if unit != want:
            return _refusal(
                "unit_mismatch",
                f"input `{name}`: {equipment['tag']}'s `{fact}` is stated in "
                f"`{unit or 'no unit'}` and this metric reads it in `{want}` — "
                f"conversion is not modelled, so it refuses rather than reading the "
                f"number as `{want}`",
            )
        env[name] = value
        report.append({"input": name, "source": "equipment_fact", "fact": fact,
                       "value": value, "unit": unit})
    return {"status": "ok", "env": env, "inputs": report}


def _declared_output(defn: dict) -> Qty:
    out = defn.get("output") or {}
    if out.get("unit") is not None:
        return qty_of_unit(out["unit"])
    return Qty(out.get("dimension") or "dimensionless", None)


def _concrete_units_refusal(
    defn: dict, point_inputs: dict, bound: dict, fact_inputs: dict
) -> dict | None:
    """The formula type-checked AGAIN, on the units actually confirmed.

    Registration checks a definition declared by dimension; it cannot know that
    this chiller's temperatures are confirmed in °F, which makes its ΔT a °F
    delta that a band stated in K does not bound. Re-running the same inference
    with the confirmed units catches that — and a watt meter under a `kW/TR`
    output — with the algebra's own sentence, instead of a number off by a
    factor nobody printed.
    """
    qenv: dict[str, Qty] = {}
    for name in point_inputs:
        unit = bound[name]["unit"]
        if unit is None:
            return None  # an unguarded, unit-open definition: nothing to check
        try:
            qenv[name] = qty_of_unit(unit)
        except DimensionError as exc:
            return _refusal("unit_mismatch", f"input `{name}`: {exc}")
    for name, spec in fact_inputs.items():
        qenv[name] = slot_store.EQUIPMENT_FACT_DEFS[spec["fact"]]["qty"]
    try:
        inferred = expr.infer(expr.parse(defn["formula"]), qenv)
    except DimensionError as exc:
        return _refusal(
            "unit_mismatch",
            f"with the units confirmed on these points the formula does not "
            f"type-check: {exc}",
        )
    declared = _declared_output(defn)
    if not compatible(declared, inferred):
        return _refusal(
            "unit_mismatch",
            f"with the units confirmed on these points the formula produces "
            f"`{inferred.unit or inferred.dimension}`, not the declared "
            f"`{declared.unit or declared.dimension}`",
        )
    return None


async def _evaluate_equipment(
    db: AsyncSession, tenant, defn: dict, equipment: dict, resolutions: dict,
    start, end, table: str,
) -> dict:
    """One piece of equipment: its slots bound, its facts read, then the device
    path's own machinery from the unit guards onward."""
    inputs: dict = defn["inputs"]
    point_inputs = {n: s for n, s in inputs.items() if s.get("source") == "slot"}
    fact_inputs = {n: s for n, s in inputs.items() if s.get("source") == "equipment_fact"}

    binding = _bind_slots(equipment, point_inputs, resolutions)
    if binding["status"] != "ok":
        return binding
    bound = binding["bound"]

    facts = _equipment_facts(equipment, fact_inputs)
    if facts["status"] != "ok":
        return facts

    refused = _unit_guards_refusal(defn.get("guards") or [], point_inputs, bound)
    if refused is None:
        refused = _concrete_units_refusal(defn, point_inputs, bound, fact_inputs)
    if refused is not None:
        return refused

    base = await _evaluate_bound(
        db, tenant, defn, point_inputs, bound, start, end, table,
        constants=facts["env"], constant_report=facts["inputs"],
    )
    if defn["kind"] == "occupancy":
        return await _occupancy_from(db, tenant, defn, base, start, end, table)
    return base


async def _items_over_equipment(
    db: AsyncSession, tenant, defn: dict, equipment_id, site_id, start, end, table
) -> list[dict]:
    """One item per piece of equipment of the metric's class, each its own outcome."""
    applies = defn.get("applies_to") or {}
    equipment = await slot_store.load_equipment(
        db, tenant, site_id=site_id, equipment_id=equipment_id,
        equipment_class=applies.get("equipment_class"), limit=_MAX_DEVICES,
    )
    if equipment_id is not None and not equipment:
        raise EvaluationError(
            f"no {applies.get('equipment_class') or 'equipment'} with that id in "
            f"this tenant's equipment registry"
        )
    slot_names = {
        spec["slot"] for spec in defn["inputs"].values() if spec.get("source") == "slot"
    }
    resolutions = await slot_store.resolve_equipment(
        db, equipment, start=start, end=end, slot_names=slot_names
    )
    items = []
    for e in equipment:
        item = await _evaluate_equipment(db, tenant, defn, e, resolutions, start, end, table)
        item.update(
            equipment_id=str(e["equipment_id"]),
            equipment_tag=e["tag"],
            equipment_class=e["equipment_class"],
            system_id=str(e["system_id"]),
            site_id=str(e["site_id"]),
        )
        items.append(item)
    return items


async def evaluate(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    key: str,
    *,
    device_id: uuid.UUID | None = None,
    site_id: uuid.UUID | None = None,
    equipment_id: uuid.UUID | None = None,
    start: dt.datetime,
    end: dt.datetime,
    resolution: str = "auto",
    _depth: int = 0,
) -> dict:
    """Evaluate `key` over [start, end) — per device (scope "device", the §20
    shape) or per site (scope "site"). Top-level shape is always the same;
    each item's outcome is its own `{status, ...}`."""
    defn = await registry.effective(db, tenant, key, end)
    if defn is None:
        raise EvaluationError(f"no metric `{key}` is effective at {end.isoformat()}")
    res, res_reason = pick_resolution(start, end, resolution)
    table = "readings_1m" if res == "1m" else "readings_1h"
    scope = (defn.get("applies_to") or {}).get("scope", "device")

    if scope == "site":
        items = await _items_over_sites(
            db, tenant, defn, site_id, start, end, res, table, _depth
        )
    elif scope == "equipment":
        if device_id is not None:
            # A device is not a piece of equipment: one chiller's slots may sit on
            # several gateway devices and one device may feed several chillers.
            raise EvaluationError(
                f"`{key}` is evaluated per piece of equipment; pass equipment_id "
                f"or site_id, not device_id"
            )
        items = await _items_over_equipment(
            db, tenant, defn, equipment_id, site_id, start, end, table
        )
    else:
        items = await _items_over_devices(
            db, tenant, defn, device_id, site_id, start, end, res, table, _depth
        )

    return {
        "metric": defn["key"],
        "version": defn["version"],
        "effective_from": defn["effective_from"],
        "kind": defn["kind"],
        "formula": defn.get("formula"),
        "display": defn.get("display"),
        "output": defn.get("output"),
        "window": {"start": start, "end": end},
        "resolution": res,
        "resolution_reason": res_reason,
        "items": items,
    }


async def _bind_roles_on_device(
    db: AsyncSession, tenant, device_id, inputs: dict
) -> dict:
    """The one point behind each input, or why the binding is not decidable.

    A metric will not guess between two points claiming the same role: the
    ambiguity is the operator's to resolve, and naming both is how they find it.
    """
    roles_needed = {name: spec["role"] for name, spec in inputs.items()}
    rows = _rows(
        await db.execute(
            text(_ROLE_POINTS_SQL.format(live=LIVE_POINT)),
            {
                "device": str(device_id),
                "roles": list(set(roles_needed.values())),
                "tenant": str(tenant) if tenant else None,
                "retire_days": RETIRE_AFTER_DAYS,
            },
        )
    )
    by_role: dict[str, list[dict]] = {}
    for r in rows:
        by_role.setdefault(r["role"], []).append(r)

    bound: dict[str, dict] = {}
    for name, role in roles_needed.items():
        candidates = by_role.get(role) or []
        if not candidates:
            return _refusal(
                "missing_role",
                f"no point on this device is confirmed in role `{role}` "
                f"(input `{name}`) — confirm one on the Metric Roles screen",
            )
        if len(candidates) > 1:
            tags = ", ".join(str(c["point_tag"]) for c in candidates)
            return _refusal(
                "ambiguous_role",
                f"{len(candidates)} points ({tags}) are confirmed in role `{role}` "
                f"on this device — a metric cannot pick one; clear the extras",
            )
        bound[name] = candidates[0]
    return {"status": "ok", "bound": bound}


def _unconfirmed_units_refusal(bound: dict[str, dict]) -> dict | None:
    """Which bound points still carry a unit nobody confirmed."""
    bad = [n for n, p in bound.items() if p["unit_source"] != "operator"]
    if not bad:
        return None
    named = ", ".join(f"`{bound[n]['point_tag']}` ({n})" for n in bad)
    return _refusal(
        "unit_unconfirmed",
        f"no operator has confirmed a unit for {named} — the metric does "
        f"not compute on an assumed unit; confirm it on the Units tab",
    )


def _input_unit_refusal(name: str, spec: dict, point: dict) -> dict | None:
    """Whether one input's confirmed unit is the unit (or dimension) it asks for."""
    unit = point["unit"]
    if unit is None:
        return None  # unguarded definitions may run unit-open; dimension unknown
    want_unit, want_dim = spec.get("unit"), spec.get("dimension")
    if want_unit is not None and unit != want_unit:
        return _refusal(
            "unit_mismatch",
            f"input `{name}` requires `{want_unit}` and point "
            f"`{point['point_tag']}` is confirmed as `{unit}`",
        )
    dim = UNIT_DIMENSION.get(unit)
    if want_dim is not None and dim != want_dim:
        return _refusal(
            "unit_mismatch",
            f"input `{name}` requires dimension `{want_dim}` and "
            f"`{unit}` is `{dim or 'unknown'}`",
        )
    return None


def _mixed_units_refusal(bound: dict[str, dict]) -> dict | None:
    """Inputs that must share a unit but do not — conversion is not modelled."""
    units = {n: bound[n]["unit"] for n in bound}
    distinct = set(units.values())
    if len(distinct) <= 1:
        return None
    named = ", ".join(f"{n}=`{u}`" for n, u in units.items())
    return _refusal(
        "unit_mismatch",
        f"inputs are in different units ({named}) and conversion is not "
        f"modelled — this refuses rather than converts silently",
    )


def _unit_guards_refusal(guards: list, inputs: dict, bound: dict) -> dict | None:
    """The unit guards, in order of most fundamental first."""
    if "units_confirmed" in guards:
        refused = _unconfirmed_units_refusal(bound)
        if refused is not None:
            return refused
    for name, spec in inputs.items():
        refused = _input_unit_refusal(name, spec, bound[name])
        if refused is not None:
            return refused
    if "same_unit" in guards:
        return _mixed_units_refusal(bound)
    return None


async def _device_aggregates(
    db: AsyncSession, tenant, bound: dict, start, end, table: str
) -> dict:
    """The rollup aggregate behind every bound point — one query, all of them."""
    aggs = {
        r["point_id"]: r
        for r in _rows(
            await db.execute(
                text(_AGG_SQL.format(table=table)),
                {
                    "pids": [str(p["point_id"]) for p in bound.values()],
                    "tenant": str(tenant) if tenant else None,
                    "start": start,
                    "end": end,
                },
            )
        )
    }
    for name, p in bound.items():
        if p["point_id"] not in aggs:
            return _refusal(
                "no_data",
                f"input `{name}` (`{p['point_tag']}`) has no samples in the "
                f"window at this resolution — absence is absence, not zero",
            )
    return {"status": "ok", "aggs": aggs}


def _frozen_input_refusal(guards: list, bound: dict, aggs: dict) -> dict | None:
    """An input that never moved across the window, where the definition forbids it."""
    if "non_frozen" not in guards:
        return None
    for name, p in bound.items():
        a = aggs[p["point_id"]]
        samples = int(a["samples"] or 0)
        if (
            samples >= 2
            and a["agg_min"] is not None
            and a["agg_min"] == a["agg_max"]
        ):
            return _refusal(
                "undefined_frozen",
                f"input `{name}` (`{p['point_tag']}`) held one distinct value "
                f"({a['agg_min']:g}) across {samples} samples — zero variance, "
                f"so the metric is undefined here, not zero",
            )
    return None


def _device_input_values(inputs: dict, bound: dict, aggs: dict) -> dict:
    """Each input's aggregate as a number, with the provenance shown beside it."""
    env: dict[str, float] = {}
    report = []
    for name, spec in inputs.items():
        p = bound[name]
        a = aggs[p["point_id"]]
        agg = spec.get("aggregation", "avg")
        v = a[f"agg_{agg}"]
        if v is None:
            return _refusal(
                "no_data",
                f"input `{name}` (`{p['point_tag']}`) has no numeric samples in the window",
            )
        env[name] = float(v)
        row = {"input": name, "role": spec.get("role")}
        if spec.get("slot"):
            row["slot"] = spec["slot"]
        report.append(
            {
                **row,
                "point_id": str(p["point_id"]),
                "point_tag": p["point_tag"],
                "unit": p["unit"],
                "unit_source": p["unit_source"],
                "aggregation": agg,
                "value": float(v),
                "buckets": int(a["buckets"] or 0),
                "samples": int(a["samples"] or 0),
            }
        )
    return {"status": "ok", "env": env, "inputs": report}


async def _evaluate_formula(
    db: AsyncSession,
    tenant,
    defn: dict,
    device_id,
    start,
    end,
    table: str,
) -> dict:
    inputs: dict = defn["inputs"]
    binding = await _bind_roles_on_device(db, tenant, device_id, inputs)
    if binding["status"] != "ok":
        return binding
    return await _evaluate_bound(
        db, tenant, defn, inputs, binding["bound"], start, end, table
    )


async def _evaluate_bound(
    db: AsyncSession,
    tenant,
    defn: dict,
    inputs: dict,
    bound: dict[str, dict],
    start,
    end,
    table: str,
    *,
    constants: dict[str, float] | None = None,
    constant_report: list[dict] | None = None,
) -> dict:
    """Everything after binding, shared by the device and equipment paths.

    `inputs` are the MEASURED inputs only, each bound to one point in `bound`.
    `constants` are inputs that are already a number — an equipment's design
    facts — and enter the arithmetic, and every bucket of the series, as they
    are. They are reported beside the measured inputs so the working shows where
    each number came from.
    """
    guards: list = defn.get("guards") or []
    constants = dict(constants or {})

    refused = _unit_guards_refusal(guards, inputs, bound)
    if refused is not None:
        return refused

    read = await _device_aggregates(db, tenant, bound, start, end, table)
    if read["status"] != "ok":
        return read
    aggs = read["aggs"]

    refused = _frozen_input_refusal(guards, bound, aggs)
    if refused is not None:
        return refused

    values = _device_input_values(inputs, bound, aggs)
    if values["status"] != "ok":
        return values
    env = {**values["env"], **constants}
    input_report = values["inputs"] + list(constant_report or [])

    # ── arithmetic, shown ────────────────────────────────────────────────────
    tree = expr.parse(defn["formula"])
    window_days = (end - start).total_seconds() / 86400.0
    try:
        value = expr.evaluate(tree, env, window_days=window_days)
    except expr.EvalRefusal as e:
        out = _refusal(e.status, e.reason)
        out["inputs"] = input_report
        return out

    # per-bucket series: inner alignment; a bucket missing a side is absent.
    series = await _series(
        db, tenant, defn, bound, start, end, table, window_days, constants=constants
    )

    return {
        "status": "ok",
        "value": value,
        "unit": (defn.get("output") or {}).get("unit"),
        "dimension": (defn.get("output") or {}).get("dimension"),
        "inputs": input_report,
        "arithmetic": f"{defn['formula']} = {expr.render(tree, env)} = {value:g}",
        "series": series,
    }


_UNION_BUCKETS_SQL = """
    SELECT count(DISTINCT bucket) AS buckets
      FROM {table}
     WHERE point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
       AND bucket >= CAST(:start AS timestamptz)
       AND bucket <  CAST(:end AS timestamptz)
"""

# Spec §7's coverage gate. A component is scored only where coverage reaches
# this; below it the component is "insufficient data" and refuses rather than
# reporting a percentage computed from a fraction of the window.
_MIN_COVERAGE = 0.80


async def _evaluate_occupancy(
    db: AsyncSession, tenant, defn: dict, device_id, start, end, table: str
) -> dict:
    """Band occupancy — spec §3.3, `band% = Σ minutes in band / Σ valid minutes`.

    The formula is evaluated ONCE PER BUCKET and the answer is the mean of the
    resulting ones and zeros. That ordering is the whole point: aggregating the
    inputs first and testing the band once answers a different question, because
    an average ΔT can sit inside a band the instantaneous ΔT left for half the
    window.

    Binding, unit checks and the frozen guard are `_evaluate_formula`'s — this
    metric must refuse for exactly the same reasons any other formula over the
    same roles refuses, and a second implementation of those rules would be a
    second set of bugs. Only the SCALAR it computed is discarded: for an
    `in_band` formula over window aggregates that scalar is a single 1 or 0,
    which is the misleading number this kind exists to avoid ever showing.

    COVERAGE, and what it does and does not measure. The denominator is the
    number of buckets where ANY bound input reported; the numerator is those
    where ALL of them did. So it catches the failure it can actually see — one
    input dropping out while its partner keeps reporting, which silently shrinks
    the sample the percentage is computed from. It does NOT catch a window where
    every input went quiet together: to that, a poll every five minutes and a
    poll every hour look alike, and this estate declares no expected cadence to
    compare against. Stating the narrower measure beats dressing a wider claim
    in the same number.
    """
    base = await _evaluate_formula(db, tenant, defn, device_id, start, end, table)
    return await _occupancy_from(db, tenant, defn, base, start, end, table)


async def _occupancy_from(
    db: AsyncSession, tenant, defn: dict, base: dict, start, end, table: str
) -> dict:
    """The occupancy of an already-evaluated formula — see `_evaluate_occupancy`.

    Split out so the equipment path, which binds its points differently, scores
    band occupancy with exactly this arithmetic and this coverage gate.
    """
    if base["status"] != "ok":
        return base

    series = base.get("series") or []
    # Measured inputs only: a design fact has no point id and no buckets, and
    # counting it would make every bucket look covered.
    pids = [i["point_id"] for i in base.get("inputs") or [] if i.get("point_id")]
    union_rows = _rows(
        await db.execute(
            text(_UNION_BUCKETS_SQL.format(table=table)),
            {"pids": pids, "tenant": str(tenant) if tenant else None,
             "start": start, "end": end},
        )
    )
    union = int((union_rows[0]["buckets"] if union_rows else 0) or 0)

    if not series:
        out = _refusal(
            "no_data",
            "no bucket in the window had every input reporting, so there are no "
            "valid minutes to compute a band occupancy over",
        )
        out["inputs"] = base.get("inputs")
        return out

    coverage = len(series) / union if union else 0.0
    if coverage < _MIN_COVERAGE:
        out = _refusal(
            "insufficient_coverage",
            f"only {len(series)} of {union} bucket(s) had every input reporting "
            f"({coverage * 100:.0f}%) — below the {_MIN_COVERAGE * 100:.0f}% this "
            f"metric is scored at, so the occupancy is withheld rather than "
            f"computed from a partial window",
        )
        out["inputs"] = base.get("inputs")
        out["coverage"] = round(coverage, 4)
        return out

    inside = sum(1 for pt in series if pt["value"])
    pct = 100.0 * inside / len(series)
    return {
        "status": "ok",
        "value": pct,
        "unit": (defn.get("output") or {}).get("unit"),
        "dimension": (defn.get("output") or {}).get("dimension"),
        "inputs": base.get("inputs"),
        "coverage": round(coverage, 4),
        "buckets_in_band": inside,
        "buckets_valid": len(series),
        "arithmetic": (
            f"{inside} of {len(series)} bucket(s) inside the band "
            f"(`{defn['formula']}`) = {pct:g}%"
        ),
        "series": series,
    }


async def _series(
    db, tenant, defn, bound, start, end, table, window_days, *, constants=None
) -> list[dict]:
    cols = {
        name: _BUCKET_COL[spec.get("aggregation", "avg")]
        for name, spec in defn["inputs"].items()
        if name in bound
    }
    rows = _rows(
        await db.execute(
            text(_BUCKETS_SQL.format(table=table)),
            {
                "pids": [str(p["point_id"]) for p in bound.values()],
                "tenant": str(tenant) if tenant else None,
                "start": start,
                "end": end,
            },
        )
    )
    per_point: dict[str, dict] = {}
    for r in rows:
        per_point.setdefault(str(r["point_id"]), {})[r["bucket"]] = r
    tree = expr.parse(defn["formula"])
    out = []
    buckets_per_input = [
        set(per_point.get(str(p["point_id"]), {})) for p in bound.values()
    ]
    common = set.intersection(*buckets_per_input) if buckets_per_input else set()
    for b in sorted(common):
        env = dict(constants or {})
        ok = True
        for name, p in bound.items():
            v = per_point[str(p["point_id"])][b][cols[name]]
            if v is None:
                ok = False
                break
            env[name] = float(v)
        if not ok:
            continue  # absence propagates — no fabricated bucket
        try:
            out.append({"t": b, "value": expr.evaluate(tree, env, window_days=window_days)})
        except expr.EvalRefusal:
            continue  # a bucket that refuses is absent, not zero
    return out


async def _evaluate_composite(
    db, tenant, defn, device_id, start, end, res, depth
) -> dict:
    if depth >= _MAX_COMPOSITE_DEPTH:
        return _refusal("blocked", f"composite nesting deeper than {_MAX_COMPOSITE_DEPTH} is refused")
    parts = []
    for c in defn["components"]:
        sub_defn = await registry.effective(db, tenant, c["metric"], end)
        if sub_defn is None:
            # A component named but not defined — the same state the site path
            # reports as `not_defined`, and the same sentence. Letting
            # `evaluate` raise here failed the WHOLE request on one undefined
            # leaf, so a pack that ships a component ahead of its metric (the
            # normal way a pack grows) returned an error instead of a composite
            # that says which part is missing and why. A refusal beats an
            # exception on both paths or the two paths mean different things.
            parts.append({"metric": c["metric"], "weight": c["weight"],
                          "status": "not_defined", "value": None,
                          "reason": _undefined_reason(defn, c["metric"], end)})
            continue
        sub = await evaluate(
            db, tenant, c["metric"],
            device_id=device_id, start=start, end=end, resolution=res,
            _depth=depth + 1,
        )
        item = sub["items"][0]
        parts.append(
            {
                "metric": c["metric"],
                "version": sub["version"],
                "weight": c["weight"],
                "status": item["status"],
                "value": item.get("value"),
                "reason": item.get("reason"),
            }
        )
    return _compose(defn, parts)


def _compose(defn: dict, parts: list[dict]) -> dict:
    """Weighted sum when EVERY component evaluated; a structured refusal that
    still carries every component's own {status, reason} otherwise — a
    composite of a refusal is a refusal, and the dash it renders as must be
    able to explain itself input by input."""
    refused = [p for p in parts if p["status"] != "ok"]
    if refused:
        named = "; ".join(
            f"`{p['metric']}` {p['status']}: {p['reason']}" for p in refused
        )
        out = _refusal(
            "blocked",
            f"{len(refused)} of {len(parts)} component(s) did not evaluate — a "
            f"composite of a refusal is a refusal. {named}",
        )
        out["components"] = parts
        return out
    total = sum(float(p["weight"]) * float(p["value"]) for p in parts)
    working = " + ".join(f"{p['weight']:g} × {p['metric']}({p['value']:g})" for p in parts)
    return {
        "status": "ok",
        "value": total,
        "unit": (defn.get("output") or {}).get("unit"),
        "dimension": (defn.get("output") or {}).get("dimension"),
        "components": parts,
        "arithmetic": f"{working} = {total:g}",
    }


# ── SITE SCOPE (contract §21) ────────────────────────────────────────────────

_SITES_SQL = """
    SELECT f.site_id, f.site_name, f.gross_floor_area_sqm, f.occupancy
      FROM site_facts f
     WHERE (CAST(:tenant AS uuid) IS NULL OR f.tenant_id = CAST(:tenant AS uuid))
       AND (CAST(:site AS uuid) IS NULL OR f.site_id = CAST(:site AS uuid))
     ORDER BY f.site_name NULLS LAST
"""

_SITE_ROLE_POINTS_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.unit,
           p.unit_source, r.role
      FROM point_roles r
      JOIN points p ON p.point_id = r.point_id
     WHERE p.site_id = CAST(:site AS uuid)
       AND r.role = ANY(CAST(:roles AS varchar[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
"""

# WHICH VERSION APPLIES (contract §21 addendum): the LATEST version whose
# effective date ≤ the evaluation window's END — jan-2022 for today's windows,
# feb-2009 for historical windows that end before 2022-01-01. Versioning is
# data; the old row is never edited or removed. A NULL effective_from (pre-0017
# rows mid-migration) sorts last and only matches when nothing dated does.
_BENCHMARK_SQL = """
    SELECT key, version, title, citation, source_url, bands, notes,
           effective_from
      FROM benchmark_standards
     WHERE key = :key
       AND (effective_from IS NULL OR effective_from <= CAST(:as_of AS date))
     ORDER BY effective_from DESC NULLS LAST, created_at DESC
     LIMIT 1
"""

_SITE_AREA_SQL = """
    SELECT gross_floor_area_sqm
      FROM site_facts
     WHERE site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
"""

_BENCHMARK_CONFIG_SQL = """
    SELECT site_id, standard_key, climate_zone, ac_category
      FROM benchmark_site_config
     WHERE site_id = CAST(:site AS uuid)
"""


async def _sites_for(db: AsyncSession, tenant, site_id) -> list[dict]:
    return _rows(
        await db.execute(
            text(_SITES_SQL),
            {"tenant": str(tenant) if tenant else None,
             "site": str(site_id) if site_id else None},
        )
    )


def size_category_for(area_sqm: float) -> str:
    """The 2022 schedule's building size category, DERIVED from the recorded
    built-up area — never stored separately, so a corrected area
    re-categorises the site without a second fact drifting out of step.

    Per the document (in line with ECBC 2017): Large BUA > 30,000 m²;
    Medium 10,000 ≤ BUA ≤ 30,000 m²; Small BUA < 10,000 m². NOTE the
    document's Terminology section prints the Medium range garbled
    ("30,000 m² ≤ BUA < 10,000 m²"); it is read as 10,000–30,000, consistent
    with the document's own fees table.
    """
    if area_sqm > 30000:
        return "large"
    if area_sqm >= 10000:
        return "medium"
    return "small"


def linear_band_table(star_coeffs: dict, ac_share: float) -> list[dict]:
    """The jan-2022 star bands at ONE site's AC share — rendered in the same
    {stars, min, max} shape the fixed-range tables use, so `_band_for` grades
    both kinds with one rule.

    Each star's equation y = a·x + c (x = percentage of AC area out of total
    built-up area) is evaluated at x = ac_share. BOUNDARY SEMANTICS, from the
    document's own worked example (Section 6, quoted verbatim): "any building
    having 75% AC area, and having EPI less than 131.25 kwh/sqm. but equals
    to or more than 117.5 kwh/sqm. that building will be awarded 2-star
    rating" — where 131.25 is the 1-star equation and 117.5 the 2-star
    equation at x=75. So the s-star equation value is the INCLUSIVE LOWER
    edge of the s-star band and the exclusive upper edge is the (s−1)-star
    equation:

        5★:  EPI < y₄          (open below; y₅ is the stated 5-star edge and
                                nothing better than it has a sixth star)
        s★:  yₛ ≤ EPI < yₛ₋₁   (s = 2..4)
        1★:  EPI ≥ y₁          ("Lowest EPI value for 1-Star will be: …")

    The document's header line ("the equations provide the upper limit of the
    corresponding Star Rating") disagrees with its own example; the example
    is the precise statement and is what is encoded. Stated in the seeded
    row's notes (migration 0017) as well.
    """
    y = {s: float(star_coeffs[str(s)]["a"]) * float(ac_share)
            + float(star_coeffs[str(s)]["c"])
         for s in range(1, 6)}
    eq = {s: f"{star_coeffs[str(s)]['a']:g}x+{star_coeffs[str(s)]['c']:g}"
          for s in range(1, 6)}
    out = []
    for s in range(5, 0, -1):
        out.append({
            "stars": s,
            "min": None if s == 5 else y[s],
            "max": None if s == 1 else y[s - 1],
            "equation": eq[s],
            "equation_value": y[s],
        })
    return out


def _benchmark_head(std: dict) -> dict:
    """What is already established about the standard itself.

    It travels onto EVERY return below, refusals included, and grows as each
    further fact is established. A blocked state must name what EXISTS as well
    as what is missing — "the standard is loaded and cited, your zone is set,
    only the AC share is not" is a different situation from "no standard at
    all", and the screen has to be able to say which. Dropping the citation on
    the refusal path made a cited standard look uncited.
    """
    bands = std["bands"] or {}
    return {
        "standard": std["key"], "version": std["version"], "title": std["title"],
        "kind": bands.get("kind") or "fixed_ranges",
        "citation": std.get("citation"),
        "effective_from": (
            std["effective_from"].isoformat() if std.get("effective_from") else None
        ),
    }


async def _linear_by_ac_share_bands(
    db: AsyncSession, tenant, site_id, std: dict, head: dict,
    cfg: dict, zone_def: dict
) -> dict:
    """The 2022 model: straight-line equations in the AC-share percentage, per
    building size category derived from the recorded built-up area."""
    bands = std["bands"] or {}
    zone = head["zone"]
    area_rows = _rows(
        await db.execute(
            text(_SITE_AREA_SQL),
            {"site": str(site_id),
             "tenant": str(tenant) if tenant else None},
        )
    )
    area = area_rows[0]["gross_floor_area_sqm"] if area_rows else None
    if area is None:
        return {
            **head, "ok": False,
            "missing": "gross_floor_area_sqm",
            "reason": (
                f"built-up area not recorded for this site — {std['title']} "
                f"({std['version']}) sizes its equations by BUA (Large > "
                f"30,000 m²; Medium 10,000–30,000 m²; Small < 10,000 m²); "
                f"record `gross_floor_area_sqm` in Building Intelligence → Setup → Building facts"
            ),
        }
    size = size_category_for(float(area))
    # (the recorded area itself already travels on the response's `site`
    # object; only the derived category is new information here)
    head["size_category"] = size
    ac_share = cfg.get("ac_share_percent")
    if ac_share is None:
        return {
            **head, "ok": False,
            "missing": "ac_share_percent",
            "reason": (
                f"`ac_share_percent` not recorded for this site — "
                f"{std['title']} ({std['version']}) bands are straight-line "
                f"equations y = a·b + c in b = the percentage of AC area out "
                f"of total built-up area; record `ac_share_percent` (0–100) "
                f"on the site's benchmark config "
                f"(PUT /bi/rating/benchmark-config)"
            ),
        }
    coeffs = zone_def.get(size)
    if not coeffs:
        return {
            **head, "ok": False,
            "reason": (
                f"{std['title']} ({std['version']}) has no equations for zone "
                f"`{zone}` / size `{size}` — the recorded config names a "
                f"table the standard does not publish"
            ),
        }
    x = float(ac_share)
    table = linear_band_table(coeffs, x)
    # Score edges: the document's best line (5★ equation) → 100, its
    # worst line (1★ equation) → 0, linear between, clamped — the same
    # role 2009's 5★ threshold / 1★ upper bound play.
    by_star = {b["stars"]: b for b in table}
    best = by_star[5]["equation_value"]
    worst = by_star[1]["equation_value"]
    size_label = ((bands.get("size_categories") or {}).get(size) or {}).get(
        "label", size
    )
    return {
        **head, "ok": True, "best": float(best), "worst": float(worst),
        "zone": zone, "ac_category": None,
        "size_category": size, "ac_share_percent": x,
        "band_table": table,
        "citation": std["citation"], "unit": bands.get("unit"),
        "context": (
            f"zone {zone_def.get('label', zone)} · {size_label} "
            f"(BUA {float(area):,.0f} m²) · {x:g}% AC area"
        ),
    }


def _fixed_range_bands(
    std: dict, head: dict, cfg: dict, zone_def: dict
) -> dict:
    """2009's fixed-range model: bands per zone × over/under-50%-AC category."""
    bands = std["bands"] or {}
    zone = head["zone"]
    ac = cfg.get("ac_category") if cfg else None
    if not ac:
        return {
            **head, "ok": False,
            "missing": "ac_category",
            "reason": (
                f"air-conditioned-share category not set for this site — "
                f"{std['title']} ({std['version']}) publishes different bands for "
                f">50% and <50% conditioned built-up area"
            ),
        }
    table = zone_def.get(ac)
    if not table:
        return {
            **head, "ok": False,
            "reason": (
                f"{std['title']} ({std['version']}) has no band table for zone "
                f"`{zone}` / category `{ac}` — the recorded config names a table "
                f"the standard does not publish"
            ),
        }
    # Best edge: the 5-star threshold (below it, the best band). Worst edge:
    # the 1-star upper bound (above it the scheme awards no star → score 0).
    best = min(b["max"] for b in table if b.get("max") is not None and b.get("min") is None)
    worst = max(b["max"] for b in table if b.get("max") is not None)
    return {
        **head, "ok": True, "best": float(best), "worst": float(worst),
        "zone": zone, "ac_category": ac, "band_table": table,
        "citation": std["citation"], "unit": bands.get("unit"),
        "context": f"zone {zone_def.get('label', zone)} · {ac}",
    }


async def resolve_benchmark(
    db: AsyncSession, tenant, site_id, *, as_of: dt.datetime | None = None
) -> dict:
    """The band edges a `benchmark_score()` grades against — or the reason
    there are none. Returns {"ok": True, best, worst, standard, version, kind,
    zone, band_table, citation, context, ...} or {"ok": False, "reason": ...}.

    `as_of` selects WHICH VERSION applies: the latest whose effective date ≤
    the evaluation window's end (callers pass the window end; default now).
    jan-2022 governs today's windows; feb-2009 stays for windows ending
    before 2022.

    Every miss names ITS missing input: the honest states are different and
    the screen must be able to say which one this is.
    """
    when = as_of or dt.datetime.now(dt.timezone.utc)
    cfg_rows = _rows(
        await db.execute(text(_BENCHMARK_CONFIG_SQL), {"site": str(site_id)})
    )
    cfg = cfg_rows[0] if cfg_rows else {}
    key = (cfg.get("standard_key") or "bee_star_office") if cfg else "bee_star_office"
    std_rows = _rows(
        await db.execute(
            text(_BENCHMARK_SQL), {"key": key, "as_of": when.date()}
        )
    )
    if not std_rows:
        return {
            "ok": False,
            "reason": (
                "no benchmark standard sourced — `benchmark_standards` holds no "
                f"row for `{key}` effective at {when.date().isoformat()}; a band "
                f"table enters only with a citation"
            ),
        }
    std = std_rows[0]
    bands = std["bands"] or {}
    head = _benchmark_head(std)
    zone = cfg.get("climate_zone") if cfg else None
    if not zone:
        return {
            **head, "ok": False,
            "missing": "climate_zone",
            "reason": (
                f"climate zone not set for this site — {std['title']} "
                f"({std['version']}) bands are climate-zone-specific; record the "
                f"zone on the site's benchmark config"
            ),
        }
    head["zone"] = zone
    head["ac_category"] = cfg.get("ac_category") if cfg else None
    zone_def = (bands.get("zones") or {}).get(zone) or {}

    if head["kind"] == "linear_by_ac_share":
        return await _linear_by_ac_share_bands(
            db, tenant, site_id, std, head, cfg, zone_def
        )
    return _fixed_range_bands(std, head, cfg, zone_def)


def _band_for(table: list[dict], value: float) -> dict | None:
    """The star band `value` falls in, reading the table as published: a band
    is (min, max]-shaped with the 5-star row open below. On a 2009 fixed-range
    table, above the worst upper bound there is NO band — the scheme awards no
    star, and this returns None rather than pretending the bottom band
    stretches forever. A jan-2022 table (built by `linear_band_table`) has its
    1-star row open ABOVE, because the document names the 1-star equation the
    band's "Lowest EPI value" — its rows cover the whole line and None does
    not occur."""
    for b in sorted(table, key=lambda b: b["stars"], reverse=True):
        lo, hi = b.get("min"), b.get("max")
        if (lo is None or value >= lo) and (hi is None or value < hi):
            return b
    return None


_EMISSION_FACTOR_SQL = """
    SELECT kg_co2_per_kwh, effective_from, source
      FROM site_emission_factors
     WHERE site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
       AND effective_from <= CAST(:at AS date)
     ORDER BY effective_from DESC, position ASC
     LIMIT 1
"""


async def _emission_factor_for(db: AsyncSession, tenant, site_id, end: dt.datetime):
    """The factor EFFECTIVE at the window's end, or None.

    Same rule as a metric version and a benchmark standard: the row that applies
    to a window is the latest one whose effective date is not after it. A grid
    factor is republished every year and re-grading last year's emissions with
    this year's number would be a silent restatement of history.

    The row travels back with its `source` — the citation an operator entered —
    so a carbon figure on a screen can always be traced to the document it came
    from rather than to a constant somebody once typed.
    """
    rows = _rows(
        await db.execute(
            text(_EMISSION_FACTOR_SQL),
            {"site": str(site_id), "tenant": str(tenant) if tenant else None,
             "at": end.date()},
        )
    )
    return rows[0] if rows else None


async def _site_role_candidates(
    db: AsyncSession, tenant, site_id, inputs: dict
) -> dict[str, list[dict]]:
    """The site's confirmed points, grouped by the role an input asks for.

    One query for every role the formula names — a four-input formula must not
    become four round trips.
    """
    roles = {
        spec["role"] for spec in inputs.values()
        if spec.get("source", "points") == "points"
    }
    if not roles:
        return {}
    rows = _rows(
        await db.execute(
            text(_SITE_ROLE_POINTS_SQL.format(live=LIVE_POINT)),
            {
                "site": str(site_id),
                "roles": list(roles),
                "tenant": str(tenant) if tenant else None,
                "retire_days": RETIRE_AFTER_DAYS,
            },
        )
    )
    by_role: dict[str, list[dict]] = {}
    for r in rows:
        by_role.setdefault(r["role"], []).append(r)
    return by_role


async def _emission_factor_input(
    db: AsyncSession, tenant, site_id, name: str, end: dt.datetime
) -> dict:
    """The site's grid emission factor as a formula input, with its citation."""
    row = await _emission_factor_for(db, tenant, site_id, end)
    if row is None:
        return _refusal(
            "missing_factor",
            f"input `{name}`: no grid emission factor is recorded for "
            f"this site effective on or before "
            f"{end.date().isoformat()} — record one in Configurations → "
            f"Sites → Emissions. A national average IS a defensible "
            f"value, but it is a value somebody has to choose and cite, "
            f"not one this metric may assume",
        )
    return {
        "status": "ok",
        "value": float(row["kg_co2_per_kwh"]),
        "report": {
            "input": name, "source": "emission_factor",
            "value": float(row["kg_co2_per_kwh"]), "unit": "kgCO2/kWh",
            "effective_from": row["effective_from"],
            "factor_source": row["source"],
        },
    }


def _site_fact_input(site: dict, name: str, spec: dict) -> dict:
    """A recorded site fact (area, occupancy) as a formula input."""
    fact = spec["fact"]
    fact_def = registry.FACT_DEFS[fact]
    v = site.get(fact)
    if v is None:
        return _refusal(
            "missing_fact",
            f"input `{name}`: site fact `{fact}` ({fact_def['label']}) is "
            f"NOT RECORDED for this site — record it in "
            f"{fact_def['recorded_at']}; nothing is defaulted or estimated",
        )
    return {
        "status": "ok",
        "value": float(v),
        "report": {"input": name, "source": "site_fact", "fact": fact,
                   "value": float(v), "unit": spec.get("unit")},
    }


def _unit_guard_refusal(
    name: str, guards: list, candidates: list[dict], want_unit: str | None
) -> dict | None:
    """Why these points may not feed this input — or None if they may.

    Both guards exist so that a number never arrives on an assumed unit; they
    are why this evaluator refuses instead of converting.
    """
    if "units_confirmed" in guards:
        bad = [c for c in candidates if c["unit_source"] != "operator"]
        if bad:
            named = ", ".join(f"`{c['point_tag']}`" for c in bad)
            return _refusal(
                "unit_unconfirmed",
                f"input `{name}`: no operator has confirmed a unit for {named} "
                f"— the metric does not compute on an assumed unit",
            )
    if want_unit is not None:
        off = [c for c in candidates if c["unit"] != want_unit]
        if off:
            named = ", ".join(f"`{c['point_tag']}`=`{c['unit']}`" for c in off)
            return _refusal(
                "unit_mismatch",
                f"input `{name}` requires `{want_unit}` and {named}",
            )
    return None


def _register_delta(c: dict, a: dict | None) -> dict:
    """What one register contributed over the window, or why it contributed nothing.

    Every non-ok outcome is reported rather than absorbed: a consumption that
    silently skipped a reset would be indistinguishable from one that never
    had a reset.
    """
    row = {"point_id": str(c["point_id"]), "point_tag": c["point_tag"],
           "device_tag": c["device_tag"]}
    if not a or a["agg_first"] is None or a["agg_last"] is None:
        row.update(status="no_data", reason="no bucket in this window")
        return row
    first, last = float(a["agg_first"]), float(a["agg_last"])
    delta = last - first
    if delta < 0:
        # A reset, rollover or replaced device. Excluded and SAID —
        # never an absolute value (rating.py's rule, same words).
        row.update(status="register_decreased", first=first, last=last,
                   reason=f"register went from {first:g} down to "
                          f"{last:g}; no consumption can be derived")
        return row
    buckets = int(a["buckets"] or 0)
    if delta == 0 and buckets > 1:
        # first == last across the whole window: the register has
        # stopped moving. The zero is a real measurement, but a
        # score built on it grades a dead meter — an EPI of 0.0
        # falls in the BEST benchmark band. Same discipline as a
        # frozen formula input: undefined here, never a flattering
        # number. rating.py makes the same call (register_frozen,
        # band withheld); the registry refuses one input earlier.
        row.update(status="register_frozen", first=first, last=last,
                   buckets=buckets,
                   reason=f"register held {first:g} across all "
                          f"{buckets} buckets — the meter has "
                          f"stopped moving")
        return row
    row.update(status="ok", first=first, last=last, delta=delta,
               buckets=buckets)
    return row


def _refuse_unusable_registers(
    name: str, role: str, candidates: list[dict], registers: list[dict]
) -> dict:
    """No register produced a delta — a stopped meter is not an absent one.

    The two refusals send an operator to two different places, so they stay
    two refusals.
    """
    frozen = [r for r in registers if r["status"] == "register_frozen"]
    if frozen and len(frozen) == len(registers):
        out = _refusal(
            "undefined_frozen",
            f"input `{name}`: every register in role `{role}` "
            f"({len(frozen)}) held one value across the window — "
            f"the meters have stopped moving, so the metric is "
            f"undefined here, not zero",
        )
    else:
        out = _refusal(
            "no_data",
            f"input `{name}`: none of the {len(candidates)} register(s) "
            f"in role `{role}` produced a usable delta in this window",
        )
    out["registers"] = registers
    return out


async def _consumption_input(
    db: AsyncSession, tenant, name: str, spec: dict,
    candidates: list[dict], start, end, table: str
) -> dict:
    """`last − first` per bound register, summed across the role's registers."""
    role = spec["role"]
    aggs = {
        r["point_id"]: r
        for r in _rows(
            await db.execute(
                text(_AGG_SQL.format(table=table)),
                {"pids": [str(c["point_id"]) for c in candidates],
                 "tenant": str(tenant) if tenant else None,
                 "start": start, "end": end},
            )
        )
    }
    registers = []
    total = 0.0
    usable = 0
    first_b: dt.datetime | None = None
    last_b: dt.datetime | None = None
    for c in candidates:
        a = aggs.get(c["point_id"])
        row = _register_delta(c, a)
        registers.append(row)
        if row["status"] != "ok":
            continue
        total += row["delta"]
        usable += 1
        fb, lb = a["first_bucket"], a["last_bucket"]
        first_b = fb if first_b is None or fb < first_b else first_b
        last_b = lb if last_b is None or lb > last_b else last_b
    if usable == 0:
        return _refuse_unusable_registers(name, role, candidates, registers)
    # Covered span across the usable registers — what annualize() (if
    # present) scales over, exactly as /bi/rating does.
    covered_days = None
    if first_b is not None and last_b is not None:
        covered_days = max((last_b - first_b).total_seconds() / 86400.0, 0.0)
    return {
        "status": "ok",
        "value": total,
        "days_covered": covered_days,
        "report": {"input": name, "role": role, "aggregation": "consumption",
                   "value": total, "unit": spec.get("unit"),
                   "registers": registers, "days_covered": covered_days},
    }


async def _single_point_input(
    db: AsyncSession, tenant, name: str, spec: dict,
    candidates: list[dict], start, end, table: str
) -> dict:
    """One point's aggregate over the window — the role must bind exactly one."""
    role = spec["role"]
    agg = spec.get("aggregation", "avg")
    if len(candidates) > 1:
        tags = ", ".join(str(c["point_tag"]) for c in candidates)
        return _refusal(
            "ambiguous_role",
            f"{len(candidates)} points ({tags}) are confirmed in role "
            f"`{role}` at this site and aggregation `{agg}` needs exactly "
            f"one — a metric cannot pick; `consumption` is the "
            f"aggregation that sums registers",
        )
    c = candidates[0]
    a_rows = _rows(
        await db.execute(
            text(_AGG_SQL.format(table=table)),
            {"pids": [str(c["point_id"])],
             "tenant": str(tenant) if tenant else None,
             "start": start, "end": end},
        )
    )
    if not a_rows or a_rows[0][f"agg_{agg}"] is None:
        return _refusal(
            "no_data",
            f"input `{name}` (`{c['point_tag']}`) has no samples in the "
            f"window at this resolution — absence is absence, not zero",
        )
    return {
        "status": "ok",
        "value": float(a_rows[0][f"agg_{agg}"]),
        "report": {"input": name, "role": role, "aggregation": agg,
                   "point_tag": c["point_tag"],
                   "value": float(a_rows[0][f"agg_{agg}"]), "unit": c["unit"]},
    }


async def _role_points_input(
    db: AsyncSession, tenant, name: str, spec: dict, guards: list,
    by_role: dict[str, list[dict]], start, end, table: str
) -> dict:
    """A measured input: the points an operator confirmed in the role it names."""
    role = spec["role"]
    candidates = by_role.get(role) or []
    if not candidates:
        return _refusal(
            "missing_role",
            f"no point at this site is confirmed in role `{role}` "
            f"(input `{name}`) — confirm one on the Metric Roles screen",
        )
    refused = _unit_guard_refusal(name, guards, candidates, spec.get("unit"))
    if refused is not None:
        return refused
    if spec.get("aggregation", "avg") == "consumption":
        return await _consumption_input(
            db, tenant, name, spec, candidates, start, end, table
        )
    return await _single_point_input(
        db, tenant, name, spec, candidates, start, end, table
    )


async def _resolve_site_inputs(
    db: AsyncSession, tenant, defn: dict, site: dict, start, end, table: str
) -> dict:
    """Every input the formula names, resolved to a number — or the first refusal.

    Inputs resolve before any arithmetic so the refusal an operator sees is the
    gap they can act on, not the division that fell over three lines later.
    """
    inputs: dict = defn["inputs"]
    guards: list = defn.get("guards") or []
    by_role = await _site_role_candidates(db, tenant, site["site_id"], inputs)

    env: dict[str, float] = {}
    report: list[dict] = []
    # One span PER consumption input, not one span. Two consumption inputs can
    # cover different stretches of the same window — a sub-meter installed last
    # week beside a main meter running all month — and collapsing them into a
    # single variable made the LAST input in declaration order silently decide
    # what `annualize()` scaled over. Which input wins is an ordering accident,
    # so the disagreement is carried out of here and judged where it matters.
    spans: list[tuple[str, float]] = []
    for name, spec in inputs.items():
        source = spec.get("source", "points")
        if source == "emission_factor":
            resolved = await _emission_factor_input(
                db, tenant, site["site_id"], name, end
            )
        elif source == "site_fact":
            resolved = _site_fact_input(site, name, spec)
        else:
            resolved = await _role_points_input(
                db, tenant, name, spec, guards, by_role, start, end, table
            )
        if resolved["status"] != "ok":
            return resolved
        env[name] = resolved["value"]
        report.append(resolved["report"])
        if resolved.get("days_covered") is not None:
            spans.append((name, resolved["days_covered"]))
    distinct = {days for _, days in spans}
    return {"status": "ok", "env": env, "inputs": report,
            "days_covered": spans[0][1] if len(distinct) == 1 else None,
            "covered_spans": spans}


async def _site_benchmark_context(
    db: AsyncSession, tenant, site: dict, end: dt.datetime
) -> dict:
    """The standard this formula grades against, resolved at the window's end.

    Version selection: the window END picks the standard version, the same way
    `registry.effective` picks the metric definition — yesterday's window
    grades under the standard in force yesterday.
    """
    resolved = await resolve_benchmark(db, tenant, site["site_id"], as_of=end)
    if not resolved.get("ok"):
        out = _refusal("no_benchmark", resolved["reason"])
        if resolved.get("standard"):
            out["benchmark"] = {k: resolved.get(k) for k in ("standard", "version")}
        return out
    note = {
        "standard": resolved["standard"], "version": resolved["version"],
        "kind": resolved.get("kind"),
        "zone": resolved["zone"], "ac_category": resolved.get("ac_category"),
        "best_edge": resolved["best"], "worst_edge": resolved["worst"],
        "citation": resolved["citation"],
    }
    for k in ("size_category", "ac_share_percent", "context"):
        if resolved.get(k) is not None:
            note[k] = resolved[k]
    return {
        "status": "ok",
        "note": note,
        "edges": {"best": resolved["best"], "worst": resolved["worst"]},
    }


def _annualize_span(
    tree, covered_spans: list, covered_days, window_days: float, input_report
) -> dict:
    """The span annualize() scales over, or the refusal saying there is none.

    annualize() over a consumption formula scales the COVERED span; a formula
    with no consumption input keeps the requested window.

    TWO consumption inputs that cover different spans have no one span to
    scale by: annualising their combination over either one states an annual
    figure for a series that was not measured over it, and taking the shorter
    would inflate the longer-covered input by the ratio between them. Both are
    numbers that look right on a screen, which is exactly what this module
    refuses to produce — so the annual figure is withheld and both spans are
    named, because the fix is to ask over a window both meters cover.
    """
    effective_days = covered_days if covered_days is not None else window_days
    if not expr.uses(tree, "annualize"):
        return {"status": "ok", "days": effective_days}
    if len(covered_spans) > 1 and covered_days is None:
        named = ", ".join(f"`{n}` over {d:g} day(s)" for n, d in covered_spans)
        out = _refusal(
            "blocked",
            f"annualize() has no single covered span to scale over: {named} "
            f"— annualising series measured over different spans into one "
            f"number would state a year nothing was measured for",
        )
        out["inputs"] = input_report
        return out
    if not effective_days or effective_days <= 0:
        return _refusal(
            "no_data",
            "annualize() needs a covered span and the usable registers span "
            "less than one bucket — there is no interval to annualise over",
        )
    return {"status": "ok", "days": effective_days}


async def _evaluate_site_formula(
    db: AsyncSession, tenant, defn: dict, site: dict, start, end, table: str
) -> dict:
    tree = expr.parse(defn["formula"])
    window_days = (end - start).total_seconds() / 86400.0

    resolved = await _resolve_site_inputs(db, tenant, defn, site, start, end, table)
    if resolved["status"] != "ok":
        return resolved
    env = resolved["env"]
    input_report = resolved["inputs"]
    covered_days = resolved["days_covered"]
    covered_spans = resolved.get("covered_spans") or []

    # Benchmark context, resolved AFTER the measured inputs and BEFORE the
    # arithmetic: a missing AREA reports as missing_fact (the actionable gap),
    # and only a site whose measurements all resolve gets asked "against what
    # standard?" — each missing benchmark input is then named precisely.
    benchmark = None
    bench_note = None
    if expr.uses(tree, "benchmark_score"):
        bench = await _site_benchmark_context(db, tenant, site, end)
        if bench["status"] != "ok":
            bench["inputs"] = input_report
            return bench
        bench_note = bench["note"]
        benchmark = bench["edges"]

    span = _annualize_span(tree, covered_spans, covered_days, window_days, input_report)
    if span["status"] != "ok":
        return span
    effective_days = span["days"]

    try:
        value = expr.evaluate(tree, env, window_days=effective_days, benchmark=benchmark)
    except expr.EvalRefusal as e:
        out = _refusal(e.status, e.reason)
        out["inputs"] = input_report
        return out

    out = {
        "status": "ok",
        "value": value,
        "unit": (defn.get("output") or {}).get("unit"),
        "dimension": (defn.get("output") or {}).get("dimension"),
        "inputs": input_report,
        "arithmetic": f"{defn['formula']} = {expr.render(tree, env)} = {value:g}",
    }
    # Omitted where two consumption inputs disagree: there is no single covered
    # span to name, and each input's own already rides in its report row.
    if covered_days is not None:
        out["days_covered"] = covered_days
    if bench_note:
        out["benchmark"] = bench_note
    return out


def _undefined_reason(parent: dict, metric: str, end: dt.datetime) -> str:
    """What to say about a component that is named but has no definition.

    The bare fact — no row is effective — is the fallback, not the answer. When
    the parent documents the component, the operator gets the sentence that
    tells them whether the gap is a field job (a sensor nobody installed), a
    config job (a fact nobody recorded) or a build job (a capability nobody
    wrote). Those three need three different people, and the key alone names
    none of them.
    """
    doc = ((parent.get("display") or {}).get("components") or {}).get(metric) or {}
    label = doc.get("label") or metric
    blocked = doc.get("blocked_by")
    if not blocked:
        return f"no metric `{metric}` is effective at {end.isoformat()}"
    source = doc.get("source")
    out = f"{label} is not defined — {blocked}"
    if source:
        out += f" (source: {source})"
    return out


def _component_over_devices(
    metric: str, devices: list[dict], *, noun: str = "device", empty: dict | None = None
) -> dict:
    """A device- or equipment-scope component combined across a site.

    The arithmetic mean of the ok values — or the refusal that replaces it,
    because ANY device (or piece of equipment) refusal refuses the component.
    """
    if not devices:
        return empty or {"status": "missing_role", "value": None,
                         "reason": f"no applicable device at this site for `{metric}`"}
    refused = [d for d in devices if d["status"] != "ok"]
    if refused:
        named = "; ".join(
            f"{d.get('device_tag') or d.get('equipment_tag') or d.get('device_id')} "
            f"({d['status']}: {d['reason']})" for d in refused
        )
        return {
            "status": "blocked", "value": None,
            "reason": (
                f"{len(refused)} of {len(devices)} {noun}(s) refused "
                f"— a composite of a refusal is a refusal. {named}"
            ),
        }
    vals = [float(d["value"]) for d in devices]
    mean = sum(vals) / len(vals)
    return {
        "status": "ok", "value": mean,
        "arithmetic": (
            "mean(" + ", ".join(f"{v:g}" for v in vals) + f") = {mean:g} "
            f"over {len(vals)} {noun}(s)"
        ),
    }


async def _site_composite_part(
    db: AsyncSession, tenant, defn: dict, site: dict, c: dict, start, end, res, depth
) -> dict:
    """One component of a site composite, evaluated the way its own scope demands."""
    sub_defn = await registry.effective(db, tenant, c["metric"], end)
    if sub_defn is None:
        # A component named but not defined. "no metric `x` is effective"
        # is TRUE and useless — it tells an operator that a key is missing,
        # not what would make it exist. A composite may therefore document
        # its own components (`display.components[key]`), and a pack that
        # does gets its sentence printed instead: what the metric is, what
        # measures it, and what is in the way. See `reporting.ccei_spec`.
        return {"metric": c["metric"], "weight": c["weight"],
                "status": "not_defined", "value": None,
                "reason": _undefined_reason(defn, c["metric"], end)}
    sub_scope = (sub_defn.get("applies_to") or {}).get("scope", "device")
    sub = await evaluate(
        db, tenant, c["metric"],
        site_id=site["site_id"], start=start, end=end, resolution=res,
        _depth=depth + 1,
    )
    part = {"metric": c["metric"], "version": sub["version"], "weight": c["weight"]}
    if sub_scope == "site":
        item = sub["items"][0] if sub["items"] else _refusal(
            "no_data", "site not present in the reporting mirror")
        part.update(status=item["status"], value=item.get("value"),
                    reason=item.get("reason"))
        if item.get("inputs"):
            part["inputs"] = item["inputs"]
        if item.get("benchmark"):
            part["benchmark"] = item["benchmark"]
    elif sub_scope == "equipment":
        # Equipment-scope components fan out over the site's registered
        # equipment of their class, with the device rule: the mean of the ok
        # values, and any refusal refuses. A site with none of that class has
        # nothing to score — which is not the same sentence as "no device
        # carries the role", and sends an operator somewhere else.
        cls = (sub_defn.get("applies_to") or {}).get("equipment_class") or "equipment"
        units = [
            {"equipment_id": i.get("equipment_id"), "equipment_tag": i.get("equipment_tag"),
             "status": i["status"], "value": i.get("value"), "reason": i.get("reason")}
            for i in sub["items"]
        ]
        part["equipment"] = units
        part.update(**_component_over_devices(
            c["metric"], units, noun="equipment",
            empty={"status": "missing_equipment", "value": None,
                   "reason": (f"no {cls} is registered at this site, so `{c['metric']}` "
                              f"has nothing to evaluate — register it in "
                              f"{slot_store.RECORDED_AT}")},
        ))
    else:
        devices = [
            {"device_id": i.get("device_id"), "device_tag": i.get("device_tag"),
             "status": i["status"], "value": i.get("value"),
             "reason": i.get("reason")}
            for i in sub["items"]
        ]
        part["devices"] = devices
        part.update(**_component_over_devices(c["metric"], devices))
    return part


async def _evaluate_site_composite(
    db: AsyncSession, tenant, defn: dict, site: dict, start, end, res, depth
) -> dict:
    """A site-scope composite: site-scope components evaluate for THIS site;
    device-scope components fan out over the site's applicable devices and
    combine as the arithmetic mean of the ok values — ANY device refusal
    refuses the component, with every device's own status attached."""
    if depth >= _MAX_COMPOSITE_DEPTH:
        return _refusal("blocked", f"composite nesting deeper than {_MAX_COMPOSITE_DEPTH} is refused")
    parts = []
    for c in defn["components"]:
        parts.append(
            await _site_composite_part(db, tenant, defn, site, c, start, end, res, depth)
        )
    return _compose(defn, parts)
