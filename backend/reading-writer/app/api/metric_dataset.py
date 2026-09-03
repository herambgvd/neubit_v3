"""`metric_evaluations` — the metric registry, published as a chartable DATASET.

WHY THIS EXISTS
---------------
The registry can compute a CCEI and could not plot one. The dashboard builder
draws what `/bi/datasets` publishes and nothing else, so a metric — the one
number on this platform that carries a methodology, a version and a citation —
was reachable only from `/bi/metrics/evaluate`, a diagnostic route no widget
speaks. This module makes an evaluation a ROW, so a metric charts exactly like a
reading does: same `/bi/query` body, same window and resolution rules, same
permission gate, same `{columns, rows}` result.

IT IS NOT A SECOND EVALUATOR
----------------------------
Every row here comes out of `metric_registry.evaluator.evaluate`, unmodified.
Nothing in this file binds a role, reads a rollup, checks a unit or does any
arithmetic on a metric. That is the whole design constraint: a chart and the
`/bi/metrics/evaluate` panel beside it must be incapable of disagreeing, and two
implementations of the guard rules would disagree the first time one was fixed.
What this file owns is the SHAPE: items → rows, rows → groups, groups → cells.

A REFUSAL IS A ROW
------------------
The registry's value is that a metric with a frozen input, a missing site fact,
an unconfirmed unit or an undefined component refuses BY NAME instead of
returning a number. That has to survive the trip through a table, so:

* **Every evaluated item becomes exactly one row, refused or not.** Nothing is
  filtered out for having refused. A dataset that dropped refusals would report
  "3 sites" on an estate of four and look complete while doing it.
* **`status` is a DIMENSION and is never NULL.** It carries the evaluator's own
  status verbatim (`undefined_frozen`, `not_defined`, `blocked`, …), and
  `refusal_reason` carries the sentence a human reads. A row is therefore
  self-describing: nothing has to infer a refusal from a hole.
* **`value` is NULL on a refusal, and NULL is never a zero** — the rule the rest
  of this service already runs on (contract §4, `execute.cell`). There is no
  status under which a refusal produces a number, so a plotted point always
  means "measured".
* **An aggregate over a group that contains a refusal is itself refused.** Not
  averaged over the survivors. This is the evaluator's own composite rule
  (`_compose`: a composite of a refusal is a refusal) applied one level up, and
  it is the case that actually matters: `avg(value)` over four sites where three
  refused would otherwise render as a confident single number for one site.
  The honest denominator travels with it — `evaluations` counts the rows behind
  a group and `refusals` counts how many of them refused, so a widget can say
  "1 of 4 measured" instead of implying four.
* **`count` of `value` is exempt**, because a count is not a value: it answers
  "how many of these actually computed", which is the question a refused
  aggregate makes a viewer ask.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
* **No time series.** A reading is stored per bucket; an evaluation is not
  stored at all — it is computed for one window. Drawing a CCEI trend would mean
  re-running the whole fan-out once per bucket (a 24-point day = 24 × 4
  sub-indices × 14 leaves × every site), which is not a widget, it is a crawl.
  The honest way to a trend line is a materialized `metric_evaluations` relation
  written by a scheduled evaluator — then this dataset gains a relation and an
  `engine: sql` sibling, and nothing above changes. That is separate work and it
  is deliberately not faked here with an on-the-fly loop.
* **No `having`.** It would need this file to re-implement the operator
  semantics `sqlgen._predicate` already owns, on aggregates whose refusal rule
  is the one above; "refused" is not greater or less than anything.
* **No `series_by` / `band`**, both of which are time-series features.
* A widget must NAME its metrics. Evaluating all eleven definitions over every
  device is not a default anybody wants to pay for by accident, so an unfiltered
  query refuses and lists the keys instead of quietly choosing some of them.

BOTH SCOPES ARE PUBLISHED, and the shape says which is which. A site-scope
metric (`ccei`, `carbon_intensity`) answers one row per site, with `device_id`
NULL; a device-scope metric (`chiller_delta_t`) answers one row per device, with
`site_id` NULL. The site column on a device row is NULL because the EVALUATOR
answers per device and does not attribute a device to a site — a `site_id`
filter narrows which devices are evaluated (it is pushed into `evaluate`), but
it is a filter, not a fact about the row, and writing the filter's value into the
row would be this file inventing an attribution the evaluator never made.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from kernel.errors import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry import evaluator
from ..metric_registry import registry as metric_registry
from .builder import BuilderQuery, BuilderSpec
from .registry import Dataset, Definition
from .spec import ComparisonResult, TableResult

KEY = "metric_evaluations"

# How many metrics one widget may evaluate at once. Six is a dashboard row of
# tiles; it is a ceiling on fan-out, not a statement about the registry's size.
MAX_METRICS = 6

# The statuses the evaluator produces today, for the builder's value picker
# ONLY. It is a copy and it can drift — which is why nothing in the row path
# consults it: an unknown status still becomes a row carrying that status
# verbatim. A vocabulary that could silently swallow a refusal it had not heard
# of would defeat the point of the dataset.
STATUSES = (
    "ok",
    "missing_role",
    "ambiguous_role",
    "unit_unconfirmed",
    "unit_mismatch",
    "no_data",
    "undefined_frozen",
    "missing_fact",
    "missing_factor",
    "no_benchmark",
    "insufficient_coverage",
    "not_defined",
    "blocked",
)

# Filters this engine honours. `=`/`in` on `metric`, `site_id` and `device_id`
# are PUSHED DOWN into `evaluate` so the fan-out is bounded before any work
# happens; every filter is then applied again over the rows, so the pushdown is
# an optimisation that cannot change an answer.
_FILTER_OPS = ("=", "!=", "in", "contains", "is null", "is not null")

_DEFINITION = {
    "engine": "metric_registry",
    # Rows are computed per request against the caller's tenant, which
    # `evaluate` binds itself. There is no column here to filter on.
    "tenant_column": None,
    # The two rollups the evaluator reads, with the same ceiling and the same
    # auto rule it applies internally (`evaluator.pick_resolution`): 1-minute up
    # to 3 hours, 1-hour beyond. They are declared so `validated()` refuses a
    # too-wide window against `1m` BY NAME, exactly as it does for a reading —
    # and the chosen key is passed straight to `evaluate`, so the resolution a
    # result reports is the resolution that was read. `raw` is not offered at
    # all: the evaluator refuses it, and a dataset that published it would be
    # advertising a store this path will not use.
    "relations": [
        {
            "key": "1m",
            "relation": "readings_1m",
            "time_column": "bucket",
            "grain_sec": 60,
            "max_window_minutes": 180,
            "reason": "evaluated over the 1-minute rollup",
        },
        {
            "key": "1h",
            "relation": "readings_1h",
            "time_column": "bucket",
            "grain_sec": 3600,
            "reason": "evaluated over the 1-hour rollup",
        },
    ],
    "auto": [{"max_hours": 3, "relation": "1m"}, {"relation": "1h"}],
    "dimensions": [
        {
            "key": "metric",
            "label": "Metric",
            "column": "metric",
            "type": "text",
            "description": "The registered metric key. A widget must filter on this.",
        },
        {
            "key": "metric_label",
            "label": "Metric name",
            "column": "metric_label",
            "type": "text",
            "description": "The definition's display name.",
        },
        {
            "key": "metric_version",
            "label": "Definition version",
            "column": "metric_version",
            "type": "number",
            "description": (
                "The version EFFECTIVE at the window's end — an older window is "
                "answered under the formula it was measured with."
            ),
        },
        {
            "key": "scope",
            "label": "Scope",
            "column": "scope",
            "type": "text",
            "description": "site or device — what one row of this metric is about.",
        },
        {
            "key": "site_id",
            "label": "Site",
            "column": "site_id",
            "type": "uuid",
            "description": "Set on a site-scope row; NULL on a device-scope one.",
        },
        {"key": "site_name", "label": "Site name", "column": "site_name", "type": "text"},
        {
            "key": "device_id",
            "label": "Device",
            "column": "device_id",
            "type": "uuid",
            "description": "Set on a device-scope row; NULL on a site-scope one.",
        },
        {"key": "device_tag", "label": "Device tag", "column": "device_tag", "type": "text"},
        {
            "key": "status",
            "label": "Status",
            "column": "status",
            "type": "text",
            "description": (
                "`ok`, or the name of the refusal. Never NULL: a row with no "
                "value says here why it has none."
            ),
        },
        {
            "key": "refusal_reason",
            "label": "Why not",
            "column": "refusal_reason",
            "type": "text",
            "description": "The evaluator's sentence, verbatim. NULL when status is ok.",
        },
        {
            "key": "unit",
            "label": "Unit",
            "column": "unit",
            "type": "text",
            "description": "The unit the DEFINITION declares. Never inferred here.",
        },
    ],
    "measures": [
        {
            "key": "value",
            "label": "Value",
            "aggregates": ["avg", "min", "max", "sum", "count"],
            "unit_dimension": "unit",
            "comparable": False,
            # The label is 1:1 with the key, so grouping by either one pins the
            # metric — refusing a table grouped by the human-readable column
            # would be the rule getting in the way of the thing it protects.
            "comparable_within": ["metric", "metric_label"],
            "incomparable_hint": (
                "a 0–100 index and a gCO₂/kWh intensity are not the same kind of "
                "number, so one average over both would mean nothing."
            ),
            "description": (
                "The evaluated value, or NULL where the metric refused — see "
                "`status`. An aggregate over a group containing a refusal is "
                "itself NULL rather than an average of the survivors."
            ),
        },
        {
            "key": "evaluations",
            "label": "Evaluations",
            "aggregates": ["sum"],
            "description": "How many items were evaluated behind this row — the denominator.",
        },
        {
            "key": "refusals",
            "label": "Refusals",
            "aggregates": ["sum"],
            "description": (
                "How many of them refused. Non-zero is why a value is NULL, and "
                "it is the number that makes a blank honest instead of broken."
            ),
        },
    ],
    "defaults": {
        "label_dimension": "metric_label",
        "measure": "value",
        "aggregate": "avg",
    },
}

DATASET = Dataset(
    key=KEY,
    name="Metric evaluations",
    description=(
        "One row per metric evaluated over the widget's window — per site for a "
        "site-scope metric, per device for a device-scope one. A metric that "
        "cannot honestly compute returns a row naming the refusal, never a zero."
    ),
    # The same key as `iot_readings`: a metric is a statement about the readings
    # this key already grants, and a second permission would only mean a role
    # that can chart the inputs cannot chart the conclusion.
    permission="bi.read",
    permission_label="Read building intelligence data",
    definition=Definition.model_validate(_DEFINITION),
)


def virtual_datasets() -> dict[str, Dataset]:
    """Datasets that are computed rather than stored. Read by `registry.load`."""
    return {DATASET.key: DATASET}


# ── rows ─────────────────────────────────────────────────────────────────────


def _as_text(v: Any) -> str | None:
    return None if v is None else str(v)


def _row_of(result: dict, item: dict) -> dict:
    """One evaluated item, as a cell dict keyed by DIMENSION key.

    `value` is taken only when the status is `ok`. That is belt-and-braces — the
    evaluator's `_refusal` already carries `value: None` — but it is the one
    invariant this whole dataset rests on, so it is enforced here rather than
    trusted from a dict that travels through four call sites.
    """
    ok = item.get("status") == "ok"
    display = result.get("display") or {}
    return {
        "metric": result["metric"],
        "metric_label": display.get("label") or result["metric"],
        "metric_version": result.get("version"),
        "scope": "site" if item.get("site_id") else "device",
        "site_id": _as_text(item.get("site_id")),
        "site_name": item.get("site_name"),
        "device_id": _as_text(item.get("device_id")),
        "device_tag": item.get("device_tag"),
        "status": item.get("status") or "blocked",
        "refusal_reason": None if ok else item.get("reason"),
        "unit": (result.get("output") or {}).get("unit"),
        "__value": float(item["value"]) if ok and item.get("value") is not None else None,
        "__ok": ok and item.get("value") is not None,
    }


def _wanted_metrics(q: BuilderQuery) -> list[str]:
    keys: list[str] = []
    for f in q.filters:
        if f.column != "metric" or not f.complete():
            continue
        if f.op == "=":
            keys.append(str(f.value))
        elif f.op == "in":
            keys.extend(str(v) for v in f.values)
    # De-duplicated, order preserved: a widget naming `ccei` twice through a
    # dashboard filter and its own must not evaluate it twice.
    seen: dict[str, None] = {}
    for k in keys:
        seen.setdefault(k, None)
    return list(seen)


def _pushdown(q: BuilderQuery, column: str) -> str | None:
    """The single value an `=` filter pins `column` to, if any.

    Only `=` is pushed down: `evaluate` takes ONE site and ONE device, so an
    `in` over three sites is honoured by the row-level filter below instead.
    """
    for f in q.filters:
        if f.column == column and f.op == "=" and f.complete():
            return str(f.value)
    return None


def _matches(row: dict, column: str, op: str, value: Any, values: list) -> bool:
    cell = row.get(column)
    if op == "is null":
        return cell is None
    if op == "is not null":
        return cell is not None
    if cell is None:
        # A NULL never satisfies a positive predicate, and — as in SQL — it does
        # not satisfy `!=` either. A device row is not "a site other than this
        # one"; it has no site.
        return False
    text = str(cell).lower()
    if op == "=":
        return text == str(value).lower()
    if op == "!=":
        return text != str(value).lower()
    if op == "in":
        return text in {str(v).lower() for v in values}
    if op == "contains":
        return str(value).lower() in text
    raise ValidationError(f"'{op}' is not available on the {KEY} dataset")


def _check_supported(q: BuilderQuery) -> None:
    """Refuse, by name, everything this engine cannot answer honestly.

    Each of these is a real capability of the SQL datasets, so silence would
    read as support: a widget that asked for a trend and got one flat point
    would look like a broken chart rather than an unmet requirement.
    """
    if q.time_series or q.series_by or q.band:
        raise ValidationError(
            "the metric dataset has no time axis: an evaluation is computed for "
            "one window, not stored per bucket, so a trend would mean re-running "
            "every metric once per point. Chart it as a table, bar or stat, or "
            "compare two windows with `compare`."
        )
    if q.having:
        raise ValidationError(
            "`having` is not available on the metric dataset — a refused "
            "aggregate is not greater or less than anything; filter on `status` "
            "instead"
        )
    if q.filter_combinator == "OR":
        raise ValidationError(
            "the metric dataset combines filters with AND only: under OR a "
            "`metric` filter no longer bounds what gets evaluated"
        )
    for f in q.filters:
        if f.op not in _FILTER_OPS:
            raise ValidationError(
                f"'{f.op}' is not available on the metric dataset; it accepts: "
                + ", ".join(_FILTER_OPS)
            )


async def _evaluate(
    db: AsyncSession,
    tenant: Any,
    q: BuilderQuery,
    *,
    resolution: str,
    start: dt.datetime,
    end: dt.datetime,
) -> list[dict]:
    """Fan out over the named metrics and return one row per evaluated item."""
    keys = _wanted_metrics(q)
    if not keys:
        known = [d["key"] for d in await metric_registry.list_definitions(db, tenant)]
        offered = ", ".join(sorted(set(known))) or "none registered"
        raise ValidationError(
            "a metric widget has to say WHICH metric: add a filter on `metric`. "
            f"This tenant has: {offered}."
        )
    if len(keys) > MAX_METRICS:
        raise ValidationError(
            f"{len(keys)} metrics asked for at once; {MAX_METRICS} is the "
            "ceiling, because each one is a full evaluation over every site or "
            "device in scope"
        )

    site = _pushdown(q, "site_id")
    device = _pushdown(q, "device_id")
    rows: list[dict] = []
    for key in keys:
        try:
            result = await evaluator.evaluate(
                db, tenant, key,
                device_id=device, site_id=site,
                start=start, end=end, resolution=resolution,
            )
        except evaluator.EvaluationError as exc:
            # An unknown metric, or one with no version effective at this
            # window's end. That is a bad REQUEST — the widget names something
            # that does not exist — and it is a 400 naming it, not an empty
            # chart the author would read as "no data".
            raise ValidationError(str(exc)) from exc
        for item in result.get("items") or []:
            rows.append(_row_of(result, item))

    for f in q.filters:
        if not f.complete():
            continue
        rows = [r for r in rows if _matches(r, f.column, f.op, f.value, f.values)]
    return rows


# ── grouping ─────────────────────────────────────────────────────────────────


def _group_keys(q: BuilderQuery) -> list[str]:
    """Which dimensions define a group.

    SQL's rule, kept: an explicit `group_by` wins, otherwise the selected
    dimensions are the grouping. A selected dimension outside the grouping is
    refused rather than answered from an arbitrary member of the group — that is
    exactly how a table ends up labelling one site's number with another site's
    name.
    """
    dims = [i.dimension for i in q.select if i.dimension]
    keys = list(q.group_by) if q.group_by else list(dict.fromkeys(dims))
    for d in dims:
        if d not in keys:
            raise ValidationError(
                f"'{d}' is shown but not grouped by; add it to the grouping, or "
                "remove it — one cell cannot stand for several different values"
            )
    return keys


def _aggregate(agg: str, group: list[dict]) -> float | None:
    """One `value` aggregate over one group, or NULL because it refused.

    The refusal rule is the whole point and it is one line: ANY refused row in
    the group refuses the aggregate. `count` is the exception, and it is not an
    exception to the rule so much as a different question — "how many of these
    computed" — which stays answerable precisely when the value does not.
    """
    if agg == "count":
        return float(sum(1 for r in group if r["__ok"]))
    if any(not r["__ok"] for r in group):
        return None
    values = [r["__value"] for r in group if r["__value"] is not None]
    if not values:
        return None
    if agg == "avg":
        return sum(values) / len(values)
    if agg == "min":
        return min(values)
    if agg == "max":
        return max(values)
    if agg == "sum":
        return sum(values)
    raise ValidationError(f"'{agg}' is not available on the metric dataset")


def _measure_cell(item, group: list[dict]) -> Any:
    if item.measure == "value":
        return _aggregate(item.aggregate or "avg", group)
    if item.measure == "evaluations":
        return len(group)
    if item.measure == "refusals":
        return sum(1 for r in group if not r["__ok"])
    raise ValidationError(f"unknown measure {item.measure!r}")


def _table(q: BuilderQuery, rows: list[dict]) -> tuple[list[list[Any]], int]:
    """Rows → output rows, plus how many groups existed before the LIMIT."""
    keys = _group_keys(q)
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        groups.setdefault(tuple(r.get(k) for k in keys), []).append(r)
    if not keys:
        # No grouping at all: one row over everything matched, which is the shape
        # a stat tile asks for. An empty match still produces that one row, so a
        # tile shows an explicit blank rather than disappearing.
        groups = {(): rows}

    out: list[list[Any]] = []
    for group in groups.values():
        row: list[Any] = []
        for item in q.select:
            if item.dimension:
                row.append(group[0].get(item.dimension) if group else None)
            else:
                row.append(_measure_cell(item, group))
        out.append(row)

    for o in reversed(q.order_by):
        # NULLs last in BOTH directions, which is why this partitions rather than
        # sorting on a (is_null, value) key: under `desc` such a key reverses the
        # null flag too and lands every refusal at the top of a "worst first"
        # table, where it reads as the worst measured value.
        i = o.select_index
        present = [r for r in out if r[i] is not None]
        absent = [r for r in out if r[i] is None]
        present.sort(key=lambda r: r[i], reverse=(o.dir == "desc"))
        out = present + absent
    matched = len(out)
    return out[: q.limit], matched


def _columns(q: BuilderQuery, ds: Dataset) -> list[str]:
    d = ds.definition
    return [
        (i.alias or (d.measure(i.measure).label if i.measure else d.dimension(i.dimension).label))
        for i in q.select
    ]


def _row_key(q: BuilderQuery, row: list[Any]) -> tuple:
    dims = [i for i, item in enumerate(q.select) if item.dimension is not None]
    return tuple(row[i] for i in dims if i < len(row))


# ── execution ────────────────────────────────────────────────────────────────


async def run(db: AsyncSession, tenant: Any, ds: Dataset, spec: BuilderSpec) -> TableResult:
    """`/bi/query` for a computed dataset. Dispatched to by `execute.run`.

    The state has already been through `BuilderQuery.validated(ds)` — the same
    window ceiling, the same resolution refusal, the same comparability rule as
    every other dataset — so what is left here is evaluation and shaping.
    """
    q = spec.query
    _check_supported(q)
    start, end = q.window.resolve()
    hours = (end - start).total_seconds() / 3600.0
    explicit = q.resolution != "auto"
    rel = ds.definition.relation(q.resolution) if explicit else ds.definition.choose_relation(hours)

    rows = await _evaluate(db, tenant, q, resolution=rel.key, start=start, end=end)
    table, matched = _table(q, rows)

    comparison = None
    if q.compare is not None:
        # The same window length, the same relation, the same code path — and
        # the alignment is `execute._align`'s, not a second one, so a group that
        # exists in one period and not the other cannot be paired with whatever
        # happened to be at the same index.
        from . import execute as ex

        prior_start, prior_end = q.compare.shift(start, end)
        prior_rows = await _evaluate(
            db, tenant, q, resolution=rel.key, start=prior_start, end=prior_end
        )
        prior_table, _ = _table(q, prior_rows)
        index = {_row_key(q, r): r for r in prior_table}
        aligned: list[list[Any]] = []
        deltas: list[list[float | None]] = []
        used = set()
        width = len(q.select)
        for row in table:
            key = _row_key(q, row)
            match = index.get(key)
            if match is not None:
                used.add(key)
            padded = list(match) if match is not None else [None] * width
            aligned.append(padded)
            deltas.append([ex._delta(row[i], padded[i]) for i in range(width)])
        comparison = ComparisonResult(
            period=q.compare.period,
            label=q.compare.label,
            start=prior_start,
            end=prior_end,
            rows=aligned,
            delta_pct=deltas,
            # "Nothing computed in the earlier window" — which for this dataset
            # includes a window where every metric refused. A delta against a
            # window of refusals is not a change, and the flag is how a renderer
            # says so instead of drawing one.
            no_data=not any(r["__ok"] for r in prior_rows),
            only_previous=len(index) - len(used),
        )

    refused = sum(1 for r in rows if not r["__ok"])
    return TableResult(
        shape="table",
        dataset=ds.key,
        resolution=rel.key,
        resolution_reason=(rel.reason if explicit else f"{rel.reason} (chosen for this window)"),
        start=start,
        end=end,
        columns=_columns(q, ds),
        rows=table,
        label_index=0,
        comparison=comparison,
        matched=matched,
        truncated=matched > len(table),
        band=None,
        # Not SQL, and it does not pretend to be: the builder's "show me the
        # query" panel says what actually ran. An empty string here would read as
        # "the server hid it".
        sql=(
            f"-- no SQL: rows are computed by metric_registry.evaluator over "
            f"{rel.relation}\n"
            f"-- metrics: {', '.join(_wanted_metrics(q))}\n"
            f"-- {len(rows)} item(s) evaluated, {refused} refused"
        ),
    )


async def distinct_values(
    db: AsyncSession, tenant: Any, *, column: str, search: str | None, limit: int
) -> dict:
    """The filter picker's values. Dispatched to by `execute.distinct_values`.

    Only the three columns that are worth picking from a list, and NO COUNTS: a
    count of rows per metric would mean evaluating every metric to populate a
    dropdown. `count: null` is served rather than a zero, because a zero here
    would say "this metric matches nothing", which is a claim nobody measured.
    """
    if column == "metric":
        defs = await metric_registry.list_definitions(db, tenant)
        seen: dict[str, str] = {}
        for d in defs:
            # Definitions arrive newest-version-first per key; the first label
            # wins so the picker shows the current name, not the original one.
            seen.setdefault(d["key"], (d.get("display") or {}).get("label") or d["key"])
        items = [{"value": k, "label": v, "count": None} for k, v in sorted(seen.items())]
    elif column == "status":
        items = [{"value": s, "label": s, "count": None} for s in STATUSES]
    elif column == "scope":
        items = [{"value": s, "label": s, "count": None} for s in ("site", "device")]
    else:
        raise ValidationError(
            f"the metric dataset lists values for: metric, status, scope — not "
            f"{column!r}. A site or device list comes from the estate, not from "
            "the metric registry."
        )
    if search:
        needle = search.lower()
        items = [i for i in items if needle in i["value"].lower() or needle in i["label"].lower()]
    return {
        "column": column,
        "label": column,
        "resolution": "n/a",
        "items": items[:limit],
    }
