"""Run a widget spec against the reading store.

The whole of the "query engine" is here, and it is small on purpose: the spec has
already narrowed every dimension to a closed set, so this file is a translation,
not an interpreter. There is no place a caller's string becomes SQL.

Order of operations, and why it is this order:

1. **Resolve the scope to points FIRST.** This doubles as the tenant check —
   `scope_points` filters by the JWT's tenant, so a point belonging to somebody
   else never comes back and no reading of theirs is ever touched. It is the same
   guard `/bi/series` gets from `point_meta`, and skipping it as "just labels" is
   how cross-tenant leaks happen.
2. **Choose the store.** `auto` is the existing `choose_resolution` — 1m up to
   three hours, 1h beyond — so a widget resolves resolution exactly as the two
   hand-built BI screens do. The reason string travels with the result so the
   widget can print it.
3. **Read.** Rollups by default; raw only when the spec asked and the window is
   short enough (the spec already refused a wider one).
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from . import queries as q
from .spec import QueryResult, ResultRow, ResultSeries, WidgetSpec

# Which aggregate column each metric reads. `count` is not in here: it comes from
# `samples`, which every row carries.
_METRIC_COL = {
    "avg": "v_avg",
    "min": "v_min",
    "max": "v_max",
    "first": "v_first",
    "last": "v_last",
}


def _resolution(spec: WidgetSpec, start, end) -> tuple[str, str]:
    if spec.query.rollup == "auto":
        return q.choose_resolution(start, end)
    if spec.query.rollup == "raw":
        return "raw", "raw readings (bounded window) — every sample, no aggregation"
    if spec.query.rollup == "1m":
        return "1m", (
            "1-minute rollup (readings_1m); materialized-only, so the newest "
            "~2 minutes may not be included yet"
        )
    return "1h", "1-hour rollup (readings_1h); real-time aggregate, current hour included"


async def run(db: AsyncSession, tenant: uuid.UUID | None, spec: WidgetSpec) -> QueryResult:
    query = spec.query
    start, end = query.window.resolve()
    resolution, reason = _resolution(spec, start, end)

    # `count` counts SAMPLES, which every point has — including text points, whose
    # status messages are as real a sample as a number. Value metrics need `num`.
    numeric_only = query.metric != "count"

    # A grouped aggregate rolls MANY points into few rows, so the point scan must
    # not be clipped to the row limit — the limit applies to the groups.
    if query.kind == "series":
        # `limit` is how many lines the chart draws; MAX_SERIES_POINTS is the hard
        # ceiling the spec already enforced. min() so a widget asking for three
        # gets three, not twenty-four.
        scope_limit = min(query.limit, q.MAX_SERIES_POINTS)
    elif query.group_by == "point":
        scope_limit = query.limit
    else:
        scope_limit = q.MAX_BUCKETS_PER_SERIES

    points, matched = await q.scope_points(
        db, tenant, query.scope, limit=scope_limit, numeric_only=numeric_only
    )
    point_ids = [p["point_id"] for p in points]

    base = {
        "metric": query.metric,
        "resolution": resolution,
        "resolution_reason": reason,
        "start": start,
        "end": end,
        "matched": matched,
        "truncated": matched > len(points),
    }

    if not point_ids:
        return QueryResult(shape=query.kind, **base)

    # ── series ───────────────────────────────────────────────────────────────
    if query.kind == "series":
        buckets = await q.series(
            db, tenant, point_ids=point_ids, start=start, end=end, resolution=resolution
        )
        return QueryResult(
            shape="series",
            series=[
                ResultSeries(
                    point_id=p["point_id"],
                    point_tag=p["point_tag"],
                    device_tag=p["device_tag"],
                    # As stored. NULL here is correct, not missing data.
                    unit=p["unit"],
                    buckets=buckets.get(p["point_id"], []),
                )
                for p in points
            ],
            **base,
        )

    # ── aggregate, grouped by device or category ─────────────────────────────
    if query.group_by in ("device", "category"):
        rows = await q.aggregate_by_group(
            db,
            tenant,
            point_ids=point_ids,
            start=start,
            end=end,
            resolution=resolution,
            group_by=query.group_by,
            limit=query.limit,
        )
        return QueryResult(
            shape="aggregate",
            rows=[
                ResultRow(
                    key=str(r["key"]),
                    # An empty category IS the unclassified bucket; name it rather
                    # than rendering a blank bar.
                    label=(r["label"] or "").strip()
                    or ("Unclassified" if query.group_by == "category" else str(r["key"])),
                    sublabel=f"{int(r['points'])} points",
                    value=float(r["samples"]),
                    samples=int(r["samples"]),
                )
                for r in rows
            ],
            **{
                **base,
                # `matched` counts POINTS, but these rows are DEVICES or
                # CATEGORIES — so "showing 8 of 314" would compare two different
                # things. Zero it and let the widget say "top 8" instead. Counting
                # the groups properly would be a second query for a caption.
                "matched": 0,
                "truncated": len(rows) >= query.limit,
            },
        )

    # ── aggregate, one row per point ─────────────────────────────────────────
    agg = await q.aggregate_by_point(
        db, tenant, point_ids=point_ids, start=start, end=end, resolution=resolution
    )
    rows: list[ResultRow] = []
    for p in points:
        a = agg.get(p["point_id"]) or {}
        samples = int(a.get("samples") or 0)
        if query.metric == "count":
            value: float | None = float(samples)
        else:
            raw = a.get(_METRIC_COL[query.metric])
            # No sample in the window → no value. NOT zero, and not an older
            # reading dressed as this window's: both are the same class of lie.
            value = None if raw is None else float(raw)
        rows.append(
            ResultRow(
                key=str(p["point_id"]),
                label=p["point_tag"] or str(p["point_id"]),
                sublabel=p["device_tag"],
                value=value,
                samples=samples,
                unit=p["unit"],
            )
        )
    return QueryResult(shape="aggregate", rows=rows, **base)
