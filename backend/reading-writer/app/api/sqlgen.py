"""SERVER-SIDE SQL generation from builder state (contract §3).

PORTED from the standalone product's `frontend-next/src/lib/dashboard/query-builder.ts`.
What came across is the design, which is the good part and is what makes the
builder domain-agnostic:

* identifiers are checked against `^[A-Za-z_][A-Za-z0-9_]*$` and then
  double-quoted — never interpolated raw;
* a rejected identifier collapses the whole generation rather than being written
  into the string (there, a `""` return; here, a raised `ValidationError`, because
  a server has somebody to tell);
* only SELECT is ever emitted — there is no code path in this file that can
  produce another statement;
* the aggregate vocabulary (`count`, `count_distinct`, `sum`, `avg`, `min`,
  `max`) and the operator set (`=`…`between`, `is null`, `contains`) are theirs,
  extended with `first`/`last`, which this store can answer and theirs could not.

FOUR THINGS CHANGED, ALL DELIBERATE
-----------------------------------
1. **It runs on the server.** Theirs generates in the browser and posts SQL.
   This platform runs video surveillance and access control; an endpoint that
   accepts SQL from a browser must not exist here, so the client sends STATE and
   this module is the only thing that writes SQL.

2. **Identifiers come from the REGISTRY, not the client.** Theirs allowlists the
   SHAPE of a name the user typed, which still lets a user name any table in the
   datasource. Here a client names a dataset key, a dimension key and a measure
   key; the physical relation and column behind them come from the dataset
   definition. The regex is still applied — to the registry's own strings, on
   load and again here — but it is now the second line of defence rather than the
   first.

3. **Literals are BOUND, not escaped.** Theirs escapes single quotes into the
   string because it has nowhere else to put them. A server has bind parameters,
   which are strictly stronger, so `renderValue`'s escaping survives only in
   `preview_sql` — the human-readable echo shown in the builder — and never in
   what is executed.

4. **The pivot is done in Python.** A split-by-series chart needs one column per
   distinct series. Generating those columns dynamically would mean interpolating
   VALUES into an identifier position, which is the one thing this design exists
   to avoid. So the SQL returns (bucket, series, value) and `execute.py` widens it.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from kernel.errors import ValidationError

from . import registry as reg
from .builder import BuilderQuery, Filter, Having, SelectItem
from .registry import Dataset, Definition, Dimension, Measure, PhysicalAgg, Relation

# The base relation's alias. Fixed by this module, never client-supplied.
BASE = "t"

# Output aliases the generator reserves for itself.
COL_TIME = "__t"
COL_SERIES = "__s"
COL_SERIES_LABEL = "__sl"
COL_TOTAL = "__total"
COL_BAND_LO = "__band_lo"
COL_BAND_HI = "__band_hi"

_SQL_OP = {"=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">="}


class InvalidIdentifier(ValidationError):
    """A name that did not survive the allowlist. Collapses the generation."""


def quote_ident(name: str) -> str:
    """Validate then double-quote. The port of their `safeIdent` + `quoteIdent`."""
    if not isinstance(name, str) or not reg.IDENT_RE.match(name):
        raise InvalidIdentifier(f"{name!r} is not a usable SQL identifier")
    return '"' + name.replace('"', '""') + '"'


def qual(alias: str, column: str) -> str:
    return f"{quote_ident(alias)}.{quote_ident(column)}"


def quote_literal(value: Any) -> str:
    """Single-quote a literal for the SQL PREVIEW ONLY.

    Nothing executed goes through here — the executed statement binds every value.
    It exists because the builder shows the generated SQL read-only, and a preview
    full of `:p3` placeholders tells a person nothing about what will run.
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, dt.datetime):
        return "'" + value.isoformat() + "'"
    if isinstance(value, (list, tuple)):
        return "ARRAY[" + ", ".join(quote_literal(v) for v in value) + "]"
    return "'" + str(value).replace("'", "''") + "'"


