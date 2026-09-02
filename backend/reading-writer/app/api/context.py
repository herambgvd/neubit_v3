"""DASHBOARD CONTEXT — global filters, variables and a shared window, resolved
into builder STATE before a single character of SQL exists.

This is the adaptation that matters most in the port, so it is worth being blunt
about what was left behind.

WHAT THE REFERENCE DOES
-----------------------
The standalone product implements dashboard filters and variables by
STRING-SUBSTITUTING `{{name}}` into the stored SQL text
(`lib/dashboard/variables.ts::renderQueryWithVariables`,
`use-global-filters.ts`). The value is single-quote-escaped on the way in
(`quoteVariableValue`) unless the variable is marked `raw: true`, in which case it
is spliced in verbatim — which is how a variable becomes a column name, a table
name or an `OR 1=1`. Even the non-raw path is only as safe as its quoting, and it
is quoting because there is nowhere else to put a value: the query is a string by
the time the variable meets it.

WHAT WE DO INSTEAD
------------------
Nothing here produces SQL. A dashboard filter, a variable and a shared time
window are all **builder state**, and this module's entire job is to merge that
state into a widget's `BuilderQuery` — after which the ordinary generator
(`sqlgen.py`) turns the merged state into a statement with every value BOUND as a
parameter.

Concretely, and these are the properties to check rather than trust:

* A context filter names a `column` that is a **dimension KEY**. It is resolved
  through `Definition.dimension()`, so a key the registry does not publish is a
  400 — it never reaches an identifier position, because the identifier that is
  eventually quoted is the registry's own `dim.column`, not the caller's string.
* A context filter's **value** becomes `Filter.value` / `Filter.values`, which
  `sqlgen._predicate` passes to `_Binds.add()`. A value containing a quote, a
  semicolon or a whole statement is a bind parameter; it is compared against a
  column and matches nothing. There is no code path from a context value to the
  SQL string. (`Generated.preview()` inlines binds for the builder's read-only
  echo — that string is displayed, never executed.)
* A **variable** is referenced by NAME (`Filter.variable`), and the name is
  matched against the context's variable map in Python. The name is never
  written anywhere near SQL; what it resolves to is a value, on the bound path
  above. A widget naming a variable the dashboard does not define is an error
  saying so, not a query that silently matches everything.

WIDGETS OPT OUT
---------------
`BuilderQuery.ignore_filters` (by id), `ignore_all_filters` and `ignore_window`
live in the widget's stored state, because "this tile deliberately shows the
whole estate while the rest of the page is scoped to one site" is a property of
the widget, not of the session. A widget that opts out says so on its own face —
see the frontend's filter-bar chip.

CROSS-DATASET DASHBOARDS
------------------------
One dashboard can carry widgets over several datasets. A global filter is applied
to a widget only when the widget's dataset actually publishes that dimension;
otherwise it is skipped. Skipping is reported (`ContextReport.skipped`) rather
than being silent, because "this filter did not apply here" is exactly the kind
of thing a person must be told rather than left to infer from an unchanged chart.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from kernel.errors import ValidationError
from pydantic import BaseModel, ConfigDict, Field

from .builder import MAX_HOURS, BuilderSpec, Filter, FilterOp, Window
from .registry import Dataset

# A variable NAME. It is never emitted into SQL — it is a dict key looked up in
# Python — but a name is still checked, because a "variable" called `1; drop` is a
# sign the caller has misunderstood what this is, and failing loudly at the edge
# is cheaper than a widget that silently never resolves.
VAR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

MAX_CONTEXT_FILTERS = 20
MAX_VARIABLES = 30
# Ceiling on the MERGED filter list, matching `BuilderQuery.filters`' own
# max_length. Pydantic validates a model on construction, not on mutation, so
# appending past the limit would otherwise slip through unchecked.
MAX_MERGED_FILTERS = 20


class ContextFilter(BaseModel):
    """One dashboard filter's CURRENT value.

    It is deliberately the same shape as a widget's own `Filter` plus an `id`:
    a global filter is not a different mechanism from a widget filter, it is the
    same predicate contributed by the page instead of by the tile. That is what
    makes "prove it is bound" a single claim about `sqlgen._predicate` rather
    than two.
    """

    model_config = ConfigDict(extra="forbid")

    # Matches the id of the filter's definition on the dashboard, and is what a
    # widget names to opt out. Never used in SQL.
    id: str = Field(min_length=1, max_length=64)
    # A dimension KEY from the dataset registry. Resolved through the registry;
    # a key that is not published is a 400.
    column: str = Field(min_length=1, max_length=128)
    op: FilterOp = "in"
    value: str | float | int | bool | None = None
    value2: str | float | int | bool | None = None
    values: list[str | float | int | bool] = Field(default_factory=list, max_length=200)

    def as_filter(self) -> Filter:
        return Filter(
            column=self.column,
            op=self.op,
            value=self.value,
            value2=self.value2,
            values=list(self.values),
        )


class VariableValue(BaseModel):
    """A dashboard variable's current value.

    A variable is a NAMED VALUE, and that is the whole of it. It is not a
    fragment of a query, it cannot carry an operator, and there is no `raw` flag —
    the reference has one because its variables are spliced into SQL text and
    somebody eventually needs a column name in there; ours never touch SQL, so
    the escape hatch has nothing to escape from.
    """

    model_config = ConfigDict(extra="forbid")

    # Single value, or a list for a multi-select. Both end up bound.
    value: str | float | int | bool | None = None
    values: list[str | float | int | bool] = Field(default_factory=list, max_length=200)

    def empty(self) -> bool:
        if self.values:
            return False
        if self.value is None:
            return True
        return isinstance(self.value, str) and not self.value.strip()


class QueryContext(BaseModel):
    """What the DASHBOARD contributes to every widget it holds."""

    model_config = ConfigDict(extra="forbid")

    filters: list[ContextFilter] = Field(default_factory=list, max_length=MAX_CONTEXT_FILTERS)
    variables: dict[str, VariableValue] = Field(default_factory=dict)
    # A window the whole page shares. Overrides the widget's own unless the
    # widget opted out — "show me yesterday" has to mean yesterday everywhere or
    # it means nothing.
    window: Window | None = None

    def model_post_init(self, _ctx: Any) -> None:
        if len(self.variables) > MAX_VARIABLES:
            raise ValueError(f"a dashboard defines at most {MAX_VARIABLES} variables")
        for name in self.variables:
            if not VAR_NAME_RE.match(name):
                raise ValueError(
                    f"{name!r} is not a usable variable name — letters, digits and "
                    "underscores, not starting with a digit"
                )


class ContextNote(BaseModel):
    """One thing the merge did or declined to do, in words a person can act on."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["applied", "skipped", "opted_out", "window"]
    filter_id: str = ""
    column: str = ""
    reason: str = ""


