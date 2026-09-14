"""What the executor does when the rows are not the shape it hoped for.

WHY THIS FILE EXISTS. `execute.py` turns the statement `sqlgen` built into the
table a chart draws. Everything it gets right is invisible and everything it
gets wrong is a plausible-looking chart:

  * a **missing column** — a renamed output, a dataset edited under a saved
    widget — must leave a hole, not raise and not shift the other cells left;
  * an **empty result** must still carry the resolution, the reason and the
    columns, because a renderer reads those to say "nothing here" rather than
    drawing an axis with no label;
  * a **NULL where a number belongs** must stay NULL. Contract §4: "no sample in
    this bucket" and "the reading was zero" are different facts, and the whole
    period-over-period feature is built on being able to tell them apart — a
    coalesced zero turns an absent group into a −100% change.

The database is scripted, the way `metric_fakes` scripts the evaluator's: rows a
test chose, matched to the statement by what the generator wrote, and a LOUD
failure on any query the test did not script. That is what makes "it discovered
the series again on the comparison pass" a test failure rather than a silent
extra round trip that quietly answers a different question.

WHAT IS NOT HERE. Nothing asserts what Postgres does with these statements —
that needs a live TimescaleDB (see `test_sqlgen_statement`'s note). These assert
the SHAPING, which is the half a pure test can hold.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import decimal
import importlib.util
import pathlib
import uuid

import pytest
import reporting.models

from app.api import execute as ex
from app.api import sqlgen
from app.api.builder import BuilderQuery, BuilderSpec
from app.api.registry import Dataset

UTC = dt.timezone.utc
START = dt.datetime(2026, 3, 2, tzinfo=UTC)
END = dt.datetime(2026, 3, 3, tzinfo=UTC)
TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")
P1 = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000001")
P2 = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000002")


def run(coro):
    """The house pattern (see `metric_fakes.run`): drive one coroutine."""
    return asyncio.run(coro)


def _seeded_iot_definition() -> dict:
    path = (
        pathlib.Path(reporting.models.__file__).resolve().parent.parent
        / "migrations" / "versions" / "0004_dashboard_datasets.py"
    )
    spec = importlib.util.spec_from_file_location("_mig0004_exec", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.IOT_DEFINITION


DATASET = Dataset(
    key="iot_readings", name="IoT readings", permission="bi.read",
    definition=_seeded_iot_definition(),
)


# ── the scripted session ─────────────────────────────────────────────────────


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


class ScriptedDb:
    """Rows per statement KIND, consumed in order; anything unscripted raises.

    Two kinds reach this executor: the series DISCOVERY and the chart SELECT
    (`distinct_values` counts as the latter). A comparison runs the chart
    SELECT twice, so those are a
    queue — and an empty queue is an AssertionError naming the kind, which is
    how "the comparison pass discovered its own series" shows up as a failure
    instead of as a second, different question being answered.
    """

    def __init__(self, *, discover=None, select=None):
        self.discover = list(discover or [])
        self.select = list(select or [])
        self.asked: list[str] = []

    async def execute(self, clause, params=None):
        sql = str(clause)
        # Discovery is the only statement that BOTH projects the series key
        # and counts rows per key; the chart SELECT projects the key without
        # `count(*) AS n`, and the filter picker counts without the key.
        discovering = f'AS "{sqlgen.COL_SERIES}"' in sql and "count(*) AS n" in sql
        kind = "discover" if discovering else "select"
        queue = self.discover if kind == "discover" else self.select
        if not queue:
            raise AssertionError(
                f"the executor ran a `{kind}` statement this test did not script "
                f"— it should not have got that far"
            )
        self.asked.append(kind)
        return _Result(queue.pop(0))


def _q(**over) -> BuilderQuery:
    body = {"dataset": "iot_readings"}
    body.update(over)
    return BuilderQuery.model_validate(body)


def _rel(key: str = "1h"):
    return DATASET.definition.relation(key)


def _flat(db, q, **kw):
    return run(ex._flat_pass(db, str(TENANT), DATASET, q, rel=_rel(), start=START, end=END, **kw))


def _split(db, q, *, series_keys=None):
    return run(
        ex._split_series_pass(
            db, str(TENANT), DATASET, q, rel=_rel(), start=START, end=END,
            series_keys=series_keys,
        )
    )


# ── cell(): the JSON type a chart can actually plot ──────────────────────────


def test_a_decimal_count_arrives_as_a_number_and_not_as_a_string():
    """Postgres returns `Decimal` for `sum()` over a bigint and pydantic
    serialises a Decimal as a STRING. A sample count that becomes "1042" is not
    a number a chart can add up — the bar silently stops being drawn."""
    assert ex.cell(decimal.Decimal("1042")) == 1042
    assert isinstance(ex.cell(decimal.Decimal("1042")), int)
    assert ex.cell(decimal.Decimal("1.5")) == 1.5


def test_a_uuid_cell_arrives_as_a_string_a_renderer_can_key_on():
    assert ex.cell(P1) == str(P1)


def test_a_null_cell_stays_null_and_is_never_narrowed_to_zero():
    """The §4 rule at its smallest: this function is the last place a missing
    measure could quietly acquire a value."""
    assert ex.cell(None) is None


@pytest.mark.parametrize("v", [0, 0.0, False, "", True])
def test_a_falsy_but_real_value_is_passed_through_unchanged(v):
    """A guard written as `if not v: return None` would erase a measured zero,
    which is exactly the fact the NULL rule exists to protect."""
    out = ex.cell(v)
    assert out == v and type(out) is type(v)


def test_a_timestamp_is_left_alone_for_the_serialiser_to_render():
    assert ex.cell(START) is START


# ── column names a renderer can key on ───────────────────────────────────────


def test_two_series_with_the_same_label_get_distinct_columns():
    """Two points both named `Current` on two devices is legitimate. A chart
    with two identically-named columns is a chart that has lost one of them."""
    assert ex._uniq(["time", "Current", "Current", "Current"]) == [
        "time", "Current", "Current (2)", "Current (3)"
    ]


# ── the flat pass: the generated SELECT is already the table ─────────────────


def test_a_column_the_result_does_not_carry_becomes_a_hole_not_an_error():
    """A dataset edited under a saved widget, or a renamed output, must not take
    the request down — and must not shift the remaining cells left, which would
    put a device name in the value column and look entirely plausible."""
    q = _q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
           group_by=["point_tag"])
    db = ScriptedDb(select=[[{"point_tag": "AHU-1 Current"}]])
    out = _flat(db, q)
    assert out.rows == [["AHU-1 Current", None]]


def test_an_empty_result_still_reports_its_columns_so_a_renderer_can_say_nothing_here():
    q = _q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
           group_by=["point_tag"])
    out = _flat(ScriptedDb(select=[[]]), q)
    assert out.columns == ["Point name", "Samples"]
    assert out.rows == [] and out.matched == 0 and out.truncated is False


def test_the_matched_total_comes_from_the_window_function_and_flags_truncation():
    """`__total` is `count(*) OVER ()` — how many groups exist, against how many
    the LIMIT returned. Without it the client cannot tell a complete chart from
    the top 12 of 400, and "the estate" would be whatever fitted."""
    q = _q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
           group_by=["point_tag"], limit=1)
    db = ScriptedDb(select=[[{"point_tag": "A", "samples_sum": 3, sqlgen.COL_TOTAL: 400}]])
    out = _flat(db, q)
    assert out.matched == 400 and out.truncated is True


def test_without_a_total_column_the_row_count_is_the_match_count_and_nothing_is_truncated():
    q = _q(select=[{"dimension": "point_tag"}], group_by=["point_tag"])
    out = _flat(ScriptedDb(select=[[{"point_tag": "A"}, {"point_tag": "B"}]]), q)
    assert out.matched == 2 and out.truncated is False


def test_an_alias_names_the_column_and_otherwise_the_registry_label_does():
    """The column header is what an operator reads. Falling back to the raw
    registry KEY would show `samples_sum` on a dashboard."""
    q = _q(select=[{"dimension": "point_tag", "alias": "Meter"},
                   {"measure": "samples", "aggregate": "sum"}],
           group_by=["point_tag"])
    out = _flat(ScriptedDb(select=[[]]), q)
    assert out.columns == ["Meter", "Samples"]


def test_a_flat_time_series_puts_the_bucket_first_and_calls_it_time():
    q = _q(time_series=True, select=[{"measure": "samples", "aggregate": "sum"}])
    db = ScriptedDb(select=[[{sqlgen.COL_TIME: START, "samples_sum": decimal.Decimal("7")}]])
    out = _flat(db, q)
    assert out.columns == ["time", "Samples"]
    assert out.rows == [[START, 7]]


# ── the split pass: one column per series ────────────────────────────────────


_SPLIT = dict(
    time_series=True, series_by="point_id", series_label="point_tag",
    select=[{"measure": "value", "aggregate": "avg"}],
)


def test_a_discovery_that_finds_no_series_never_runs_the_chart_query():
    """Step 3 of this module's order of operations. The chart query is bounded
    BY the discovered series, so running it with none discovered is an unbounded
    scan of the tenant — and the scripted session refuses it, which is the
    assertion: an unscripted `select` here is an AssertionError."""
    db = ScriptedDb(discover=[[]])
    out = _split(db, _q(**_SPLIT))
    assert out.columns == ["time"] and out.rows == [] and out.matched == 0
    assert db.asked == ["discover"]


def test_a_series_with_no_sample_in_a_bucket_stays_null_rather_than_becoming_zero():
    """The gap ECharts draws. A zero here asserts the sensor measured nothing,
    which is a different and much worse claim than "we have no sample"."""
    db = ScriptedDb(
        discover=[[{sqlgen.COL_SERIES: P1, sqlgen.COL_SERIES_LABEL: "A", sqlgen.COL_TOTAL: 2},
                   {sqlgen.COL_SERIES: P2, sqlgen.COL_SERIES_LABEL: "B", sqlgen.COL_TOTAL: 2}]],
        select=[[
            {sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P1, "value_avg": 1.0},
            {sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P2, "value_avg": 2.0},
            # The second bucket has a sample for A only.
            {sqlgen.COL_TIME: END, sqlgen.COL_SERIES: P1, "value_avg": 3.0},
        ]],
    )
    out = _split(db, _q(**_SPLIT))
    assert out.columns == ["time", "A", "B"]
    assert out.rows == [[START, 1.0, 2.0], [END, 3.0, None]]


def test_an_explicit_null_measure_is_carried_through_as_null():
    """A bucket the rollup produced with no numeric value — every sample was a
    text reading. It is a row, and its value is absent."""
    db = ScriptedDb(
        discover=[[{sqlgen.COL_SERIES: P1, sqlgen.COL_SERIES_LABEL: "A", sqlgen.COL_TOTAL: 1}]],
        select=[[{sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P1, "value_avg": None}]],
    )
    assert _split(db, _q(**_SPLIT)).rows == [[START, None]]


def test_buckets_are_ordered_by_time_whatever_order_the_rows_arrived_in():
    """A pivot keyed on a dict must not inherit insertion order as chart order:
    a line drawn through shuffled buckets folds back on itself."""
    db = ScriptedDb(
        discover=[[{sqlgen.COL_SERIES: P1, sqlgen.COL_SERIES_LABEL: "A", sqlgen.COL_TOTAL: 1}]],
        select=[[
            {sqlgen.COL_TIME: END, sqlgen.COL_SERIES: P1, "value_avg": 2.0},
            {sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P1, "value_avg": 1.0},
        ]],
    )
    assert [r[0] for r in _split(db, _q(**_SPLIT)).rows] == [START, END]


def test_a_series_with_no_label_falls_back_to_its_key_rather_than_an_empty_header():
    """`point_tag` is nullable. A blank column header is indistinguishable from
    the next one along; the uuid at least identifies the series."""
    db = ScriptedDb(
        discover=[[{sqlgen.COL_SERIES: P1, sqlgen.COL_SERIES_LABEL: "  ", sqlgen.COL_TOTAL: 1}]],
        select=[[]],
    )
    assert _split(db, _q(**_SPLIT)).columns == ["time", str(P1)]


def test_more_series_matched_than_drawn_is_reported_as_truncated():
    db = ScriptedDb(
        discover=[[{sqlgen.COL_SERIES: P1, sqlgen.COL_SERIES_LABEL: "A", sqlgen.COL_TOTAL: 40}]],
        select=[[]],
    )
    out = _split(db, _q(**_SPLIT))
    assert out.matched == 40 and out.truncated is True


def test_pinned_series_keys_skip_discovery_entirely():
    """The comparison pass pins the primary window's keys. If it discovered its
    own, the earlier window's top-N would decide the columns and the two periods
    would be different questions — so discovery running at all is the failure,
    and the scripted session has no `discover` entry to give it."""
    db = ScriptedDb(select=[[{sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P1, "value_avg": 5.0}]])
    out = _split(db, _q(**_SPLIT), series_keys=[P1])
    assert db.asked == ["select"]
    assert out.columns == ["time", str(P1)] and out.rows == [[START, 5.0]]


def test_a_row_for_a_series_the_chart_is_not_drawing_is_ignored_not_mispositioned():
    """Belt and braces on the pivot's column lookup: an unknown key must not
    land in another series' column, which would be one point's reading drawn on
    another point's line."""
    db = ScriptedDb(select=[[
        {sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P1, "value_avg": 5.0},
        {sqlgen.COL_TIME: START, sqlgen.COL_SERIES: P2, "value_avg": 9.0},
    ]])
    assert _split(db, _q(**_SPLIT), series_keys=[P1]).rows == [[START, 5.0]]