class _Binds:
    """Sequentially-named bind parameters. One counter, so a name can never
    collide and a value can never end up in an identifier position."""

    def __init__(self) -> None:
        self.params: dict[str, Any] = {}
        self._n = 0

    def add(self, value: Any) -> str:
        self._n += 1
        name = f"p{self._n}"
        self.params[name] = value
        return f":{name}"


# ── column expressions ───────────────────────────────────────────────────────


def _dim_sql(d: Definition, key: str) -> str:
    dim = d.dimension(key)
    alias = BASE if dim.source == "base" else dim.source
    return qual(alias, dim.column)


def _phys_sql(
    d: Definition,
    agg: PhysicalAgg,
    time_col: str,
    b: "_Binds",
    outer_where=None,
) -> str:
    """One physical aggregate → SQL. The function name is a CLOSED vocabulary
    (`registry.PhysFn`), so nothing here concatenates a caller's or a registry
    row's SQL — only a name this file knows and a column it has quoted.

    A `where` becomes `FILTER (WHERE <dimension> = <bind>)`. The dimension is a
    registry KEY resolved through `Definition.dimension()` and the value is BOUND,
    so a filtered aggregate is exactly as safe as an unfiltered one. A composite
    (`ratio`, `difference`) passes its own filter DOWN to any child that has none,
    which is what lets a two-sided definition state its filter once.

    `difference` is how a DERIVED value is expressed — `avg(OWT) − avg(IWT)` is
    two filtered aggregates over the same relation, subtracted at query time.
    Nothing is written back to `readings`; NULL on either side propagates to NULL,
    which is the correct answer for a bucket where one side did not report and is
    contract §4 arriving for free.
    """
    where = agg.where or outer_where

    if agg.fn == "ratio":
        num = _phys_sql(d, agg.numerator, time_col, b, where)  # type: ignore[arg-type]
        den = _phys_sql(d, agg.denominator, time_col, b, where)  # type: ignore[arg-type]
        # nullif → a group with no denominator is NULL, not a division error and
        # emphatically not zero (contract §4: absence renders as absence).
        return f"({num}) / nullif(({den}), 0)::double precision"
    if agg.fn == "difference":
        left = _phys_sql(d, agg.left, time_col, b, where)    # type: ignore[arg-type]
        right = _phys_sql(d, agg.right, time_col, b, where)  # type: ignore[arg-type]
        # No coalesce on either side, deliberately. A bucket where only one of the
        # two series reported has no measured difference, and 0 would be a number
        # nobody measured.
        return f"(({left}) - ({right}))"

    if agg.fn == "count_star":
        base = "count(*)"
    else:
        col = qual(BASE, agg.column or "")
        if agg.fn == "count":
            base = f"count({col})"
        elif agg.fn == "count_distinct":
            base = f"count(DISTINCT {col})"
        elif agg.fn in ("first", "last"):
            # TimescaleDB's ordered aggregates, ordered by the RELATION's own time
            # column — so "last" means last in time, not last in scan order.
            base = f"{agg.fn}({col}, {qual(BASE, time_col)})"
        elif agg.fn in ("sum", "min", "max", "avg"):
            base = f"{agg.fn}({col})"
        else:
            raise InvalidIdentifier(f"unsupported aggregate function {agg.fn!r}")

    if where is not None:
        dim = d.dimension(where.dimension)
        lhs = _dim_sql(d, where.dimension)
        base = f"{base} FILTER (WHERE {lhs} = {_cast(dim, b.add(_coerce(dim, where.equals)))})"
    return base


def _measure_phys(d: Definition, rel: Relation, measure_key: str, aggregate: str) -> PhysicalAgg:
    m: Measure = d.measure(measure_key)
    if aggregate not in m.aggregates:
        raise ValidationError(f"'{aggregate}' is not available for '{m.label}'")
    phys = (m.physical.get(rel.key) or {}).get(aggregate)
    if phys is None:
        raise ValidationError(
            f"'{m.label}' cannot be computed as '{aggregate}' from the "
            f"'{rel.key}' store"
        )
    return phys


def _measure_sql(
    d: Definition, rel: Relation, measure_key: str, aggregate: str, b: "_Binds"
) -> str:
    return _phys_sql(d, _measure_phys(d, rel, measure_key, aggregate), rel.time_column, b)


