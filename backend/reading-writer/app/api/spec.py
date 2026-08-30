"""The WIDGET QUERY SPEC — a structured, versioned description of what a
dashboard widget shows. This is the contract the dashboard builder writes and
this service executes.

## Why a spec and not SQL

The obvious alternative is letting a widget carry a SQL string. It is rejected
here, deliberately and permanently:

* This platform runs video surveillance and access control. Arbitrary SQL
  arriving from a browser is a far worse trade here than in a standalone BI tool,
  because the blast radius of a guard bug is the whole console.
* Free-SQL guards are genuinely hard. The reference implementation reviewed
  before this module was written had three real defects — a leading comment was
  rejected outright, a trailing comment broke the wrapper the guard appended, and
  validation truncated at the first `;` even when that `;` was inside a string
  literal or a comment. Each is a small mistake; together they are a bypass.
* This module does not need one. The data is KNOWN: a `points` dimension and two
  continuous aggregates. Picking a scope, a metric, a window and a rollup covers
  every question the store can honestly answer — and picking rather than typing
  is what makes the builder no-code in the first place.

## Forward compatibility — the part that must not be got wrong

A saved dashboard is data with a long life. It has to survive this module
gaining widget types it has never heard of. Three rules make that true:

1. **`viz` is not validated here.** The executor does not care how a result is
   drawn; it only cares about `query.kind`. Adding a "gauge" or "heatmap" that
   reuses the `aggregate` result shape therefore needs NO backend change at all,
   and an old backend serving a new frontend keeps working.
2. **`query.kind` is the small, closed set** (`series`, `aggregate`) — the RESULT
   SHAPES, not the chart types. Four visualisations ship in v1 and they use two
   shapes between them. New shapes are a spec-version bump; new charts are not.
3. **`spec_version` is checked, and a spec from the FUTURE is refused loudly**
   rather than being half-executed with fields this build silently ignored. A
   spec from the PAST is migrated by `_migrate` (a no-op today, and the hook that
   means v1 widgets keep rendering after v2 lands).

`options` is free-form on purpose: it is presentation only (title, accent,
decimals) and never reaches the database. `extra="forbid"` on everything that DOES
reach the database is the other half of that trade — a typo'd `metrc` is a 400
naming the field, not a silently-ignored key that makes the widget show the
wrong number.

## The honesty rules this spec enforces

They are the same rules the rest of Building Intelligence lives by, moved into
the one place a widget can be built:

* **Charts read the ROLLUPS.** `rollup="raw"` is accepted only inside
  `RAW_MAX_MINUTES`; past it the widget is refused with the rollup to ask for
  instead. Nothing is silently downgraded, because a chart that quietly changes
  resolution is a chart that lies about its own precision.
* **No unit is invented.** `unit` is passed through from `points.unit` and is
  NULL for every point on this deployment, which is correct — the source payloads
  carry none.
* **A value metric cannot be grouped across points.** Averaging a power factor
  with a voltage because they hang off the same device produces a number that
  means nothing. So `group_by` of `device` or `category` is allowed ONLY for
  `count` (samples), which is a quantity the pipeline genuinely knows — the same
  reasoning `/bi/activity` already uses. Everything else groups by point.
* **Value metrics select numeric points only.** A text point ("mode", "status")
  has no `num`, and including it would show a row that is permanently blank.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from kernel.errors import ValidationError
from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError

from . import queries as q

# The spec version this build writes and understands. A stored spec carrying a
# LOWER version is migrated on read (`_migrate`); a HIGHER one is refused.
SPEC_VERSION = 1

# How many series one widget may draw / how many rows one aggregate may return.
# A widget asking for 500 series is a bug and should fail at the edge rather than
# become a slow query. Series is the tighter cap: it is per-bucket data.
MAX_SERIES = q.MAX_SERIES_POINTS  # 24
MAX_ROWS = 100

# Widest window a widget may ask for, matching the /bi/series ceiling.
MAX_HOURS = 24 * 90


class Window(BaseModel):
    """The time range, expressed RELATIVELY by default.

    `last_hours` is the normal form and the reason a saved dashboard stays useful:
    it means "the last six hours", resolved at render time, not a window frozen on
    the afternoon somebody built the widget. Absolute `start`/`end` exist for a
    widget deliberately pinned to an incident.
    """

    model_config = ConfigDict(extra="forbid")

    last_hours: int | None = Field(default=6, ge=1, le=MAX_HOURS)
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


class Scope(BaseModel):
    """WHAT the widget is about — the no-code half of "no-code".

    Four ways to name a set of points, in narrowing order: an explicit list, one
    device, one category, or the whole estate. `category=""` is meaningful and
    selects the points nothing has classified, exactly as `/bi/devices` reads it.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["points", "device", "category", "all"] = "points"
    point_ids: list[uuid.UUID] = Field(default_factory=list)
    device_id: uuid.UUID | None = None
    device_tag: str | None = None
    # "" selects the UNCLASSIFIED points; None means "no category filter".
    category: str | None = None

    def validate_for(self) -> None:
        if self.type == "points" and not self.point_ids:
            raise ValidationError("scope.type=points requires at least one point_id")
        if self.type == "device" and self.device_id is None and not self.device_tag:
            raise ValidationError("scope.type=device requires device_id or device_tag")
        if self.type == "category" and self.category is None:
            raise ValidationError("scope.type=category requires a category")