# ── the delta, and the three questions that have no answer ───────────────────


def test_a_real_change_is_a_fraction_of_the_earlier_value():
    assert ex._delta(150, 100) == pytest.approx(0.5)
    assert ex._delta(50, 100) == pytest.approx(-0.5)


def test_a_change_from_a_negative_baseline_uses_its_magnitude():
    """Dividing by a signed baseline flips the SIGN of the change: a temperature
    rising from −10 to −5 would report as a 50% fall."""
    assert ex._delta(-5, -10) == pytest.approx(0.5)


@pytest.mark.parametrize(
    "current, previous, why",
    [
        (10, None, "nothing to compare against"),
        (None, 10, "nothing measured this period"),
        (10, 0, "change from zero is undefined"),
        ("AHU-1", "AHU-2", "two labels are not a quantity"),
        (10, "AHU-2", "a label is not a baseline"),
        (True, False, "a boolean is a state, not an amount"),
    ],
)
def test_a_change_with_no_answer_is_null_and_never_a_number(current, previous, why):
    """Each of these has a tempting wrong answer — −100%, +100%, +∞% — and each
    would be an invention presented as a measurement."""
    assert ex._delta(current, previous) is None, why


# ── aligning the two periods ─────────────────────────────────────────────────


def _ts_q():
    return _q(time_series=True, select=[{"measure": "samples", "aggregate": "sum"}])