def _measure_dims(d: Definition, rel: Relation, measure_key: str, aggregate: str) -> list[str]:
    """Which DIMENSIONS a measure's own filters reference.

    A filtered aggregate can name a dimension that lives on a JOIN — `point_tag`
    is on `points`, not on the rollup — so the join has to be planned for even
    though the widget never selected, grouped or filtered by it. Without this a
    derived measure generates SQL naming an alias that is not in the FROM clause.
    """
    try:
        phys = _measure_phys(d, rel, measure_key, aggregate)
    except ValidationError:
        return []
    return [n.where.dimension for n in phys.walk() if n.where]


def _select_sql(d: Definition, rel: Relation, item: SelectItem, b: "_Binds") -> str:
    if item.dimension:
        return _dim_sql(d, item.dimension)
    return _measure_sql(d, rel, item.measure or "", item.aggregate or "", b)


# ── predicates ───────────────────────────────────────────────────────────────

_CAST = {"uuid": "uuid", "number": "double precision", "bool": "boolean", "time": "timestamptz"}


def _coerce(dim: Dimension, value: Any) -> Any:
    if dim.type == "number":
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise ValidationError(f"'{dim.label}' needs a number, got {value!r}") from exc
    if dim.type == "bool":
        return str(value).strip().lower() in ("1", "true", "yes", "on")
    if dim.type == "uuid":
        v = str(value).strip()
        if not re.match(r"^[0-9a-fA-F-]{32,36}$", v):
            raise ValidationError(f"'{dim.label}' needs an id, got {value!r}")
        return v
    return str(value)


def _cast(dim: Dimension, bind: str) -> str:
    t = _CAST.get(dim.type)
    return f"CAST({bind} AS {t})" if t else bind


def _predicate(lhs: str, dim: Dimension, f: Filter, b: _Binds) -> str:
    """One WHERE predicate. The operator set is the reference's; every VALUE is a
    bind, so there is no path by which a caller's string becomes SQL."""
    if f.op == "is null":
        return f"{lhs} IS NULL"
    if f.op == "is not null":
        return f"{lhs} IS NOT NULL"
    if f.op == "in":
        vals = [_coerce(dim, v) for v in f.values]
        t = _CAST.get(dim.type, "text")
        return f"{lhs} = ANY(CAST({b.add(vals)} AS {t}[]))"
    if f.op == "between":
        lo = b.add(_coerce(dim, f.value))
        hi = b.add(_coerce(dim, f.value2))
        return f"{lhs} BETWEEN {_cast(dim, lo)} AND {_cast(dim, hi)}"
    if f.op == "contains":
        # LIKE wildcards in the user's value are escaped, so "contains" is
        # literal — theirs does the same, and it is the difference between
        # searching for "50%" and matching everything.
        raw = str(f.value)
        escaped = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return f"{lhs}::text ILIKE {b.add('%' + escaped + '%')} ESCAPE '\\'"
    if f.op == "like":
        return f"{lhs}::text LIKE {b.add(str(f.value))}"
    op = _SQL_OP[f.op]
    return f"{lhs} {op} {_cast(dim, b.add(_coerce(dim, f.value)))}"


def _having(d: Definition, rel: Relation, h: Having, b: _Binds) -> str:
    lhs = _measure_sql(d, rel, h.measure, h.aggregate, b)
    if h.op == "is null":
        return f"({lhs}) IS NULL"
    if h.op == "is not null":
        return f"({lhs}) IS NOT NULL"
    if h.op == "between":
        return f"({lhs}) BETWEEN {b.add(float(h.value))} AND {b.add(float(h.value2))}"
    if h.op in ("in", "contains", "like"):
        raise ValidationError(f"'{h.op}' is not a usable condition on an aggregate")
    return f"({lhs}) {_SQL_OP[h.op]} {b.add(float(h.value))}"


# ── the generator ────────────────────────────────────────────────────────────


