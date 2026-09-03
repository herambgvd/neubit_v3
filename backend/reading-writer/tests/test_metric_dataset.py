"""The `metric_evaluations` dataset — that a refusal survives being tabulated.

The happy path is the easy half: a metric that computes returns a number, and
any shaping bug there shows up as a wrong chart somebody notices. What these
tests are for is the half that fails SILENTLY — a refusal that gets dropped from
a table, averaged away with the survivors, or rendered as a number. On this
estate that is not a hypothetical: every kWh register has been flat for the whole
recorded history, so `carbon_intensity` refuses `undefined_frozen` and twelve of
the CCEI's fourteen components are `not_defined`. A dataset that quietly turned
those into zeros would show a confident score for a building nobody is measuring.

The evaluator is STUBBED here, deliberately. Its own guard rules have their own
tests; what is under test is the trip from an evaluated item to a table cell, and
a stub is the only way to hold both an `ok` and a refusal in one group on demand.
"""

from __future__ import annotations

import asyncio
import datetime as dt

import pytest
from kernel.errors import ValidationError
from pydantic import ValidationError as PydanticValidationError

from app.api import metric_dataset as md
from app.api.builder import BuilderSpec
from app.api.registry import Definition
from app.metric_registry import evaluator

WINDOW = {"last_hours": 24}


def _result(*items, metric="chiller_delta_t", unit="K"):
    """What `evaluator.evaluate` returns, in the shape the real one returns it."""
    return {
        "metric": metric,
        "version": 1,
        "kind": "formula",
        "display": {"label": "Chiller ΔT"},
        "output": {"unit": unit},
        "resolution": "1h",
        "items": list(items),
    }


def _ok(value, **over):
    item = {"status": "ok", "value": value, "device_id": "d1", "device_tag": "Chiller01"}
    item.update(over)
    return item


def _refused(status, reason="because", **over):
    item = {
        "status": status,
        "value": None,
        "reason": reason,
        "device_id": "d2",
        "device_tag": "Chiller02",
    }
    item.update(over)
    return item


def _spec(**query):
    q = {"dataset": md.KEY, "window": WINDOW}
    q.update(query)
    return BuilderSpec.model_validate({"spec_version": 2, "query": q})


def _run(monkeypatch, spec, *results):
    """Execute the dataset against a scripted evaluator, one result per metric."""
    calls = iter(results)

    async def fake_evaluate(db, tenant, key, **kw):
        return next(calls)

    monkeypatch.setattr(evaluator, "evaluate", fake_evaluate)
    return asyncio.run(md.run(None, None, md.DATASET, spec))


# ── a refusal is a row, and says so ──────────────────────────────────────────


def test_a_refused_item_is_still_a_row(monkeypatch):
    """The failure this dataset exists to prevent: three sites refusing and a
    table that reports one, looking complete while it does it."""
    res = _run(
        monkeypatch,
        _spec(
            select=[
                {"dimension": "device_tag"},
                {"dimension": "status"},
                {"measure": "value", "aggregate": "avg"},
            ],
            group_by=["device_tag", "status"],
            filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
        ),
        _result(_ok(4.0), _refused("undefined_frozen", "IWT held one value")),
    )
    assert res.matched == 2
    assert ["Chiller02", "undefined_frozen", None] in res.rows


def test_a_refusal_carries_its_status_and_reason_verbatim(monkeypatch):
    """`status` and `refusal_reason` are the whole point: a hole in a chart that
    cannot say why is indistinguishable from a broken query."""
    res = _run(
        monkeypatch,
        _spec(
            select=[{"dimension": "status"}, {"dimension": "refusal_reason"}],
            group_by=["status", "refusal_reason"],
            filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
        ),
        _result(_refused("missing_fact", "no gross floor area is recorded for this site")),
    )
    assert res.rows == [["missing_fact", "no gross floor area is recorded for this site"]]


def test_a_value_on_a_refused_item_is_never_shown(monkeypatch):
    """Belt and braces against the evaluator, or a future kind of it, handing
    back a leftover number beside a non-ok status. The status decides."""
    res = _run(
        monkeypatch,
        _spec(
            select=[{"dimension": "status"}, {"measure": "value", "aggregate": "avg"}],
            group_by=["status"],
            filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
        ),
        _result(_refused("blocked", "a component refused", value=0.0)),
    )
    assert res.rows == [["blocked", None]]


# ── aggregating over a group that contains a refusal ─────────────────────────


