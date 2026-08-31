"""Run a widget's BUILDER STATE against a registered dataset.

One executor, for every dataset and for every spec version. A v1 (IoT-shaped)
spec is translated by `builder.migrate_v1` and lands here too — there is no
parallel v1 path, because two executors is two places the honesty rules have to
be kept true and one of them will drift.

Order of operations, and why it is this order:

1. **Resolve the DATASET first**, and check the caller holds its permission. A
   dataset the caller may not read never reaches a SELECT.
2. **Choose the store.** `resolution=auto` runs the dataset's own rules; an
   explicit choice is honoured or REFUSED (never silently widened) when the
   window is outside what that store bounds. The reason travels with the result.
3. **Discover the series** for a split chart, before reading any measure. This
   doubles as the tenant check — the discovery query is tenant-filtered, so a
   series belonging to somebody else never comes back — and it bounds the cost of
   the chart query that follows. It is the generalisation of v1's "resolve the
   scope to points FIRST", and skipping it as "just labels" is how cross-tenant
   leaks happen.
4. **Read**, then widen a split result into one column per series in Python.

CONTRACT §4, WHERE EACH RULE LIVES NOW
--------------------------------------
* *Never invent a unit* — nothing in this file writes a unit. A dataset may name
  a unit COLUMN; it can never assert a unit string.
* *No aggregating incomparable series* — `BuilderQuery._check_comparability`.
* *No silent downgrade* — `BuilderQuery.validated` refuses a bounded store over a
  wide window and names the one to use.
* *Every result carries its resolution and reason* — `TableResult` below, always
  populated, including on an empty result.
* *Absence is absence* — nothing here coalesces a missing measure to zero. A
  bucket a series has no row for stays `None`, and a group with no row in a
  COMPARISON period stays `None` too, with a NULL delta rather than a −100%.

PERIOD-OVER-PERIOD
------------------
`query.compare` runs the identical state over an earlier, equal-length window
through the SAME `_run_once`, pins the split chart to the primary window's series
so the columns cannot drift, and aligns the two results on the server —
`_row_key` / `_align`. The client is not given two loose tables to zip together:
a group present in one period and not the other is precisely where a naive
position-by-position pairing starts subtracting two different things and calling
the result a change.
"""

from __future__ import annotations

import datetime as dt
import decimal
import uuid as _uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import sqlgen
from .builder import BuilderQuery, BuilderSpec
from .registry import Dataset
from .spec import ComparisonResult, TableResult


def _reason(rel, explicit: bool) -> str:
    base = rel.reason or (
        f"{rel.relation} at {rel.grain_sec}s buckets" if rel.grain_sec else rel.relation
    )
    return base if explicit else f"{base} (chosen automatically for this window)"


def _uniq(names: list[str]) -> list[str]:
    """Column names a renderer can key on. A dataset can legitimately have two
    series with the same label (two points named `Current` on two devices), and a
    chart with two identically-named columns is a chart that has lost one."""
    seen: dict[str, int] = {}
    out = []
    for n in names:
        if n in seen:
            seen[n] += 1
            out.append(f"{n} ({seen[n]})")
        else:
            seen[n] = 1
            out.append(n)
    return out


def cell(v: Any) -> Any:
    """One result cell, in a JSON type a chart can actually plot.

    Postgres hands back `Decimal` for `sum()` over a bigint and `UUID` for an id
    column; pydantic serialises both as STRINGS, and a string is not a number a
    chart can add up — a sample count would silently stop being a bar. So they are
    narrowed here, once, for every dataset.

    NULL stays NULL. It is never coerced to 0: "no sample in this bucket" and "the
    reading was zero" are different facts (contract §4).
    """
    if v is None or isinstance(v, (int, float, str, bool)):
        return v
    if isinstance(v, decimal.Decimal):
        f = float(v)
        return int(f) if f.is_integer() else f
    if isinstance(v, _uuid.UUID):
        return str(v)
    return v


async def _rows(db: AsyncSession, gen: sqlgen.Generated) -> list[dict]:
    res = await db.execute(text(gen.sql), gen.params)
    return [dict(r) for r in res.mappings().all()]