class WidgetQuery(BaseModel):
    """The executable half of the spec. Everything here reaches the database."""

    model_config = ConfigDict(extra="forbid")

    # The RESULT SHAPE, not the chart type. See the module docstring, rule 2.
    #   series    → buckets over time, one row per point (line, bar-over-time)
    #   aggregate → one value per group over the whole window (stat, bar, table)
    kind: Literal["series", "aggregate"] = "series"

    scope: Scope = Field(default_factory=Scope)

    # Which number. `count` is SAMPLES — the one quantity that is meaningful
    # across differently-measured points, which is why it is the only metric
    # `group_by` may widen past a single point.
    metric: Literal["avg", "min", "max", "last", "first", "count"] = "avg"

    # Which store answers. "auto" picks 1m up to three hours and 1h beyond,
    # exactly as /bi/series does, and reports which it used.
    rollup: Literal["auto", "1m", "1h", "raw"] = "auto"

    window: Window = Field(default_factory=Window)

    # `aggregate` only. point = one row per point; device / category roll up and
    # are restricted to metric="count" (see the module docstring).
    group_by: Literal["point", "device", "category"] = "point"

    limit: int = Field(default=12, ge=1, le=MAX_ROWS)

    def validated(self) -> "WidgetQuery":
        self.scope.validate_for()

        if self.kind == "series":
            if self.group_by != "point":
                raise ValidationError("a series widget always groups by point")
            if self.limit > MAX_SERIES:
                raise ValidationError(f"a series widget draws at most {MAX_SERIES} points")
            if len(self.scope.point_ids) > MAX_SERIES:
                raise ValidationError(f"a series widget draws at most {MAX_SERIES} points")

        if self.group_by in ("device", "category") and self.metric != "count":
            # The rule that keeps a bar chart from averaging a power factor with a
            # voltage. See the module docstring.
            raise ValidationError(
                f"metric '{self.metric}' cannot be grouped by {self.group_by}: values "
                "from different points are not comparable (no unit is on the wire). "
                "Use group_by=point, or metric=count to compare sample volume."
            )

        start, end = self.window.resolve()
        if self.rollup == "raw":
            span_min = (end - start).total_seconds() / 60.0
            if span_min > q.RAW_MAX_MINUTES:
                raise ValidationError(
                    f"raw readings are limited to {q.RAW_MAX_MINUTES} minutes "
                    f"(asked for {int(span_min)}); use rollup=1m or 1h"
                )
        return self