def _pin_note(cf: ContextFilter, reason: str, kind: str) -> ContextNote:
    return ContextNote(kind=kind, filter_id=cf.id, column=cf.column, reason=reason)  # type: ignore[arg-type]


def resolve(spec: BuilderSpec, ctx: QueryContext | None, ds: Dataset) -> list[ContextNote]:
    """Merge a dashboard context INTO a widget's builder state, in place.

    Returns the notes describing what happened. Runs BEFORE
    `BuilderQuery.validated()`, so everything it contributes is validated by the
    same rules as everything the widget author wrote — including the honesty
    rules: a global filter that pins an incomparable measure to one series makes
    an otherwise-refused widget legal, and one that does not, does not.
    """
    q = spec.query
    notes: list[ContextNote] = []
    d = ds.definition
    known = {dim.key for dim in d.dimensions}
    variables = ctx.variables if ctx else {}

    # ── 1. resolve the widget's OWN variable-bound filters ───────────────────
    #
    # This runs even with no context at all, so a widget referencing a variable
    # nobody supplied fails LOUDLY rather than quietly dropping its predicate and
    # charting the whole estate under a title that says one site.
    kept: list[Filter] = []
    for f in q.filters:
        if not f.variable:
            kept.append(f)
            continue
        name = f.variable
        var = variables.get(name)
        if var is None:
            raise ValidationError(
                f"this widget filters by the variable '{name}', which this "
                f"dashboard does not define. Add it in Variables, or remove the filter."
            )
        if var.empty():
            # An empty variable means "no constraint". The predicate is DROPPED
            # ENTIRELY — this is the reference's `{{#name}}…{{/name}}` conditional
            # block without the template language, and dropping it is the only
            # correct reading: turning it into `= ''` or `IS NOT NULL` would
            # quietly change which rows the widget counts.
            notes.append(
                ContextNote(
                    kind="skipped",
                    column=f.column,
                    reason=f"the variable '{name}' is empty, so this widget's "
                    f"filter on it was not applied",
                )
            )
            continue
        if var.values:
            f.op = "in"
            f.values = list(var.values)
            f.value = None
        else:
            f.values = []
            f.value = var.value
        f.variable = None
        kept.append(f)
        notes.append(
            ContextNote(kind="applied", column=f.column, reason=f"variable '{name}'")
        )
    q.filters = kept

    # ── 2. the page's global filters ─────────────────────────────────────────
    for cf in ctx.filters if ctx else []:
        if q.ignore_all_filters:
            notes.append(_pin_note(cf, "this widget ignores dashboard filters", "opted_out"))
            continue
        if cf.id in q.ignore_filters:
            notes.append(_pin_note(cf, "this widget ignores this filter", "opted_out"))
            continue
        if cf.column not in known:
            # A dashboard can span datasets. A filter on `door_name` means nothing
            # to an IoT readings widget, and applying it by force would either
            # error or silently match nothing.
            notes.append(
                _pin_note(cf, f"'{ds.name}' has no '{cf.column}' to filter on", "skipped")
            )
            continue
        f = cf.as_filter()
        if not f.complete():
            notes.append(_pin_note(cf, "no value chosen", "skipped"))
            continue
        if len(q.filters) >= MAX_MERGED_FILTERS:
            raise ValidationError(
                f"a widget can carry at most {MAX_MERGED_FILTERS} conditions; this "
                "dashboard's filters plus the widget's own exceed that"
            )
        q.filters.append(f)
        notes.append(_pin_note(cf, "applied", "applied"))

    # A global filter contributed with the widget's combinator set to OR would
    # WIDEN the result rather than narrowing it — "site = A" OR-ed onto a widget's
    # own conditions selects more rows, not fewer, which is the opposite of what
    # every person means by picking a site. Refuse rather than silently mislead.
    if ctx and ctx.filters and q.filter_combinator == "OR" and any(
        n.kind == "applied" and n.filter_id for n in notes
    ):
        raise ValidationError(
            "this widget combines its own conditions with OR, so a dashboard "
            "filter would widen it rather than narrow it. Switch the widget to "
            "AND, or opt it out of dashboard filters."
        )

    # ── 3. the shared window ─────────────────────────────────────────────────
    if ctx and ctx.window is not None:
        if q.ignore_window:
            notes.append(
                ContextNote(kind="opted_out", reason="this widget keeps its own window")
            )
        else:
            hours = ctx.window.last_hours
            if hours is not None and hours > MAX_HOURS:
                raise ValidationError(f"the window is limited to {MAX_HOURS} hours")
            q.window = ctx.window
            notes.append(ContextNote(kind="window", reason="the dashboard's window"))

    return notes