class _Pass:
    """One execution of a widget's state over ONE window.

    Both the primary window and a comparison window run through this, so the two
    can never diverge: the same generator, the same series keys, the same widening
    and the same NULL semantics. A comparison produced by a second, slightly
    different code path is exactly how a "vs last week" figure ends up comparing
    two different questions.
    """

    def __init__(
        self,
        columns: list[str],
        rows: list[list[Any]],
        matched: int,
        truncated: bool,
        band: list[list[float | None]] | None,
        sql: str,
        series_keys: list[Any] | None,
    ) -> None:
        self.columns = columns
        self.rows = rows
        self.matched = matched
        self.truncated = truncated
        self.band = band
        self.sql = sql
        self.series_keys = series_keys


async def _run_once(
    db: AsyncSession,
    tenant: str | None,
    ds: Dataset,
    q: BuilderQuery,
    *,
    rel,
    start: dt.datetime,
    end: dt.datetime,
    series_keys: list[Any] | None = None,
) -> _Pass:
    """Execute the state over one window and return the table it produces.

    `series_keys` pins a split chart to a series set decided elsewhere. The
    comparison pass ALWAYS passes the primary window's keys: the widget asked
    about these series, and discovering the previous window's own top-N would
    silently answer a different question — the columns would not line up, and the
    ones that did would be the wrong pairs.
    """
    d = ds.definition

    if q.time_series and q.series_by:
        keys = series_keys
        matched = len(keys) if keys is not None else 0
        labels: list[str] = []
        disc_sql = ""
        if keys is None:
            disc = sqlgen.discover_series(ds, q, rel=rel, start=start, end=end, tenant=tenant)
            found = await _rows(db, disc)
            disc_sql = disc.preview()
            matched = int(found[0][sqlgen.COL_TOTAL]) if found else 0
            if not found:
                return _Pass(["time"], [], 0, False, None, disc_sql, [])
            keys = [r[sqlgen.COL_SERIES] for r in found]
            labels = [
                (str(r.get(sqlgen.COL_SERIES_LABEL) or "").strip() or str(r[sqlgen.COL_SERIES]))
                for r in found
            ]
        if not keys:
            return _Pass(["time"], [], 0, False, None, disc_sql, [])

        gen = sqlgen.build(ds, q, rel=rel, start=start, end=end, tenant=tenant, series_keys=keys)
        data = await _rows(db, gen)

        value_col = next(i.out_name for i in q.select if i.measure)
        col_of = {k: i + 1 for i, k in enumerate(keys)}
        by_t: dict[dt.datetime, list] = {}
        band_by_t: dict[dt.datetime, tuple] = {}
        for r in data:
            t = r[sqlgen.COL_TIME]
            row = by_t.get(t)
            if row is None:
                # NULL, not 0 — a series with no sample in this bucket did not
                # measure zero, and ECharts draws the gap because `connectNulls`
                # is off.
                row = [t] + [None] * len(keys)
                by_t[t] = row
            idx = col_of.get(r[sqlgen.COL_SERIES])
            if idx is not None:
                row[idx] = cell(r.get(value_col))
            if q.band and len(keys) == 1:
                band_by_t[t] = (cell(r.get(sqlgen.COL_BAND_LO)), cell(r.get(sqlgen.COL_BAND_HI)))

        stamps = sorted(by_t)
        rows = [by_t[t] for t in stamps]
        band = [list(band_by_t.get(t, (None, None))) for t in stamps] if band_by_t else None
        columns = _uniq(["time"] + labels) if labels else ["time"] + [str(k) for k in keys]
        return _Pass(columns, rows, matched, matched > len(keys), band, gen.preview(), list(keys))

    # ── everything else: the generated SELECT is already the table ───────────
    gen = sqlgen.build(ds, q, rel=rel, start=start, end=end, tenant=tenant)
    data = await _rows(db, gen)

    names = ([sqlgen.COL_TIME] if q.time_series else []) + [i.out_name for i in q.select]
    display = (["time"] if q.time_series else []) + [
        (i.alias or (d.measure(i.measure).label if i.measure else d.dimension(i.dimension).label))
        for i in q.select
    ]
    rows = [[cell(r.get(n)) for n in names] for r in data]
    matched = int(data[0][sqlgen.COL_TOTAL]) if data and sqlgen.COL_TOTAL in data[0] else len(data)
    return _Pass(_uniq(display), rows, matched, matched > len(rows), None, gen.preview(), None)