def _pass(columns, rows):
    return ex._Pass(columns, rows, len(rows), False, None, "", None)


def test_buckets_pair_on_their_position_in_their_own_window_not_on_their_timestamp():
    """"The third hour of the period" is what lines up across two windows. Keying
    on the timestamp would pair nothing at all, and every delta would be NULL."""
    prior_start = START - dt.timedelta(days=1)
    primary = _pass(["time", "Samples"], [[START, 10], [START + dt.timedelta(hours=1), 20]])
    prior = _pass(
        ["time", "Samples"],
        [[prior_start, 5], [prior_start + dt.timedelta(hours=1), 40]],
    )
    rows, deltas, only_prior = ex._align(
        _ts_q(), primary, prior, start=START, prior_start=prior_start, grain_sec=3600
    )
    assert rows == [[prior_start, 5], [prior_start + dt.timedelta(hours=1), 40]]
    assert deltas[0][1] == pytest.approx(1.0)
    assert deltas[1][1] == pytest.approx(-0.5)
    assert only_prior == 0


def test_over_a_raw_relation_with_no_grain_two_samples_align_only_on_the_instant():
    """There are no buckets to count, so position is meaningless. Pretending
    otherwise would pair two samples that merely arrived in the same order."""
    primary = _pass(["time", "Samples"], [[START, 10]])
    prior = _pass(["time", "Samples"], [[START - dt.timedelta(days=1), 5]])
    rows, deltas, only_prior = ex._align(
        _ts_q(), primary, prior,
        start=START, prior_start=START - dt.timedelta(days=1), grain_sec=0,
    )
    assert rows == [[None, None]]
    assert deltas == [[None, None]]
    assert only_prior == 1


