"""BUILDER STATE — what a widget stores, and what the server turns into SQL.

This is spec_version 2 and it is the generalisation the builder contract asks
for: instead of an IoT vocabulary (`scope: points | device | category | all`) a
widget names a DATASET from the registry and picks columns out of it. The same
state charts a reading, a door-access event and a fire-panel state, because the
only thing it knows about is dimensions, measures and aggregates.

Two rules from contract §3, and neither is negotiable:

1. **The client sends STATE. The server generates the SQL.** There is no field
   here in which SQL can arrive, and `extra="forbid"` on every model means a body
   carrying `sql`, `query` or `where` is a 400 naming the field rather than a
   silently-ignored key. The generator itself is `sqlgen.py`.

2. **Widgets store STATE, not generated SQL.** The reference product persists SQL
   in `Widget.query`, which freezes every generator bug into every saved
   dashboard. Storing state means fixing the generator fixes widgets that were
   saved before the fix — which is exactly what `_migrate` below relies on.

MIGRATION (contract §6)
-----------------------
`migrate_v1` translates a stored v1 spec into this shape. It is not a
compatibility shim bolted on the side: v1 widgets are EXECUTED as v2, through the
one generator, so there is one place the honesty rules live. The four widgets on
the existing "Building Overview" dashboard go through it on every read.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from kernel.errors import ValidationError
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .registry import BuilderAggregate, Dataset, Definition

# Ceilings. A widget asking for 500 series is a bug and should fail at the edge
# rather than become a slow query.
MAX_SERIES = 24
MAX_ROWS = 200
MAX_BUCKETS = 5000
MAX_HOURS = 24 * 90

# Ported verbatim from the reference's `FILTER_OP_OPTIONS`. `contains` is the
# wildcard-escaped LIKE; `like` passes the pattern through.
FilterOp = Literal[
    "=", "!=", "<", "<=", ">", ">=", "contains", "like", "in", "between", "is null", "is not null"
]

# Aggregates that produce a COUNT rather than a value in the measure's own units.
# The comparability rule (contract §4) does not apply to them: counting readings
# from two differently-measured points is meaningful; averaging them is not.
COUNTING_AGGREGATES = {"count", "count_distinct"}


class Window(BaseModel):
    """The time range, expressed RELATIVELY by default.

    `last_hours` is what keeps a saved dashboard useful: it means "the last six
    hours", resolved at render time, not a window frozen on the afternoon
    somebody built the widget.
    """

    model_config = ConfigDict(extra="forbid")

    last_hours: float | None = Field(default=6, gt=0, le=MAX_HOURS)
    start: dt.datetime | None = None
    end: dt.datetime | None = None

    def resolve(self) -> tuple[dt.datetime, dt.datetime]:
        now = dt.datetime.now(dt.timezone.utc)
        if self.start is not None or self.end is not None:
            end = self.end or now
            start = self.start or (end - dt.timedelta(hours=self.last_hours or 6))
        else:
            end = now
            start = end - dt.timedelta(hours=self.last_hours or 6)
        if start.tzinfo is None:
            start = start.replace(tzinfo=dt.timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=dt.timezone.utc)
        if start >= end:
            raise ValidationError("window start must be before end")
        if (end - start) > dt.timedelta(hours=MAX_HOURS):
            raise ValidationError(f"window is limited to {MAX_HOURS} hours")
        return start, end


class SelectItem(BaseModel):
    """One output column: a plain dimension, or a measure under an aggregate."""

    model_config = ConfigDict(extra="forbid")

    # Exactly one of these. `dimension` names a registry dimension key, `measure`
    # a registry measure key — neither is ever a column NAME from the client.
    dimension: str | None = None
    measure: str | None = None
    aggregate: BuilderAggregate | None = None
    alias: str | None = None

    @model_validator(mode="after")
    def _one_of(self) -> "SelectItem":
        if bool(self.dimension) == bool(self.measure):
            raise ValueError("a select item is either a dimension or a measure, not both")
        if self.measure and not self.aggregate:
            raise ValueError("a measure select item needs an aggregate")
        if self.dimension and self.aggregate:
            raise ValueError("a dimension select item takes no aggregate")
        return self

    @property
    def out_name(self) -> str:
        if self.alias:
            return self.alias
        if self.dimension:
            return self.dimension
        return f"{self.measure}_{self.aggregate}"


class Filter(BaseModel):
    """One WHERE predicate over a DIMENSION.

    Values are never interpolated: `sqlgen` binds them as parameters. They are
    carried as strings (and lists for `in`) because the builder's inputs are text
    boxes; the generator casts per the dimension's declared type.
    """

    model_config = ConfigDict(extra="forbid")

    column: str
    op: FilterOp = "="
    value: str | float | int | bool | None = None
    value2: str | float | int | bool | None = None
    values: list[str | float | int | bool] = Field(default_factory=list)
    # The NAME of a dashboard variable supplying this filter's value.
    #
    # This is how a widget says "whichever site the page is showing" without any
    # template language and without anything being substituted into a query. The
    # name is a dict key looked up in Python (`context.resolve`); what it resolves
    # to lands in `value`/`values` and is BOUND by `sqlgen._predicate` like every
    # other value. The name itself never reaches SQL, and there is deliberately no
    # `raw` escape hatch — the reference needs one only because its variables are
    # spliced into query text.
    variable: str | None = Field(default=None, max_length=64)

    def complete(self) -> bool:
        if self.variable:
            # Unresolved. `context.resolve` either fills it in or drops the
            # filter, and it runs before validation — so a `variable` still set
            # here means the widget was executed with no dashboard context, and
            # an unresolved predicate must never quietly become no predicate.
            return False
        if self.op in ("is null", "is not null"):
            return True
        if self.op == "in":
            return len(self.values) > 0
        if self.value is None or (isinstance(self.value, str) and not self.value.strip()):
            return False
        if self.op == "between" and self.value2 is None:
            return False
        return True


class Having(BaseModel):
    """One HAVING predicate over an aggregated measure."""

    model_config = ConfigDict(extra="forbid")

    measure: str
    aggregate: BuilderAggregate
    op: FilterOp = ">"
    value: float | int | None = None
    value2: float | int | None = None

    def complete(self) -> bool:
        if self.op in ("is null", "is not null"):
            return True
        if self.value is None:
            return False
        if self.op == "between" and self.value2 is None:
            return False
        return True


class OrderBy(BaseModel):
    """One ORDER BY term, referencing a SELECT item by index (the reference's
    design — it cannot name a column that is not in the output)."""

    model_config = ConfigDict(extra="forbid")

    select_index: int = Field(ge=0)
    dir: Literal["asc", "desc"] = "desc"


class BuilderQuery(BaseModel):
    """The executable half of a v2 spec. Everything here reaches the database."""

    model_config = ConfigDict(extra="forbid")

    dataset: str
    # A relation key from the dataset, or "auto" to let the registry's rules pick.
    resolution: str = "auto"
    window: Window = Field(default_factory=Window)

    select: list[SelectItem] = Field(default_factory=list, max_length=12)
    # When true the first output column is the time bucket and the query is
    # grouped by it — the shape a line chart needs.
    time_series: bool = False
    # A dimension whose distinct values become one output column each. Only
    # meaningful with `time_series`; this is the pivot a multi-line chart needs
    # and it is done in PYTHON, not by generating dynamic SQL columns.
    series_by: str | None = None
    # A dimension used ONLY for the legend of a split series. It exists because
    # the split key is usually an id (`point_id`) and the label is not — v1's
    # legend showed `point_tag`, and dropping to raw uuids would be a regression
    # dressed up as generalisation.
    series_label: str | None = None

    filters: list[Filter] = Field(default_factory=list, max_length=20)
    filter_combinator: Literal["AND", "OR"] = "AND"
    group_by: list[str] = Field(default_factory=list, max_length=6)
    having: list[Having] = Field(default_factory=list, max_length=10)
    order_by: list[OrderBy] = Field(default_factory=list, max_length=4)
    limit: int = Field(default=12, ge=1, le=MAX_ROWS)
    # Draw the min→max envelope behind a single series. Set by the frontend for a
    # line widget with one series; the executor answers it with two extra columns
    # rather than the frontend inventing a range it did not measure.
    band: bool = False

    # ── opting out of the dashboard's context ────────────────────────────────
    #
    # These live in the WIDGET's stored state rather than in the session, because
    # "this tile deliberately shows the whole estate while the rest of the page is
    # scoped to one site" is a property of the widget its author decided on, and
    # it must survive a reload, a share and somebody else opening the page.
    #
    # `ignore_filters` names dashboard-filter IDs. It is never used in SQL — it is
    # a set membership test in `context.resolve`.
    ignore_filters: list[str] = Field(default_factory=list, max_length=20)
    ignore_all_filters: bool = False
    # Keep the widget's own time window when the page changes its own. A
    # "last 24 hours" comparison tile beside a "this week" chart is a legitimate
    # thing to build, and it is a lie if the page silently retimes it.
    ignore_window: bool = False

    # ── validation against a DATASET ─────────────────────────────────────────

    def validated(self, ds: Dataset) -> "BuilderQuery":
        d = ds.definition
        if not self.select:
            raise ValidationError("pick at least one column or measure to show")

        for item in self.select:
            if item.dimension:
                d.dimension(item.dimension)
            else:
                m = d.measure(item.measure or "")
                if item.aggregate not in m.aggregates:
                    raise ValidationError(
                        f"'{item.aggregate}' is not available for '{m.label}'. "
                        f"This measure permits: {', '.join(m.aggregates)}."
                    )
        for key in self.group_by:
            d.dimension(key)
        for f in self.filters:
            d.dimension(f.column)
        for h in self.having:
            m = d.measure(h.measure)
            if h.aggregate not in m.aggregates:
                raise ValidationError(
                    f"'{h.aggregate}' is not available for '{m.label}' in a HAVING clause"
                )
        for o in self.order_by:
            if o.select_index >= len(self.select):
                raise ValidationError("an ordering references a column that is not selected")
        if self.series_label:
            d.dimension(self.series_label)
            if not self.series_by:
                raise ValidationError("series_label needs a series_by")
        if self.series_by:
            d.dimension(self.series_by)
            if not self.time_series:
                raise ValidationError("series_by only applies to a time-series widget")
            measures = [s for s in self.select if s.measure]
            if len(measures) != 1:
                raise ValidationError(
                    "a split-by-series chart draws exactly one measure; "
                    "remove the others or drop the split"
                )
        if self.band and not (self.time_series and self.series_by):
            raise ValidationError("the min/max band applies to a split time-series only")

        start, end = self.window.resolve()
        hours = (end - start).total_seconds() / 3600.0
        rel = d.choose_relation(hours) if self.resolution == "auto" else d.relation(self.resolution)
        if rel.max_window_minutes is not None and hours * 60 > rel.max_window_minutes:
            # No silent downgrade (contract §4). Name the store to ask for instead.
            wider = [
                r.key
                for r in d.relations
                if r.max_window_minutes is None or r.max_window_minutes > rel.max_window_minutes
            ]
            raise ValidationError(
                f"'{rel.key}' is limited to {rel.max_window_minutes} minutes "
                f"(asked for {int(hours * 60)}); use "
                + (", ".join(wider) if wider else "a shorter window")
            )

        self._check_comparability(d)

        if self.time_series and self.series_by and self.limit > MAX_SERIES:
            raise ValidationError(f"a split time-series draws at most {MAX_SERIES} series")
        return self

    def _check_comparability(self, d: Definition) -> None:
        """Contract §4, generalised: refuse to aggregate incomparable series.

        A measure the dataset declares INCOMPARABLE (the IoT reading value: no
        unit is on the wire, so a power factor and a voltage are not the same
        kind of number) may only be aggregated once it is pinned to a single
        series — grouped by, split by, or filtered down to one value of a
        dimension the measure names as its comparability key.

        The refusal SAYS WHAT TO DO instead; that is the half of the v1 rule that
        makes it usable rather than merely correct.
        """
        pinned = set(self.group_by) | ({self.series_by} if self.series_by else set())
        for f in self.filters:
            # An equality filter (or a one-item IN) pins the dimension just as
            # well as grouping by it does.
            if f.op == "=" and f.complete():
                pinned.add(f.column)
            elif f.op == "in" and len(f.values) == 1:
                pinned.add(f.column)

        for item in self.select:
            if not item.measure or item.aggregate in COUNTING_AGGREGATES:
                continue
            m = d.measure(item.measure)
            if m.comparable:
                continue
            if pinned & set(m.comparable_within):
                continue
            names = ", ".join(d.dimension(k).label for k in m.comparable_within)
            hint = m.incomparable_hint or (
                "values from different series are not comparable, so this number "
                "would have no meaning"
            )
            raise ValidationError(
                f"'{item.aggregate}' of '{m.label}' cannot be computed across "
                f"mixed series: {hint} Group by (or filter to) one of: {names}."
            )


class BuilderSpec(BaseModel):
    """A whole v2 widget definition, as stored on a dashboard row."""

    model_config = ConfigDict(extra="forbid")

    spec_version: Literal[2] = 2
    viz: str = "line"
    query: BuilderQuery
    # Presentation only. Never reaches the database, never validated here — a
    # newer frontend's option key must not make an older backend reject the spec.
    options: dict = Field(default_factory=dict)


# ── v1 → v2 migration (contract §6) ──────────────────────────────────────────
#
# The four widgets on the existing "Building Overview" dashboard are v1. They are
# not kept alive by a parallel executor — they are TRANSLATED here and run through
# the one v2 path, so there is exactly one place the honesty rules live and one
# generator whose fixes reach every saved widget.

# v1 metric → (measure, aggregate) on the seeded `iot_readings` dataset.
_V1_METRIC = {
    "avg": ("value", "avg"),
    "min": ("value", "min"),
    "max": ("value", "max"),
    "first": ("value", "first"),
    "last": ("value", "last"),
    # v1's `count` was SAMPLES — a tally of readings, not a physical quantity.
    "count": ("samples", "sum"),
}

_V1_GROUP_DIM = {"point": "point_id", "device": "device_tag", "category": "category"}


def migrate_v1(raw: dict) -> dict:
    """Translate a stored v1 spec into v2 builder state.

    Deliberately total: every v1 spec that used to execute produces a v2 spec that
    executes, because a saved dashboard going blank is not an acceptable cost of
    this rewrite.
    """
    q = dict(raw.get("query") or {})
    scope = dict(q.get("scope") or {})
    metric = q.get("metric", "avg")
    measure, aggregate = _V1_METRIC.get(metric, ("value", "avg"))
    kind = q.get("kind", "series")
    group_by = q.get("group_by", "point")

    filters: list[dict] = []
    stype = scope.get("type", "points")
    if stype == "points":
        ids = scope.get("point_ids") or []
        filters.append({"column": "point_id", "op": "in", "values": [str(x) for x in ids]})
    elif stype == "device":
        if scope.get("device_id"):
            filters.append({"column": "device_id", "op": "=", "value": str(scope["device_id"])})
        elif scope.get("device_tag"):
            filters.append({"column": "device_tag", "op": "=", "value": scope["device_tag"]})
    elif stype == "category":
        cat = scope.get("category")
        if cat == "" or cat is None:
            # v1: category="" meant the points nothing has classified.
            filters.append({"column": "category", "op": "is null"})
        else:
            filters.append({"column": "category", "op": "=", "value": cat})
    # "all" adds nothing but the tenant filter, exactly as in v1.

    if metric != "count":
        # v1 restricted value metrics to numeric points: a text point has no
        # `num`, and including it would show a permanently blank row.
        filters.append({"column": "reading_kind", "op": "=", "value": "num"})

    resolution = q.get("rollup", "auto")
    window = dict(q.get("window") or {"last_hours": 6})
    limit = int(q.get("limit", 12) or 12)
    viz = raw.get("viz", "line")

    if kind == "series":
        query = {
            "dataset": "iot_readings",
            "resolution": resolution,
            "window": window,
            "time_series": True,
            "series_by": "point_id",
            "series_label": "point_tag",
            "select": [{"measure": measure, "aggregate": aggregate}],
            "filters": filters,
            "limit": min(limit, MAX_SERIES),
            "band": bool((raw.get("options") or {}).get("band")),
        }
    else:
        dim = _V1_GROUP_DIM.get(group_by, "point_id")
        if dim == "point_id":
            # v1's per-point aggregate table: label, sublabel, value, samples.
            select = [
                {"dimension": "point_tag", "alias": "point"},
                {"dimension": "device_tag", "alias": "device"},
                {"measure": measure, "aggregate": aggregate, "alias": metric},
                {"measure": "samples", "aggregate": "sum", "alias": "samples"},
            ]
            group = ["point_id", "point_tag", "device_tag"]
        else:
            select = [
                {"dimension": dim, "alias": group_by},
                {"measure": "samples", "aggregate": "sum", "alias": "samples"},
            ]
            group = [dim]
        query = {
            "dataset": "iot_readings",
            "resolution": resolution,
            "window": window,
            "time_series": False,
            "select": select,
            "group_by": group,
            # v1 ordered a grouped aggregate by sample volume, descending.
            "order_by": [{"select_index": len(select) - 1, "dir": "desc"}],
            "filters": filters,
            "limit": limit,
        }

    # The dashboard-context opt-outs are carried ACROSS the migration rather than
    # being dropped. v1 never had them, so a genuinely old spec has none — but a
    # v1 spec that has been given one (by the API, or by a half-migrated write)
    # means it, and silently discarding it would make a widget follow a filter its
    # author had explicitly excluded it from.
    for key in ("ignore_filters", "ignore_all_filters", "ignore_window"):
        if key in q:
            query[key] = q[key]

    return {
        "spec_version": 2,
        "viz": viz,
        "query": query,
        "options": dict(raw.get("options") or {}),
    }
