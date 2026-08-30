"""The WIDGET SPEC — a structured, versioned description of what a widget shows.

This is the contract the dashboard builder writes and this service executes. It
is spec_version **2**: a widget names a DATASET from the registry
(`registry.py`) and picks dimensions, measures and aggregates out of it. v1 was
IoT-shaped (`scope: points | device | category | all`) and could not chart a
door-access event or a fire panel state; `builder.migrate_v1` brings a stored v1
spec forward on every read, so saved dashboards keep working (contract §6).

## Why a spec and not SQL

Unchanged from v1, and not reopened:

* This platform runs video surveillance and access control. Arbitrary SQL
  arriving from a browser is a far worse trade here than in a standalone BI tool,
  because the blast radius of a guard bug is the whole console.
* Free-SQL guards are genuinely hard. The reference implementation reviewed
  before this module was written had three real defects — a leading comment was
  rejected outright, a trailing comment broke the wrapper the guard appended, and
  validation truncated at the first `;` even when that `;` was inside a string
  literal or a comment. Each is a small mistake; together they are a bypass.
* It is not needed. The reference's OWN builder is not a SQL editor either — it
  is a pure generator over picker state. That generator is what was ported
  (`sqlgen.py`); the only thing left behind is the browser that ran it.

`extra="forbid"` on everything that reaches the database is the other half of
that trade: a body carrying `sql`, `where` or a typo'd field is a 400 naming the
field, not a silently-ignored key that makes the widget show the wrong number.

## Forward compatibility

1. **`viz` is not validated here.** The executor does not care how a result is
   drawn. Adding a chart type therefore needs NO backend change, and an old
   backend serving a new frontend keeps working.
2. **One result shape.** Every widget renders `{columns, rows}`. A new chart is a
   frontend change; it is not a spec version.
3. **`spec_version` is checked, and a spec from the FUTURE is refused loudly**
   rather than half-executed. A spec from the PAST is migrated by `_migrate`,
   which is the one place a past one is brought forward.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from kernel.errors import ValidationError
from pydantic import BaseModel, Field
from pydantic import ValidationError as PydanticValidationError

from .builder import BuilderSpec, migrate_v1

# The spec version this build writes and understands. A stored spec carrying a
# LOWER version is migrated on read (`_migrate`); a HIGHER one is refused.
SPEC_VERSION = 2


def _migrate(raw: dict) -> dict:
    """Bring a stored spec up to `SPEC_VERSION`. The ONE place that happens."""
    version = raw.get("spec_version", SPEC_VERSION)
    if not isinstance(version, int):
        raise ValidationError("spec_version must be an integer")
    if version > SPEC_VERSION:
        raise ValidationError(
            f"this widget was saved by a newer version of the module "
            f"(spec_version {version}; this build understands {SPEC_VERSION})"
        )
    if version <= 1:
        # v1 widgets are not kept alive by a second executor — they are
        # TRANSLATED and run through the one v2 path, so a fix to the generator
        # reaches widgets saved before the fix existed.
        raw = migrate_v1(raw)
    return dict(raw)


def _pydantic_message(exc: PydanticValidationError) -> str:
    """Turn pydantic's error list into one line naming the offending field.

    Without this the exception escapes as a 500: pydantic's ValidationError is
    only translated automatically when FastAPI itself validated the body, and this
    spec is parsed by hand (the route takes a raw dict so `_migrate` can run
    before validation). A widget editor needs to be told WHICH field it got wrong.
    """
    parts = []
    for e in exc.errors()[:3]:
        loc = ".".join(str(x) for x in e.get("loc", ()) if x != "__root__")
        parts.append(f"{loc or 'spec'}: {e.get('msg', 'invalid')}")
    return "invalid widget spec — " + "; ".join(parts)


def parse(raw: dict) -> BuilderSpec:
    """Validate + migrate a stored or submitted spec. The ONE entry point.

    Note what it does NOT do: validate against a dataset. That needs the registry
    (a database read), so it is `BuilderQuery.validated(dataset)`, called by the
    router once it has loaded the dataset and checked the caller may read it.
    """
    if not isinstance(raw, dict):
        raise ValidationError("spec must be an object")
    try:
        return BuilderSpec.model_validate(_migrate(raw))
    except PydanticValidationError as exc:
        raise ValidationError(_pydantic_message(exc)) from exc


# ── The result shape ─────────────────────────────────────────────────────────
#
# ONE shape, for every dataset and every chart: named columns and positional
# rows. It is the reference product's chart-data contract (`{columns, rows}`),
# which is what lets a chart type be added without touching the query layer — and
# it is why a dataset registered five minutes ago draws in charts written before
# it existed.


class TableResult(BaseModel):
    shape: Literal["table"] = "table"
    dataset: str
    # Display names, in output order. Deduplicated: two points legitimately named
    # "Current" must not collapse into one column.
    columns: list[str]
    # A cell is a number, a string, a timestamp or NULL. NULL IS NOT ZERO — "no
    # sample in this bucket" and "the reading was zero" are different facts and
    # every renderer draws them differently.
    rows: list[list[Any]] = Field(default_factory=list)
    # Which column is the x axis / row label. Named rather than assumed so a
    # future chart can say otherwise.
    label_index: int = 0

    # Which store answered, and one line of plain English about what that means
    # for freshness. Present on EVERY result including an empty one, so a chart
    # can never imply a precision it does not have.
    resolution: str
    resolution_reason: str
    start: dt.datetime
    end: dt.datetime

    # The scope matched more series/groups than the widget drew — "showing 8 of
    # 37" rather than presenting a partial answer as the whole one.
    matched: int = 0
    truncated: bool = False

    # The min→max envelope for a single series, aligned to `rows`, when the widget
    # asked for it. Measured, not inferred from the averages.
    band: list[list[float | None]] | None = None

    # The statement that ran, with its binds inlined — read-only, for the
    # builder's "show me the query" panel. It is an ECHO of what the server
    # generated; nothing anywhere accepts SQL back.
    sql: str = ""