def _group_q():
    return _q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
              group_by=["point_tag"])


def test_a_group_the_earlier_period_did_not_have_is_null_across_the_board():
    """Absence renders as absence. A row of zeros would make a device that was
    installed this week look like one whose consumption collapsed."""
    primary = _pass(["Point name", "Samples"], [["NEW-METER", 100]])
    prior = _pass(["Point name", "Samples"], [["OLD-METER", 50]])
    rows, deltas, only_prior = ex._align(
        _group_q(), primary, prior, start=START, prior_start=START, grain_sec=3600
    )
    assert rows == [[None, None]]
    assert deltas == [[None, None]]


def test_a_group_only_the_earlier_period_had_is_counted_rather_than_appended():
    """The widget asked about THIS period, so the row does not belong in the
    table — but "four devices stopped reporting" is the difference between
    nothing changed and something broke, so the count has to survive."""
    primary = _pass(["Point name", "Samples"], [["A", 1]])
    prior = _pass(["Point name", "Samples"], [["A", 1], ["B", 2], ["C", 3]])
    rows, _, only_prior = ex._align(
        _group_q(), primary, prior, start=START, prior_start=START, grain_sec=3600
    )
    assert len(rows) == 1
    assert only_prior == 2


def test_a_prior_row_shorter_than_the_primary_is_padded_rather_than_ragged():
    """The delta matrix is read positionally against `primary.columns`. A short
    row would shift every later delta onto the wrong column."""
    primary = _pass(["Point name", "Samples"], [["A", 10]])
    prior = _pass(["Point name"], [["A"]])
    rows, deltas, _ = ex._align(
        _group_q(), primary, prior, start=START, prior_start=START, grain_sec=3600
    )
    assert rows == [["A", None]]
    assert deltas == [[None, None]]