# ── aligning a comparison to the primary result ──────────────────────────────


def _row_key(q: BuilderQuery, row: list[Any], *, start: dt.datetime, grain_sec: int) -> Any:
    """What makes two rows — one from each period — the same THING.

    * **A time bucket** keys on its ORDINAL POSITION IN ITS OWN WINDOW, not on its
      timestamp: `round((t - window_start) / grain)`. That is what makes "the
      third hour of the period" line up across the two windows even when the
      offset is not a whole number of buckets, and it is stable because both sides
      measure from their own start.
      Over a raw relation (`grain_sec == 0`) there are no buckets, so the key is
      the timestamp itself — two raw samples align only if they landed at the same
      instant, which is the honest answer for a store with no grain.
    * **A group** keys on its dimension cells, in output order. A group that only
      one period has simply does not match, which is the whole point.
    * **A single ungrouped row** keys on the empty tuple, so the one row on each
      side pairs up.
    """
    if q.time_series:
        t = row[0]
        if not isinstance(t, dt.datetime) or grain_sec <= 0:
            return ("t", t)
        return ("i", round((t - start).total_seconds() / grain_sec))
    # Not a time series: the row IS the select list, in order, so a dimension's
    # output index is its index in `select`.
    dims = [i for i, item in enumerate(q.select) if item.dimension is not None]
    return ("g", tuple(row[i] for i in dims if i < len(row)))


def _delta(current: Any, previous: Any) -> float | None:
    """Fractional change, or NULL when the question has no answer.

    Three NULL cases, and each is a §4 rule rather than a defensive check:
      * either side missing — there is nothing to compare, and "−100%" would be a
        claim that something fell to zero rather than that it was never there;
      * a previous value of exactly zero — the change is undefined, and both
        "+100%" and "+∞%" are inventions;
      * either side not a number (a dimension cell, a text reading) — a delta of
        two labels is not a quantity.
    """
    if not isinstance(current, (int, float)) or isinstance(current, bool):
        return None
    if not isinstance(previous, (int, float)) or isinstance(previous, bool):
        return None
    if previous == 0:
        return None
    return (current - previous) / abs(previous)


def _align(
    q: BuilderQuery,
    primary: _Pass,
    prior: _Pass,
    *,
    start: dt.datetime,
    prior_start: dt.datetime,
    grain_sec: int,
) -> tuple[list[list[Any]], list[list[float | None]], int]:
    """Pair the two periods' rows and compute the per-cell change.

    Returns rows aligned index-for-index with `primary.rows`, the delta matrix,
    and how many groups existed ONLY in the earlier period. Those are not appended
    as rows — the widget asked about this period — but their count is the
    difference between "nothing changed" and "four devices stopped reporting".
    """
    index: dict[Any, list[Any]] = {}
    for row in prior.rows:
        index.setdefault(_row_key(q, row, start=prior_start, grain_sec=grain_sec), row)

    width = len(primary.columns)
    used: set[Any] = set()
    out_rows: list[list[Any]] = []
    out_delta: list[list[float | None]] = []
    for row in primary.rows:
        key = _row_key(q, row, start=start, grain_sec=grain_sec)
        match = index.get(key)
        if match is not None:
            used.add(key)
            padded = list(match[:width]) + [None] * max(0, width - len(match))
        else:
            # Absence renders as absence. A group with no earlier row is NULL
            # across the board, never a row of zeros.
            padded = [None] * width
        out_rows.append(padded)
        out_delta.append([_delta(row[i] if i < len(row) else None, padded[i]) for i in range(width)])
    return out_rows, out_delta, len(index) - len(used)