class Generated:
    """A generated statement: SQL, its binds, and what its columns MEAN."""

    def __init__(self, sql: str, params: dict, columns: list[dict]) -> None:
        self.sql = sql
        self.params = params
        self.columns = columns

    def preview(self) -> str:
        """The statement with its binds inlined, for the builder's read-only echo.
        Longest name first so `:p10` is not clobbered by `:p1`."""
        out = self.sql
        for name in sorted(self.params, key=len, reverse=True):
            out = out.replace(f":{name}", quote_literal(self.params[name]))
        return " ".join(out.split())


def _joins_sql(d: Definition, needed: set[str]) -> list[str]:
    out = []
    for j in d.joins:
        if j.key not in needed:
            continue
        kw = "LEFT JOIN" if j.type == "left" else "INNER JOIN"
        on = " AND ".join(
            f"{qual(BASE, left)} = {qual(j.key, right)}" for left, right in j.on
        )
        out.append(f"{kw} {quote_ident(j.relation)} AS {quote_ident(j.key)} ON {on}")
    return out


def _sources(d: Definition, keys: list[str]) -> set[str]:
    """Which declared joins a set of dimension keys actually needs. A widget that
    charts nothing but the fact table pays for no join."""
    out: set[str] = set()
    for k in keys:
        src = d.dimension(k).source
        if src != "base":
            out.add(src)
    return out


class _Projection:
    """The SELECT list, what each column means to a reader, and how it groups.

    Built together because the three have to stay in step: a column a reader
    sees that the GROUP BY does not know about is a Postgres error, and a
    column the `columns` metadata misses is a chart that cannot label itself.
    """

    def __init__(self) -> None:
        self.select: list[str] = []
        self.columns: list[dict] = []
        self.group: list[str] = []

    def add(self, sql: str, alias: str, column: dict, *, grouped: bool) -> None:
        self.select.append(f"{sql} AS {quote_ident(alias)}")
        self.columns.append(column)
        if grouped:
            self.group.append(sql)

    def add_group(self, sql: str) -> None:
        if sql not in self.group:
            self.group.append(sql)


def _planned_dimensions(d: Definition, rel: Relation, q: BuilderQuery) -> list[str]:
    """Every dimension this query will reference, so the joins can be planned once.

    A DERIVED measure filters on a dimension the widget never named — `delta_t`
    picks the `OWT` and `IWT` point tags — and that dimension can live on a
    join. Plan for it, or the generated SQL references an alias that is not in
    the FROM clause.
    """
    dim_keys = [i.dimension for i in q.select if i.dimension]
    dim_keys += list(q.group_by)
    dim_keys += [f.column for f in q.filters]
    if q.series_by:
        dim_keys.append(q.series_by)
    if q.series_label:
        dim_keys.append(q.series_label)
    for item in q.select:
        if item.measure:
            dim_keys += _measure_dims(d, rel, item.measure, item.aggregate or "")
    for h in q.having:
        dim_keys += _measure_dims(d, rel, h.measure, h.aggregate)
    return dim_keys


def _select_column(d: Definition, item: Any, idx: int) -> dict:
    """What a selected item is called and what it is, for the reader of the chart."""
    return {
        "name": item.out_name,
        "role": "measure" if item.measure else "dimension",
        "label": (
            d.measure(item.measure).label if item.measure else d.dimension(item.dimension).label  # type: ignore[arg-type]
        ),
        "aggregate": item.aggregate,
        "index": idx,
    }


def _add_band_columns(
    p: _Projection, d: Definition, rel: Relation, q: BuilderQuery, b: "_Binds"
) -> None:
    """The min→max envelope, answered by the STORE rather than invented by the
    chart. Only ever for one measure on a split series (the model refuses the
    rest), so the extra columns cannot multiply."""
    if not q.band:
        return
    m_item = next(i for i in q.select if i.measure)
    m = d.measure(m_item.measure or "")
    if "min" in m.aggregates and "max" in m.aggregates:
        p.add(_measure_sql(d, rel, m.key, "min", b), COL_BAND_LO,
              {"name": COL_BAND_LO, "role": "band_lo"}, grouped=False)
        p.add(_measure_sql(d, rel, m.key, "max", b), COL_BAND_HI,
              {"name": COL_BAND_HI, "role": "band_hi"}, grouped=False)