def test_an_average_over_a_group_holding_a_refusal_is_refused(monkeypatch):
    """Four devices, two measured: the average of the two is not the average of
    the four, and presenting it as one is the quiet lie. NULL, plus the counts
    that let a widget say "2 of 4"."""
    res = _run(
        monkeypatch,
        _spec(
            select=[
                {"dimension": "metric_label"},
                {"measure": "value", "aggregate": "avg"},
                {"measure": "value", "aggregate": "count", "alias": "measured"},
                {"measure": "evaluations", "aggregate": "sum"},
                {"measure": "refusals", "aggregate": "sum"},
            ],
            group_by=["metric_label"],
            filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
        ),
        _result(
            _ok(4.0),
            _ok(6.0),
            _refused("no_data"),
            _refused("undefined_frozen"),
        ),
    )
    assert res.rows == [["Chiller ΔT", None, 2.0, 4, 2]]


def test_an_all_ok_group_still_averages(monkeypatch):
    """The refusal rule must not be a blanket refusal to compute anything."""
    res = _run(
        monkeypatch,
        _spec(
            select=[{"dimension": "metric_label"}, {"measure": "value", "aggregate": "avg"}],
            group_by=["metric_label"],
            filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
        ),
        _result(_ok(4.0), _ok(6.0)),
    )
    assert res.rows == [["Chiller ΔT", 5.0]]


@pytest.mark.parametrize("agg", ["avg", "min", "max", "sum"])
def test_every_value_aggregate_refuses_the_same_way(agg):
    group = [{"__ok": True, "__value": 1.0}, {"__ok": False, "__value": None}]
    assert md._aggregate(agg, group) is None


def test_count_stays_answerable_when_the_value_does_not():
    """A count is not a value — "how many computed" is exactly the question a
    NULL average makes a viewer ask, so it must not refuse alongside it."""
    group = [{"__ok": True, "__value": 1.0}, {"__ok": False, "__value": None}]
    assert md._aggregate("count", group) == 1.0


def test_a_group_with_nothing_in_it_is_null_not_zero():
    assert md._aggregate("sum", []) is None


def test_a_refused_group_sorts_below_the_measured_ones(monkeypatch):
    """`ORDER BY value DESC` on a "worst first" table must not put a refusal at
    the top, where it reads as the worst measured number."""
    res = _run(
        monkeypatch,
        _spec(
            select=[{"dimension": "device_tag"}, {"measure": "value", "aggregate": "avg"}],
            group_by=["device_tag"],
            order_by=[{"select_index": 1, "dir": "desc"}],
            filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
        ),
        _result(
            _refused("no_data", device_tag="Chiller02"),
            _ok(4.0, device_tag="Chiller01"),
        ),
    )
    assert [r[0] for r in res.rows] == ["Chiller01", "Chiller02"]


# ── what the dataset refuses to pretend to do ────────────────────────────────


@pytest.mark.parametrize(
    "query, expected",
    [
        ({"time_series": True}, "no time axis"),
        ({"time_series": True, "series_by": "site_id"}, "no time axis"),
        (
            {"having": [{"measure": "value", "aggregate": "avg", "op": ">", "value": 1}]},
            "`having` is not available",
        ),
        ({"filter_combinator": "OR"}, "AND only"),
    ],
)
def test_unsupported_state_is_refused_by_name(query, expected):
    """Silence would read as support: a trend widget that drew one flat point
    would look like a broken chart rather than a feature that does not exist."""
    spec = _spec(select=[{"measure": "evaluations", "aggregate": "sum"}], **query)
    with pytest.raises(ValidationError) as exc:
        md._check_supported(spec.query)
    assert expected in str(exc.value)


def test_a_widget_that_names_no_metric_is_told_which_ones_exist(monkeypatch):
    async def fake_list(db, tenant):
        return [{"key": "ccei", "display": {"label": "CCEI"}}]

    monkeypatch.setattr(md.metric_registry, "list_definitions", fake_list)
    q = _spec(select=[{"measure": "evaluations", "aggregate": "sum"}]).query
    with pytest.raises(ValidationError) as exc:
        asyncio.run(
            md._evaluate(
                None, None, q,
                resolution="1h",
                start=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc),
                end=dt.datetime(2026, 9, 2, tzinfo=dt.timezone.utc),
            )
        )
    assert "ccei" in str(exc.value)


def test_too_many_metrics_at_once_is_refused():
    q = _spec(
        select=[{"measure": "evaluations", "aggregate": "sum"}],
        filters=[
            {"column": "metric", "op": "in", "values": [f"m{i}" for i in range(md.MAX_METRICS + 1)]}
        ],
    ).query
    with pytest.raises(ValidationError) as exc:
        asyncio.run(
            md._evaluate(
                None, None, q,
                resolution="1h",
                start=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc),
                end=dt.datetime(2026, 9, 2, tzinfo=dt.timezone.utc),
            )
        )
    assert str(md.MAX_METRICS) in str(exc.value)