class WidgetSpec(BaseModel):
    """A whole widget definition, as stored on a dashboard row.

    `viz` is a plain string BY DESIGN — see the module docstring, rule 1. The
    frontend that ships with this build draws `line`, `bar`, `stat` and `table`;
    a build that adds `gauge` stores `viz="gauge"` and this executor is unchanged.
    """

    model_config = ConfigDict(extra="forbid")

    spec_version: int = SPEC_VERSION
    viz: str = "line"
    query: WidgetQuery = Field(default_factory=WidgetQuery)
    # Presentation only. Never reaches the database, never validated here — a
    # newer frontend's option key must not make an older backend reject the spec.
    options: dict = Field(default_factory=dict)


def _migrate(raw: dict) -> dict:
    """Bring a stored spec up to `SPEC_VERSION`.

    A no-op today because v1 is the only version that has ever existed. It is
    here, and called on every read, so that the FIRST time a field changes the
    upgrade lands in one place instead of being scattered through the executor —
    which is how saved dashboards quietly stop rendering.
    """
    version = raw.get("spec_version", SPEC_VERSION)
    if not isinstance(version, int):
        raise ValidationError("spec_version must be an integer")
    if version > SPEC_VERSION:
        raise ValidationError(
            f"this widget was saved by a newer version of the module "
            f"(spec_version {version}; this build understands {SPEC_VERSION})"
        )
    # v0 → v1 etc. would be applied here, in order.
    raw = dict(raw)
    raw["spec_version"] = SPEC_VERSION
    return raw


def _pydantic_message(exc: PydanticValidationError) -> str:
    """Turn pydantic's error list into one line naming the offending field.

    Without this the exception escapes as a 500: pydantic's ValidationError is
    only translated automatically when FastAPI itself validated the body, and
    this spec is parsed by hand (the route takes a raw dict so `_migrate` can run
    before validation). A widget editor needs to be told WHICH field it got
    wrong — "an unexpected error occurred" is unactionable.
    """
    parts = []
    for e in exc.errors()[:3]:
        loc = ".".join(str(x) for x in e.get("loc", ()) if x != "__root__")
        parts.append(f"{loc or 'spec'}: {e.get('msg', 'invalid')}")
    return "invalid widget spec — " + "; ".join(parts)


def parse(raw: dict) -> WidgetSpec:
    """Validate + migrate a stored or submitted spec. The ONE entry point."""
    if not isinstance(raw, dict):
        raise ValidationError("spec must be an object")
    try:
        spec = WidgetSpec.model_validate(_migrate(raw))
    except PydanticValidationError as exc:
        raise ValidationError(_pydantic_message(exc)) from exc
    spec.query = spec.query.validated()
    return spec


# ── Result shapes ────────────────────────────────────────────────────────────
#
# Two shapes, deliberately. Every widget type this module has (or gains) renders
# one of them, which is what decouples "new chart" from "backend change".


class ResultBucket(BaseModel):
    t: dt.datetime
    count: int
    min: float | None = None
    max: float | None = None
    avg: float | None = None
    first: float | None = None
    last: float | None = None
    txt_last: str | None = None


class ResultSeries(BaseModel):
    point_id: uuid.UUID
    point_tag: str | None
    device_tag: str | None
    # As STORED. NULL on this deployment and that is correct — never substituted.
    unit: str | None
    buckets: list[ResultBucket]


class ResultRow(BaseModel):
    """One aggregate row: a stat's number, a bar, a table line."""

    key: str
    label: str
    sublabel: str | None = None
    value: float | None = None
    # Samples behind `value` — how much the number is standing on. A stat tile
    # showing an average over three samples should be able to say so.
    samples: int = 0
    unit: str | None = None


class QueryResult(BaseModel):
    shape: Literal["series", "aggregate"]
    # Echoed so the renderer knows which bucket field to draw without re-parsing
    # the spec it just sent.
    metric: str
    resolution: str
    # One line of plain English the widget prints, so a chart never implies a
    # precision it does not have.
    resolution_reason: str
    start: dt.datetime
    end: dt.datetime
    # Exactly one of these is populated, per `shape`.
    series: list[ResultSeries] = Field(default_factory=list)
    rows: list[ResultRow] = Field(default_factory=list)
    # True when the scope matched more points than `limit` allowed — the widget
    # says "showing 12 of 37" instead of silently presenting a partial answer as
    # the whole one.
    truncated: bool = False
    matched: int = 0