# ── "nothing measured" is not "no rows" ──────────────────────────────────────


@pytest.mark.parametrize(
    "rows, expected",
    [
        (None, True),
        ([], True),
        # What an UNGROUPED aggregate returns over a window with no readings:
        # one row, holding NULL. Testing list emptiness reported no_data=False
        # for a comparison that had nothing behind it.
        ([[None]], True),
        ([[None, None], [None, None]], True),
        ([[None, 0]], False),
        ([["A", None]], False),
    ],
)
def test_a_result_whose_every_cell_is_null_is_no_data(rows, expected):
    assert ex._nothing_measured(rows) is expected


# ── the resolution reason, which travels with every result ───────────────────


def test_an_automatic_resolution_says_it_chose_itself_and_an_explicit_one_does_not():
    """A chart that quietly read the hourly rollup when the operator asked for
    the minute one is the silent downgrade §4 forbids. The reason is the only
    place the response says which happened."""
    rel = _rel("1h")
    assert ex._reason(rel, True) == rel.reason
    assert ex._reason(rel, False).endswith("(chosen automatically for this window)")


# ── end to end: run() ────────────────────────────────────────────────────────


def _spec(**over) -> BuilderSpec:
    return BuilderSpec.model_validate({"viz": "line", "query": {"dataset": "iot_readings", **over}})


def test_a_result_always_carries_its_resolution_and_reason_even_when_it_is_empty():
    spec = _spec(select=[{"dimension": "point_tag"}], group_by=["point_tag"],
                 window={"last_hours": 24})
    out = run(ex.run(ScriptedDb(select=[[]]), TENANT, DATASET, spec))
    assert out.resolution == "1h"
    assert out.resolution_reason
    assert out.rows == [] and out.comparison is None


def test_a_comparison_over_a_window_with_only_nulls_reports_no_data():
    """An ungrouped aggregate over an empty window still returns ONE row, and
    that row is a shape rather than a measurement. A renderer trusting
    `no_data=False` would draw a delta against nothing."""
    spec = _spec(select=[{"measure": "samples", "aggregate": "sum"}],
                 window={"last_hours": 24}, compare={"period": "previous"})
    db = ScriptedDb(select=[[{"samples_sum": 42}], [{"samples_sum": None}]])
    out = run(ex.run(db, TENANT, DATASET, spec))
    assert out.rows == [[42]]
    assert out.comparison.no_data is True
    assert out.comparison.delta_pct == [[None]]


