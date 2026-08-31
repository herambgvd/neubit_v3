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
    blocked             arithmetic refused (division by zero) or a composite
                        component refused

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


async def _devices_for(db: AsyncSession, tenant, applies_to: dict) -> list[dict]:
    where, params = "", {}
    if applies_to.get("category"):
        where += " AND p.category = :category"
        params["category"] = applies_to["category"]
    if applies_to.get("device_type"):
        where += " AND p.device_type = :device_type"
        params["device_type"] = applies_to["device_type"]
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
    device_id: uuid.UUID | None,
    start: dt.datetime,
    end: dt.datetime,
    resolution: str = "auto",
    _depth: int = 0,
) -> dict:
    """Evaluate `key` over [start, end) for one device or for every device the
    definition applies to. Top-level shape is always the same; each device's
    outcome is its own `{status, ...}`."""
    defn = await registry.effective(db, tenant, key, end)
    if defn is None:
        raise EvaluationError(f"no metric `{key}` is effective at {end.isoformat()}")
    res, res_reason = pick_resolution(start, end, resolution)
    table = "readings_1m" if res == "1m" else "readings_1h"

    if device_id is not None:
        devices = [{"device_id": device_id, "device_tag": None}]
    else:
        devices = await _devices_for(db, tenant, defn.get("applies_to") or {})

    items = []
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
    total = 0.0
    for c in defn["components"]:
        sub = await evaluate(
            db, tenant, c["metric"],
            device_id=device_id, start=start, end=end, resolution=res,
            _depth=depth + 1,
        )
        item = sub["items"][0]
        if item["status"] != "ok":
            return _refusal(
                "blocked",
                f"component `{c['metric']}` did not evaluate "
                f"({item['status']}: {item['reason']}) — a composite of a refusal is a refusal",
            )
        total += float(c["weight"]) * float(item["value"])
        parts.append(
            {
                "metric": c["metric"],
                "version": sub["version"],
                "weight": c["weight"],
                "value": item["value"],
            }
        )
    working = " + ".join(f"{p['weight']:g} × {p['metric']}({p['value']:g})" for p in parts)
    return {
        "status": "ok",
        "value": total,
        "unit": (defn.get("output") or {}).get("unit"),
        "dimension": (defn.get("output") or {}).get("dimension"),
        "components": parts,
        "arithmetic": f"{working} = {total:g}",
    }