async def run(db: AsyncSession, tenant: Any, ds: Dataset, spec: BuilderSpec) -> TableResult:
    q: BuilderQuery = spec.query
    d = ds.definition
    start, end = q.window.resolve()
    hours = (end - start).total_seconds() / 3600.0
    explicit = q.resolution != "auto"
    rel = d.choose_relation(hours) if not explicit else d.relation(q.resolution)
    tenant_s = str(tenant) if tenant else None

    primary = await _run_once(db, tenant_s, ds, q, rel=rel, start=start, end=end)

    comparison = None
    if q.compare is not None:
        # The SAME relation, deliberately, rather than re-running `choose_relation`
        # on the earlier window: the two periods are the same length, so auto
        # would pick the same store anyway — and pinning it means a comparison can
        # never be drawn at a different grain from the thing it is comparing.
        prior_start, prior_end = q.compare.shift(start, end)
        prior = await _run_once(
            db, tenant_s, ds, q,
            rel=rel, start=prior_start, end=prior_end,
            series_keys=primary.series_keys,
        )
        rows, deltas, only_prior = _align(
            q, primary, prior,
            start=start, prior_start=prior_start, grain_sec=rel.grain_sec,
        )
        comparison = ComparisonResult(
            period=q.compare.period,
            label=q.compare.label,
            start=prior_start,
            end=prior_end,
            rows=rows,
            delta_pct=deltas,
            # Nothing at all in the earlier window. A renderer says so instead of
            # drawing a flat line at zero and letting a reader take it for a
            # measurement.
            no_data=not prior.rows,
            only_previous=only_prior,
        )

    return TableResult(
        shape="table",
        dataset=ds.key,
        resolution=rel.key,
        resolution_reason=_reason(rel, explicit),
        start=start,
        end=end,
        columns=primary.columns,
        rows=primary.rows,
        label_index=0,
        matched=primary.matched,
        truncated=primary.truncated,
        band=primary.band,
        sql=primary.sql,
        comparison=comparison,
    )


async def distinct_values(
    db: AsyncSession,
    tenant: Any,
    ds: Dataset,
    *,
    column: str,
    search: str | None,
    hours: int,
    limit: int,
) -> dict:
    """The distinct values of one dimension over a recent window.

    For the builder's filter picker. Bounded by a window and a LIMIT so the cost
    does not grow with history, and generated through the same identifier
    allowlist as everything else — `column` is a dimension KEY that must exist in
    the registry, so a name that is not published is a 400 rather than a SELECT.

    A NULL value is reported as such rather than dropped: "the points nothing has
    classified" is a real question, and v1 answered it (`category=""`).
    """
    d = ds.definition
    dim = d.dimension(column)
    rel = d.choose_relation(hours)
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(hours=hours)

    b = sqlgen._Binds()
    expr = sqlgen._dim_sql(d, column)
    where = []
    if d.tenant_column:
        tcol = sqlgen.qual(sqlgen.BASE, d.tenant_column)
        tb = b.add(str(tenant) if tenant else None)
        where.append(f"(CAST({tb} AS uuid) IS NULL OR {tcol} = CAST({tb} AS uuid))")
    tcolumn = sqlgen.qual(sqlgen.BASE, rel.time_column)
    where.append(f"{tcolumn} >= {b.add(start)}")
    where.append(f"{tcolumn} < {b.add(end)}")
    if search:
        esc = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append(f"{expr}::text ILIKE {b.add('%' + esc + '%')} ESCAPE '\\'")

    joins = sqlgen._joins_sql(d, sqlgen._sources(d, [column]))
    sql = " ".join(
        [
            f"SELECT {expr} AS v, count(*) AS n",
            f"FROM {sqlgen.quote_ident(rel.relation)} AS {sqlgen.quote_ident(sqlgen.BASE)}",
            *joins,
            "WHERE " + " AND ".join(where),
            "GROUP BY 1",
            "ORDER BY n DESC, 1 ASC",
            f"LIMIT {int(limit)}",
        ]
    )
    rows = [dict(r) for r in (await db.execute(text(sql), b.params)).mappings().all()]
    return {
        "column": column,
        "label": dim.label,
        "resolution": rel.key,
        "items": [{"value": r["v"], "count": int(r["n"])} for r in rows],
    }