def test_a_comparison_with_a_real_earlier_value_is_not_no_data_and_carries_the_change():
    spec = _spec(select=[{"measure": "samples", "aggregate": "sum"}],
                 window={"last_hours": 24}, compare={"period": "week"})
    db = ScriptedDb(select=[[{"samples_sum": 150}], [{"samples_sum": 100}]])
    out = run(ex.run(db, TENANT, DATASET, spec))
    assert out.comparison.no_data is False
    assert out.comparison.delta_pct[0][0] == pytest.approx(0.5)
    assert out.comparison.start == out.start - dt.timedelta(hours=24 * 7)


def test_a_comparison_runs_the_identical_statement_shape_over_both_windows():
    """Both passes go through `_run_once`, so a second slightly different code
    path cannot make "vs last week" answer a different question. The scripted
    session proves only two selects ran — no discovery, no third query."""
    spec = _spec(select=[{"measure": "samples", "aggregate": "sum"}],
                 window={"last_hours": 24}, compare={"period": "day"})
    db = ScriptedDb(select=[[{"samples_sum": 1}], [{"samples_sum": 1}]])
    run(ex.run(db, TENANT, DATASET, spec))
    assert db.asked == ["select", "select"]


# ── the filter picker's distinct values ──────────────────────────────────────


def _distinct(db, *, column="category", search=None, hours=24, limit=50):
    return run(
        ex.distinct_values(db, TENANT, DATASET, column=column, search=search,
                           hours=hours, limit=limit)
    )


def test_the_value_picker_reports_the_points_nothing_has_classified():
    """v1 answered "unclassified" as `category=""` and the screen listed it. A
    NULL dropped here makes a real group of points unselectable — and invisible,
    because nothing says the list is partial."""
    db = ScriptedDb(select=[[{"v": "energy", "n": 90}, {"v": None, "n": 7}]])
    out = _distinct(db)
    assert out["items"] == [{"value": "energy", "count": 90}, {"value": None, "count": 7}]


def test_the_picker_names_the_dimension_and_the_store_it_read():
    """The label is what the builder shows; the resolution says which store the
    counts came from, and the counts differ between them."""
    out = _distinct(ScriptedDb(select=[[]]))
    assert out["column"] == "category"
    assert out["label"] == "Category"
    assert out["resolution"] == "1h"


def test_a_column_that_is_not_a_published_dimension_never_reaches_a_select():
    """`column` arrives from the client. The registry lookup is the allowlist,
    and it has to run BEFORE the statement is built — the scripted session has
    nothing to answer with, so a query at all is the failure."""
    with pytest.raises(Exception):
        _distinct(ScriptedDb(), column="tenant_id; DROP TABLE points")


@pytest.mark.parametrize("term", ["%", "_", "50%_off", "a\\b"])
def test_a_search_terms_wildcards_are_escaped_so_they_cannot_widen_the_match(term):
    """A bare `%` typed into the filter box matches everything, so the picker
    would claim every value contains the search — and `_` silently matches any
    single character, which looks like a working search returning wrong rows."""
    captured = {}

    class Spy(ScriptedDb):
        async def execute(self, clause, params=None):
            captured.update(params or {})
            return await super().execute(clause, params)

    _distinct(Spy(select=[[]]), search=term)
    bound = [v for v in captured.values() if isinstance(v, str) and v.startswith("%")]
    assert bound, "the search term was not bound as a parameter"
    escaped = bound[0][1:-1]
    assert escaped == term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def test_the_search_term_is_bound_and_never_written_into_the_statement():
    """The one client string that reaches this generator. A literal here is an
    injection that would pass any test asserting only that rows came back."""
    captured = {}

    class Spy(ScriptedDb):
        async def execute(self, clause, params=None):
            captured["sql"] = str(clause)
            return await super().execute(clause, params)

    _distinct(Spy(select=[[]]), search="'; DROP TABLE points--")
    assert "DROP TABLE" not in captured["sql"]