def _projection(
    d: Definition, rel: Relation, q: BuilderQuery, time_col: str, b: "_Binds"
) -> _Projection:
    """Everything between SELECT and FROM, and the GROUP BY that goes with it."""
    p = _Projection()
    if q.time_series:
        p.add(time_col, COL_TIME, {"name": COL_TIME, "role": "time"}, grouped=True)
    if q.series_by:
        p.add(_dim_sql(d, q.series_by), COL_SERIES,
              {"name": COL_SERIES, "role": "series"}, grouped=True)
        if q.series_label:
            p.add(_dim_sql(d, q.series_label), COL_SERIES_LABEL,
                  {"name": COL_SERIES_LABEL, "role": "series_label"}, grouped=True)
    for idx, item in enumerate(q.select):
        p.add(_select_sql(d, rel, item, b), item.out_name,
              _select_column(d, item, idx), grouped=bool(item.dimension))
    _add_band_columns(p, d, rel, q, b)
    for key in q.group_by:
        p.add_group(_dim_sql(d, key))
    return p


def _where_clauses(
    d: Definition, q: BuilderQuery, b: "_Binds", *, time_col: str,
    start: dt.datetime, end: dt.datetime, tenant: str | None,
    series_keys: list[Any] | None,
) -> list[str]:
    """The window, the tenant, and whatever the widget asked for."""
    where: list[str] = []
    if d.tenant_column:
        # The tenant bind is here for the same reason it is on every other
        # statement in this service: it comes from the JWT, so a widget cannot
        # widen its own scope. NULL = a platform super-admin, no filter.
        tcol = qual(BASE, d.tenant_column)
        tbind = b.add(tenant)
        where.append(f"(CAST({tbind} AS uuid) IS NULL OR {tcol} = CAST({tbind} AS uuid))")
    where.append(f"{time_col} >= {b.add(start)}")
    where.append(f"{time_col} < {b.add(end)}")

    user_preds = []
    for f in q.filters:
        if not f.complete():
            continue
        dim = d.dimension(f.column)
        user_preds.append(_predicate(_dim_sql(d, f.column), dim, f, b))
    if user_preds:
        joiner = " OR " if q.filter_combinator == "OR" else " AND "
        where.append("(" + joiner.join(user_preds) + ")")

    if series_keys is not None and q.series_by:
        dim = d.dimension(q.series_by)
        t = _CAST.get(dim.type, "text")
        where.append(
            f"{_dim_sql(d, q.series_by)} = ANY(CAST({b.add(list(series_keys))} AS {t}[]))"
        )
    return where


def _order_by(q: BuilderQuery) -> list[str]:
    """What the user ordered by — behind the time key, which a chart cannot do
    without regardless of what was asked for."""
    order: list[str] = []
    for o in q.order_by:
        if o.select_index >= len(q.select):
            continue
        item = q.select[o.select_index]
        order.append(f"{quote_ident(item.out_name)} {'ASC' if o.dir == 'asc' else 'DESC'}")
    if q.time_series:
        return [f"{quote_ident(COL_TIME)} ASC"] + order
    return order