def test_a_shown_dimension_outside_the_grouping_is_refused(monkeypatch):
    """SQL's own rule. Answering it from an arbitrary member of the group is how
    one site's number ends up labelled with another site's name."""
    with pytest.raises(ValidationError) as exc:
        _run(
            monkeypatch,
            _spec(
                select=[{"dimension": "device_tag"}, {"measure": "evaluations", "aggregate": "sum"}],
                group_by=["metric"],
                filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
            ),
            _result(_ok(4.0)),
        )
    assert "not grouped by" in str(exc.value)


# ── filters over the computed rows ───────────────────────────────────────────


def test_a_null_cell_satisfies_no_positive_predicate():
    """A device-scope row has no site. It is not "a site other than this one",
    so `!=` must not match it — the SQL semantics, kept, because a filter that
    silently included scope-less rows would double-count an estate."""
    row = {"site_id": None}
    assert not md._matches(row, "site_id", "=", "s1", [])
    assert not md._matches(row, "site_id", "!=", "s1", [])
    assert md._matches(row, "site_id", "is null", None, [])


def test_filtering_to_ok_is_possible_but_has_to_be_asked_for(monkeypatch):
    """"Show me only what computed" is a legitimate question. It is legitimate
    because the widget SAYS so — the refusals are excluded by a filter a reader
    can see, not by the dataset deciding on their behalf."""
    res = _run(
        monkeypatch,
        _spec(
            select=[{"dimension": "device_tag"}, {"measure": "value", "aggregate": "avg"}],
            group_by=["device_tag"],
            filters=[
                {"column": "metric", "op": "=", "value": "chiller_delta_t"},
                {"column": "status", "op": "=", "value": "ok"},
            ],
        ),
        _result(_ok(4.0), _refused("no_data")),
    )
    assert res.rows == [["Chiller01", 4.0]]


# ── the dataset's own contract ───────────────────────────────────────────────


def test_the_dataset_is_published_to_the_builder():
    assert md.virtual_datasets()[md.KEY].definition.engine == "metric_registry"
    published = md.DATASET.public()
    assert {m["key"] for m in published["measures"]} == {"value", "evaluations", "refusals"}
    value = next(m for m in published["measures"] if m["key"] == "value")
    # Contract §4: an index and an intensity are not one average.
    assert value["comparable"] is False
    assert "metric" in value["comparable_within"]


def test_a_computed_measure_may_not_claim_a_physical_column():
    """A mapping onto `num_avg` here would describe a relation nothing reads,
    and the next person to change that relation would think they had changed
    this dataset."""
    bad = dict(md._DEFINITION)
    bad["measures"] = [
        {
            "key": "value",
            "label": "Value",
            "aggregates": ["avg"],
            "physical": {"1h": {"avg": {"fn": "avg", "column": "num_avg"}}},
        }
    ]
    with pytest.raises((PydanticValidationError, ValueError)) as exc:
        Definition.model_validate(bad)
    assert "generates no SQL" in str(exc.value)


def test_the_resolutions_are_the_ones_the_evaluator_actually_reads():
    """The dataset must not advertise a store the evaluation path will not use:
    `raw` is refused by the evaluator, so it is not offered here, and the 3-hour
    ceiling on `1m` is the evaluator's own `_FINE_MAX_HOURS`."""
    d = md.DATASET.definition
    assert [r.key for r in d.relations] == ["1m", "1h"]
    assert d.relation("1m").max_window_minutes == evaluator._FINE_MAX_HOURS * 60
    assert d.choose_relation(1).key == "1m"
    assert d.choose_relation(24).key == "1h"


def test_the_resolution_the_result_reports_is_the_one_that_was_read(monkeypatch):
    """A result that named a resolution the evaluator did not use would put a
    freshness claim on a chart nobody checked."""
    seen = {}

    async def fake_evaluate(db, tenant, key, **kw):
        seen["resolution"] = kw["resolution"]
        return _result(_ok(1.0))

    monkeypatch.setattr(evaluator, "evaluate", fake_evaluate)
    spec = _spec(
        window={"last_hours": 1},
        select=[{"measure": "evaluations", "aggregate": "sum"}],
        filters=[{"column": "metric", "op": "=", "value": "chiller_delta_t"}],
    )
    res = asyncio.run(md.run(None, None, md.DATASET, spec))
    assert seen["resolution"] == "1m"
    assert res.resolution == "1m"
