"""A scripted session for the evaluator's query seams. NOT a test module.

WHY THIS EXISTS. `metric_registry.evaluator` is two things bolted together: a
handful of SQL statements, and a large body of rules about what those rows are
allowed to mean. The rules are the part that decides whether an operator sees a
number or a refusal, and they need no database — every one of them is reached
with rows that have ALREADY been fetched.

So this fakes exactly one thing: `AsyncSession.execute`, returning rows a test
chose, matched to the statement by a fragment of the SQL the evaluator itself
wrote. Nothing else about Postgres is imitated — no engine, no dialect, no
TimescaleDB. A query the test did not script is an AssertionError naming it,
which is how "the evaluator asked for the benchmark before it had the
measurements" shows up as a failure instead of as silence.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid


def run(coro):
    """The house pattern (see test_metric_dataset.py): drive one coroutine."""
    return asyncio.run(coro)


UTC = dt.timezone.utc


def at(day: int, hour: int = 0) -> dt.datetime:
    return dt.datetime(2026, 3, day, hour, tzinfo=UTC)


def pid(n: int) -> str:
    return f"00000000-0000-0000-0000-0000000000{n:02d}"


def point(
    n: int,
    *,
    role: str,
    unit: str | None = "kWh",
    unit_source: str = "operator",
    tag: str | None = None,
    device_tag: str = "AHU-1",
) -> dict:
    """A row of `points ⋈ point_roles`, shaped as the evaluator selects it."""
    return {
        "point_id": pid(n),
        "point_tag": tag or f"p{n}",
        "device_id": uuid.UUID(pid(1)),
        "device_tag": device_tag,
        "unit": unit,
        "unit_source": unit_source,
        "role": role,
    }


def agg(
    n: int,
    *,
    avg: float | None = None,
    first: float | None = None,
    last: float | None = None,
    lo: float | None = None,
    hi: float | None = None,
    total: float | None = None,
    buckets: int = 10,
    samples: int = 10,
    first_bucket: dt.datetime | None = None,
    last_bucket: dt.datetime | None = None,
) -> dict:
    """A row of the evaluator's `_AGG_SQL`, every column it selects present."""
    return {
        "point_id": pid(n),
        "buckets": buckets,
        "samples": samples,
        "first_bucket": first_bucket or at(1),
        "last_bucket": last_bucket or at(11),
        "agg_avg": avg,
        "agg_min": lo if lo is not None else avg,
        "agg_max": hi if hi is not None else avg,
        "agg_sum": total,
        "agg_first": first,
        "agg_last": last,
    }


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


# The fragment that identifies each statement the evaluator issues. Matched
# against the rendered SQL, so a renamed query fails loudly here rather than
# quietly returning the wrong table's rows.
FRAGMENTS = {
    "device_roles": "p.device_id = CAST(:device AS uuid)",
    "site_roles": "p.site_id = CAST(:site AS uuid)",
    "devices": "SELECT DISTINCT p.device_id",
    "aggs": "AS agg_avg",
    "buckets": "SELECT point_id, bucket, num_avg",
    "union_buckets": "count(DISTINCT bucket)",
    "sites": "FROM site_facts f",
    "area": "SELECT gross_floor_area_sqm",
    "factor": "FROM site_emission_factors",
    "standard": "FROM benchmark_standards",
    "bench_config": "FROM benchmark_site_config",
}


class FakeDb:
    """Scripted rows per statement; anything unscripted is a loud failure."""

    def __init__(self, **script):
        unknown = set(script) - set(FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        self.script = script
        self.asked: list[str] = []

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name, frag in FRAGMENTS.items():
            if frag in sql:
                if name not in self.script:
                    raise AssertionError(
                        f"the evaluator ran the `{name}` query, which this test "
                        f"did not script — it should not have got that far"
                    )
                self.asked.append(name)
                rows = self.script[name]
                if name == "aggs":
                    want = set(params["pids"])
                    return _Result([r for r in rows if str(r["point_id"]) in want])
                return _Result(rows)
        raise AssertionError(f"unrecognised statement: {' '.join(sql.split())[:160]}")
