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
    no_benchmark        the formula grades against a benchmark standard and one
                        of ITS inputs is missing: no standard seeded, or the
                        site's climate zone / AC-share category not set
    blocked             arithmetic refused (division by zero) or a composite
                        component refused — a composite of a refusal is a
                        refusal, and the item carries EVERY component's own
                        {status, reason} so a dash can explain itself

SITE SCOPE (contract §21). `applies_to.scope: "site"` evaluates per SITE over
the `site_facts` mirror instead of per device. Inputs may then be site facts
(`source: "site_fact"`) or site-wide role bindings; aggregation `consumption`
is `last − first` per bound register (monotonic-guarded, a decreased register
is excluded and reported, exactly `/bi/rating`'s arithmetic), summed across
the role's registers. `annualize()` in a consumption formula scales over the
COVERED span (first→last bucket), not the requested window — the same
definition `/bi/rating` uses, so the two paths cannot disagree. A composite at
site scope fans device-scope components out over the site's devices and takes
the arithmetic mean of the ok values; ANY device refusal refuses the
component, naming each device's own status.

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
from .units import UNIT_DIMENSION

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


async def evaluate(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    key: str,
    *,
    device_id: uuid.UUID | None = None,
    site_id: uuid.UUID | None = None,
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

    items = []
    if scope == "site":
        sites = await _sites_for(db, tenant, site_id)
        if site_id is not None and not sites:
            raise EvaluationError("no such site in this tenant's reporting store")
        for site in sites:
            if defn["kind"] == "composite":
                item = await _evaluate_site_composite(
                    db, tenant, defn, site, start, end, res, _depth
                )
            else:
                item = await _evaluate_site_formula(
                    db, tenant, defn, site, start, end, table
                )
            item["site_id"] = str(site["site_id"])
            if site.get("site_name"):
                item["site_name"] = site["site_name"]
            items.append(item)
    else:
        if device_id is not None:
            devices = [{"device_id": device_id, "device_tag": None}]
        else:
            devices = await _devices_for(
                db, tenant, defn.get("applies_to") or {}, site_id=site_id
            )
        for d in devices:
            if defn["kind"] == "composite":
                item = await _evaluate_composite(
                    db, tenant, defn, d["device_id"], start, end, res, _depth
                )
            else:
                item = await _evaluate_formula(db, tenant, defn, d["device_id"], start, end, table)
            item["device_id"] = str(d["device_id"])
            if d.get("device_tag"):
                item["device_tag"] = d["device_tag"]
            items.append(item)

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
    guards: list = defn.get("guards") or []
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

    # ── unit guards, in order of most fundamental first ──────────────────────
    if "units_confirmed" in guards:
        bad = [n for n, p in bound.items() if p["unit_source"] != "operator"]
        if bad:
            named = ", ".join(f"`{bound[n]['point_tag']}` ({n})" for n in bad)
            return _refusal(
                "unit_unconfirmed",
                f"no operator has confirmed a unit for {named} — the metric does "
                f"not compute on an assumed unit; confirm it on the Units tab",
            )
    for name, spec in inputs.items():
        unit = bound[name]["unit"]
        if unit is None:
            continue  # unguarded definitions may run unit-open; dimension unknown
        dim = UNIT_DIMENSION.get(unit)
        want_unit, want_dim = spec.get("unit"), spec.get("dimension")
        if want_unit is not None and unit != want_unit:
            return _refusal(
                "unit_mismatch",
                f"input `{name}` requires `{want_unit}` and point "
                f"`{bound[name]['point_tag']}` is confirmed as `{unit}`",
            )
        if want_dim is not None and dim != want_dim:
            return _refusal(
                "unit_mismatch",
                f"input `{name}` requires dimension `{want_dim}` and "
                f"`{unit}` is `{dim or 'unknown'}`",
            )
    if "same_unit" in guards:
        units = {n: bound[n]["unit"] for n in bound}
        distinct = set(units.values())
        if len(distinct) > 1:
            named = ", ".join(f"{n}=`{u}`" for n, u in units.items())
            return _refusal(
                "unit_mismatch",
                f"inputs are in different units ({named}) and conversion is not "
                f"modelled — this refuses rather than converts silently",
            )

    # ── read the rollup ──────────────────────────────────────────────────────
    pids = [str(p["point_id"]) for p in bound.values()]
    aggs = {
        r["point_id"]: r
        for r in _rows(
            await db.execute(
                text(_AGG_SQL.format(table=table)),
                {
                    "pids": pids,
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

    if "non_frozen" in guards:
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

    # ── arithmetic, shown ────────────────────────────────────────────────────
    env: dict[str, float] = {}
    input_report = []
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
        input_report.append(
            {
                "input": name,
                "role": spec["role"],
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

    tree = expr.parse(defn["formula"])
    window_days = (end - start).total_seconds() / 86400.0
    try:
        value = expr.evaluate(tree, env, window_days=window_days)
    except expr.EvalRefusal as e:
        out = _refusal(e.status, e.reason)
        out["inputs"] = input_report
        return out

    # per-bucket series: inner alignment; a bucket missing a side is absent.
    series = await _series(db, tenant, defn, bound, start, end, table, window_days)

    return {
        "status": "ok",
        "value": value,
        "unit": (defn.get("output") or {}).get("unit"),
        "dimension": (defn.get("output") or {}).get("dimension"),
        "inputs": input_report,
        "arithmetic": f"{defn['formula']} = {expr.render(tree, env)} = {value:g}",
        "series": series,
    }


async def _series(db, tenant, defn, bound, start, end, table, window_days) -> list[dict]:
    cols = {
        name: _BUCKET_COL[spec.get("aggregation", "avg")]
        for name, spec in defn["inputs"].items()
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
        env = {}
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
    kind = bands.get("kind") or "fixed_ranges"
    head = {
        "standard": std["key"], "version": std["version"], "title": std["title"],
        "kind": kind,
        "effective_from": (
            std["effective_from"].isoformat() if std.get("effective_from") else None
        ),
    }
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
    zones = bands.get("zones") or {}
    zone_def = zones.get(zone) or {}

    if kind == "linear_by_ac_share":
        # The 2022 model: straight-line equations in the AC-share percentage,
        # per building size category derived from the recorded built-up area.
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
                    f"record `gross_floor_area_sqm` in Configurations → Sites"
                ),
            }
        size = size_category_for(float(area))
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

    # 2009's fixed-range model: bands per zone × over/under-50%-AC category.
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


async def _evaluate_site_formula(
    db: AsyncSession, tenant, defn: dict, site: dict, start, end, table: str
) -> dict:
    inputs: dict = defn["inputs"]
    guards: list = defn.get("guards") or []
    tree = expr.parse(defn["formula"])

    env: dict[str, float] = {}
    input_report: list[dict] = []
    window_days = (end - start).total_seconds() / 86400.0
    covered_days: float | None = None

    role_names = {
        name: spec for name, spec in inputs.items()
        if spec.get("source", "points") == "points"
    }
    by_role: dict[str, list[dict]] = {}
    if role_names:
        rows = _rows(
            await db.execute(
                text(_SITE_ROLE_POINTS_SQL.format(live=LIVE_POINT)),
                {
                    "site": str(site["site_id"]),
                    "roles": list({spec["role"] for spec in role_names.values()}),
                    "tenant": str(tenant) if tenant else None,
                    "retire_days": RETIRE_AFTER_DAYS,
                },
            )
        )
        for r in rows:
            by_role.setdefault(r["role"], []).append(r)

    for name, spec in inputs.items():
        if spec.get("source", "points") == "site_fact":
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
            env[name] = float(v)
            input_report.append(
                {"input": name, "source": "site_fact", "fact": fact,
                 "value": float(v), "unit": spec.get("unit")}
            )
            continue

        role = spec["role"]
        agg = spec.get("aggregation", "avg")
        candidates = by_role.get(role) or []
        if not candidates:
            return _refusal(
                "missing_role",
                f"no point at this site is confirmed in role `{role}` "
                f"(input `{name}`) — confirm one on the Metric Roles screen",
            )
        if "units_confirmed" in guards:
            bad = [c for c in candidates if c["unit_source"] != "operator"]
            if bad:
                named = ", ".join(f"`{c['point_tag']}`" for c in bad)
                return _refusal(
                    "unit_unconfirmed",
                    f"input `{name}`: no operator has confirmed a unit for {named} "
                    f"— the metric does not compute on an assumed unit",
                )
        want_unit = spec.get("unit")
        if want_unit is not None:
            off = [c for c in candidates if c["unit"] != want_unit]
            if off:
                named = ", ".join(f"`{c['point_tag']}`=`{c['unit']}`" for c in off)
                return _refusal(
                    "unit_mismatch",
                    f"input `{name}` requires `{want_unit}` and {named}",
                )

        if agg == "consumption":
            pids = [str(c["point_id"]) for c in candidates]
            aggs = {
                r["point_id"]: r
                for r in _rows(
                    await db.execute(
                        text(_AGG_SQL.format(table=table)),
                        {"pids": pids,
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
                row = {"point_id": str(c["point_id"]), "point_tag": c["point_tag"],
                       "device_tag": c["device_tag"]}
                if not a or a["agg_first"] is None or a["agg_last"] is None:
                    row.update(status="no_data",
                               reason="no bucket in this window")
                    registers.append(row)
                    continue
                first, last = float(a["agg_first"]), float(a["agg_last"])
                delta = last - first
                if delta < 0:
                    # A reset, rollover or replaced device. Excluded and SAID —
                    # never an absolute value (rating.py's rule, same words).
                    row.update(status="register_decreased", first=first, last=last,
                               reason=f"register went from {first:g} down to "
                                      f"{last:g}; no consumption can be derived")
                    registers.append(row)
                    continue
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
                    registers.append(row)
                    continue
                row.update(status="ok", first=first, last=last, delta=delta,
                           buckets=buckets)
                registers.append(row)
                total += delta
                usable += 1
                fb, lb = a["first_bucket"], a["last_bucket"]
                first_b = fb if first_b is None or fb < first_b else first_b
                last_b = lb if last_b is None or lb > last_b else last_b
            if usable == 0:
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
            # Covered span across the usable registers — what annualize() (if
            # present) scales over, exactly as /bi/rating does.
            if first_b is not None and last_b is not None:
                covered_days = max(
                    (last_b - first_b).total_seconds() / 86400.0, 0.0
                )
            env[name] = total
            input_report.append(
                {"input": name, "role": role, "aggregation": "consumption",
                 "value": total, "unit": want_unit,
                 "registers": registers, "days_covered": covered_days}
            )
        else:
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
            v = float(a_rows[0][f"agg_{agg}"])
            env[name] = v
            input_report.append(
                {"input": name, "role": role, "aggregation": agg,
                 "point_tag": c["point_tag"], "value": v, "unit": c["unit"]}
            )

    # Benchmark context, resolved AFTER the measured inputs and BEFORE the
    # arithmetic: a missing AREA reports as missing_fact (the actionable gap),
    # and only a site whose measurements all resolve gets asked "against what
    # standard?" — each missing benchmark input is then named precisely.
    benchmark = None
    bench_note = None
    if expr.uses(tree, "benchmark_score"):
        # Version selection: the window END picks the standard version, the
        # same way `registry.effective` picks the metric definition —
        # yesterday's window grades under the standard in force yesterday.
        resolved = await resolve_benchmark(db, tenant, site["site_id"], as_of=end)
        if not resolved.get("ok"):
            out = _refusal("no_benchmark", resolved["reason"])
            if resolved.get("standard"):
                out["benchmark"] = {k: resolved.get(k) for k in ("standard", "version")}
            out["inputs"] = input_report
            return out
        bench_note = {
            "standard": resolved["standard"], "version": resolved["version"],
            "kind": resolved.get("kind"),
            "zone": resolved["zone"], "ac_category": resolved.get("ac_category"),
            "best_edge": resolved["best"], "worst_edge": resolved["worst"],
            "citation": resolved["citation"],
        }
        for k in ("size_category", "ac_share_percent", "context"):
            if resolved.get(k) is not None:
                bench_note[k] = resolved[k]
        benchmark = {"best": resolved["best"], "worst": resolved["worst"]}

    # annualize() over a consumption formula scales the COVERED span; a formula
    # with no consumption input keeps the requested window.
    effective_days = covered_days if covered_days is not None else window_days
    if expr.uses(tree, "annualize") and (not effective_days or effective_days <= 0):
        return _refusal(
            "no_data",
            "annualize() needs a covered span and the usable registers span "
            "less than one bucket — there is no interval to annualise over",
        )
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
    if covered_days is not None:
        out["days_covered"] = covered_days
    if bench_note:
        out["benchmark"] = bench_note
    return out


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
        sub_defn = await registry.effective(db, tenant, c["metric"], end)
        if sub_defn is None:
            parts.append({"metric": c["metric"], "weight": c["weight"],
                          "status": "blocked", "value": None,
                          "reason": f"no metric `{c['metric']}` is effective at {end.isoformat()}"})
            continue
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
        else:
            devices = [
                {"device_id": i.get("device_id"), "device_tag": i.get("device_tag"),
                 "status": i["status"], "value": i.get("value"),
                 "reason": i.get("reason")}
                for i in sub["items"]
            ]
            part["devices"] = devices
            if not devices:
                part.update(status="missing_role", value=None,
                            reason=f"no applicable device at this site for `{c['metric']}`")
            else:
                refused = [d for d in devices if d["status"] != "ok"]
                if refused:
                    named = "; ".join(
                        f"{d.get('device_tag') or d['device_id']} "
                        f"({d['status']}: {d['reason']})" for d in refused
                    )
                    part.update(
                        status="blocked", value=None,
                        reason=(
                            f"{len(refused)} of {len(devices)} device(s) refused "
                            f"— a composite of a refusal is a refusal. {named}"
                        ),
                    )
                else:
                    vals = [float(d["value"]) for d in devices]
                    mean = sum(vals) / len(vals)
                    part.update(
                        status="ok", value=mean,
                        arithmetic=(
                            "mean(" + ", ".join(f"{v:g}" for v in vals) + f") = {mean:g} "
                            f"over {len(vals)} device(s)"
                        ),
                    )
        parts.append(part)
    return _compose(defn, parts)
