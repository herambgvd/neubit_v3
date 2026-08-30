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
  bucket a series has no row for stays `None`.
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
from .spec import TableResult


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


async def run(db: AsyncSession, tenant: Any, ds: Dataset, spec: BuilderSpec) -> TableResult:
    q: BuilderQuery = spec.query
    d = ds.definition
    start, end = q.window.resolve()
    hours = (end - start).total_seconds() / 3600.0
    explicit = q.resolution != "auto"
    rel = d.choose_relation(hours) if not explicit else d.relation(q.resolution)
    tenant_s = str(tenant) if tenant else None

    base = {
        "dataset": ds.key,
        "resolution": rel.key,
        "resolution_reason": _reason(rel, explicit),
        "start": start,
        "end": end,
    }

    # ── a split time-series: discover, then read, then widen ─────────────────
    if q.time_series and q.series_by:
        disc = sqlgen.discover_series(ds, q, rel=rel, start=start, end=end, tenant=tenant_s)
        found = await _rows(db, disc)
        matched = int(found[0][sqlgen.COL_TOTAL]) if found else 0
        if not found:
            return TableResult(
                shape="table", columns=["time"], rows=[], matched=0, truncated=False,
                sql=disc.preview(), **base,
            )
        keys = [r[sqlgen.COL_SERIES] for r in found]
        labels = [
            (str(r.get(sqlgen.COL_SERIES_LABEL) or "").strip() or str(r[sqlgen.COL_SERIES]))
            for r in found
        ]
        gen = sqlgen.build(
            ds, q, rel=rel, start=start, end=end, tenant=tenant_s, series_keys=keys
        )
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
        return TableResult(
            shape="table",
            columns=_uniq(["time"] + labels),
            rows=rows,
            label_index=0,
            matched=matched,
            truncated=matched > len(keys),
            band=band,
            sql=gen.preview(),
            **base,
        )

    # ── everything else: the generated SELECT is already the table ───────────
    gen = sqlgen.build(ds, q, rel=rel, start=start, end=end, tenant=tenant_s)
    data = await _rows(db, gen)

    names = ([sqlgen.COL_TIME] if q.time_series else []) + [i.out_name for i in q.select]
    display = (["time"] if q.time_series else []) + [
        (i.alias or (d.measure(i.measure).label if i.measure else d.dimension(i.dimension).label))
        for i in q.select
    ]
    rows = [[cell(r.get(n)) for n in names] for r in data]
    matched = int(data[0][sqlgen.COL_TOTAL]) if data and sqlgen.COL_TOTAL in data[0] else len(data)
    return TableResult(
        shape="table",
        columns=_uniq(display),
        rows=rows,
        label_index=0,
        matched=matched,
        truncated=matched > len(rows),
        sql=gen.preview(),
        **base,
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