def build(
    ds: Dataset,
    q: BuilderQuery,
    *,
    rel: Relation,
    start: dt.datetime,
    end: dt.datetime,
    tenant: str | None,
    series_keys: list[Any] | None = None,
) -> Generated:
    """Builder state → ONE read-only SELECT.

    `series_keys` narrows a split time-series to the series that were discovered
    first (see `discover_series`), which is what keeps a chart's cost bounded when
    a dataset has three hundred of them.
    """
    d = ds.definition
    b = _Binds()

    joins = _joins_sql(d, _sources(d, [k for k in _planned_dimensions(d, rel, q) if k]))
    time_col = qual(BASE, rel.time_column)
    p = _projection(d, rel, q, time_col, b)
    where = _where_clauses(
        d, q, b, time_col=time_col, start=start, end=end, tenant=tenant,
        series_keys=series_keys,
    )

    # ── assemble ────────────────────────────────────────────────────────────
    parts = [f"SELECT {', '.join(p.select)}", f"FROM {quote_ident(_base_relation(rel))} AS {quote_ident(BASE)}"]
    parts += joins
    parts.append("WHERE " + " AND ".join(where))

    if p.group:
        # `count(*) OVER ()` after grouping counts the GROUPS, which is how a
        # widget can honestly say "showing 8 of 37" instead of presenting a
        # truncated answer as a complete one.
        parts[0] = parts[0] + f", count(*) OVER () AS {quote_ident(COL_TOTAL)}"
        parts.append("GROUP BY " + ", ".join(dict.fromkeys(p.group)))

    havings = [_having(d, rel, h, b) for h in q.having if h.complete()]
    if havings:
        if not p.group:
            raise ValidationError("a condition on an aggregate needs a grouping")
        parts.append("HAVING " + " AND ".join(havings))

    order = _order_by(q)
    if order:
        parts.append("ORDER BY " + ", ".join(order))

    # A split time-series is limited by SERIES (already narrowed by
    # `discover_series`), not by rows — the row cap is the bucket ceiling.
    row_limit = MAX_BUCKET_ROWS if (q.time_series and q.series_by) else q.limit
    parts.append(f"LIMIT {int(row_limit)}")

    return Generated(" ".join(parts), b.params, p.columns)


MAX_BUCKET_ROWS = 20000


def _base_relation(rel: Relation) -> str:
    return rel.relation


def discover_series(
    ds: Dataset,
    q: BuilderQuery,
    *,
    rel: Relation,
    start: dt.datetime,
    end: dt.datetime,
    tenant: str | None,
) -> Generated:
    """Which series a split chart will draw, and how many it COULD have drawn.

    Runs first, exactly as the v1 executor resolved a scope to points first: it
    doubles as the tenant check (a series belonging to another tenant never comes
    back) and it bounds the cost of the chart query that follows.

    Ranked by row volume so a chart draws the series that HAVE data rather than an
    alphabetical prefix of empty ones; ties break on the key so the same widget
    renders the same series every time.
    """
    d = ds.definition
    b = _Binds()
    key_sql = _dim_sql(d, q.series_by or "")
    sel = [f"{key_sql} AS {quote_ident(COL_SERIES)}"]
    group = [key_sql]
    if q.series_label:
        lab = _dim_sql(d, q.series_label)
        sel.append(f"{lab} AS {quote_ident(COL_SERIES_LABEL)}")
        group.append(lab)
    sel.append("count(*) AS n")
    sel.append(f"count(*) OVER () AS {quote_ident(COL_TOTAL)}")

    dim_keys = [f.column for f in q.filters] + [q.series_by or ""]
    if q.series_label:
        dim_keys.append(q.series_label)
    joins = _joins_sql(d, _sources(d, [k for k in dim_keys if k]))

    time_col = qual(BASE, rel.time_column)
    where = []
    if d.tenant_column:
        tcol = qual(BASE, d.tenant_column)
        tbind = b.add(tenant)
        where.append(f"(CAST({tbind} AS uuid) IS NULL OR {tcol} = CAST({tbind} AS uuid))")
    where.append(f"{time_col} >= {b.add(start)}")
    where.append(f"{time_col} < {b.add(end)}")
    preds = []
    for f in q.filters:
        if not f.complete():
            continue
        preds.append(_predicate(_dim_sql(d, f.column), d.dimension(f.column), f, b))
    if preds:
        joiner = " OR " if q.filter_combinator == "OR" else " AND "
        where.append("(" + joiner.join(preds) + ")")

    parts = [
        f"SELECT {', '.join(sel)}",
        f"FROM {quote_ident(rel.relation)} AS {quote_ident(BASE)}",
        *joins,
        "WHERE " + " AND ".join(where),
        "GROUP BY " + ", ".join(group),
        "ORDER BY n DESC, 1 ASC",
        f"LIMIT {int(q.limit)}",
    ]
    return Generated(" ".join(parts), b.params, [])
