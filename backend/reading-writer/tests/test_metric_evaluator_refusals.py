"""The device-scope refusal vocabulary — every reason, distinguishable.

WHY THIS FILE EXISTS. `metric_registry.evaluator` is built on one promise: it
would rather return a structured absence than a wrong number, and each absence
carries the ONE reason that tells an operator what to do about it. A missing
role is a Metric Roles job; an unconfirmed unit is a Units tab job; a frozen
input is a field job. If two of those ever collapsed into the same sentence —
or into a bare `null` — the promise would still look kept on a screen and the
operator would be sent to the wrong place, or nowhere.

Nothing here needs a database. Every guard in this module is reached with rows
that have already been fetched; `metric_fakes.FakeDb` supplies exactly those
rows and fails loudly on any query a test did not expect, so "the evaluator
queried the readings before it had checked the units" is a test failure rather
than a slower path nobody notices.
"""

from __future__ import annotations

import datetime as dt

import pytest
from metric_fakes import FakeDb, agg, at, pid, point, run

from app.metric_registry import evaluator as ev


# ── resolution: the rollup it reads, and the one it will not ─────────────────


def test_raw_is_refused_by_name_and_never_quietly_downgraded():
    """Metrics read rollups only. Silently serving 1m for a `raw` request would
    answer a different question than the one asked, at a different sample
    weighting, with nothing in the response saying so."""
    # The window is built before the block, so `pick_resolution` is the only call
    # inside it that can raise — otherwise a broken `at()` would satisfy the
    # assertion while the resolution guard was doing nothing.
    start, end = at(1), at(2)
    with pytest.raises(ev.EvaluationError) as exc:
        ev.pick_resolution(start, end, "raw")
    assert "rollups only" in str(exc.value)


@pytest.mark.parametrize(
    "hours, expected",
    [(1, "1m"), (3, "1m"), (4, "1h"), (24 * 30, "1h")],
)
def test_auto_picks_the_fine_rollup_only_inside_the_three_hour_ceiling(hours, expected):
    """The boundary is the read API's own, and it is INCLUSIVE at 3h. Drifting
    it makes a metric and the chart beside it read different tables for the same
    window, which is how two numbers that must agree stop agreeing."""
    res, reason = ev.pick_resolution(at(1), at(1) + dt.timedelta(hours=hours), "auto")
    assert res == expected
    assert f"{hours:.1f}h" in reason


def test_an_unknown_resolution_is_a_request_error_not_a_silent_default():
    start, end = at(1), at(2)
    with pytest.raises(ev.EvaluationError, match="auto, 1m, 1h"):
        ev.pick_resolution(start, end, "5m")


# ── binding a role to a point ────────────────────────────────────────────────


_INPUTS = {"kwh": {"role": "energy_total", "unit": "kWh"}}


def _bind(rows, inputs=None):
    return run(
        ev._bind_roles_on_device(FakeDb(device_roles=rows), None, pid(1), inputs or _INPUTS)
    )


def test_no_point_in_the_role_refuses_naming_the_role_the_input_and_the_screen():
    """`missing_role` is the commonest honest state on a new estate, and it is
    only actionable if it says WHICH role and where roles are confirmed."""
    out = _bind([])
    assert out["status"] == "missing_role"
    assert "`energy_total`" in out["reason"]
    assert "`kwh`" in out["reason"]
    assert "Metric Roles" in out["reason"]
    assert out["value"] is None


def test_two_points_in_one_role_refuse_and_name_both_so_the_extra_is_findable():
    """A metric must never pick between two claims to the same role. Naming only
    the count would leave the operator to find them by hand."""
    out = _bind([
        point(1, role="energy_total", tag="MAIN-KWH"),
        point(2, role="energy_total", tag="SPARE-KWH"),
    ])
    assert out["status"] == "ambiguous_role"
    assert "MAIN-KWH" in out["reason"]
    assert "SPARE-KWH" in out["reason"]


def test_one_point_in_the_role_binds_to_that_point():
    out = _bind([point(1, role="energy_total", tag="MAIN-KWH")])
    assert out["status"] == "ok"
    assert out["bound"]["kwh"]["point_tag"] == "MAIN-KWH"


# ── units: the guards that keep a number off an assumed unit ─────────────────


def _bound(*points_, names=("a", "b")):
    return {n: p for n, p in zip(names, points_)}


def test_a_missing_unit_refuses_and_names_the_point_and_where_to_set_it():
    """A number with no unit cannot be graded — 5.5 is a healthy ΔT or a
    trivial power, and nothing here decides which.

    The guard used to demand `unit_source == "operator"`: the unit had to be
    confirmed in THIS store. The gateway describes the signal now and the unit
    rides every envelope, so a unit that arrived is a unit somebody stated —
    just not here. What still refuses is an ABSENT one."""
    out = ev._unit_guards_refusal(
        ["units_confirmed"],
        {"a": {"role": "energy_total"}},
        _bound(point(1, role="energy_total", tag="MAIN", unit=None), names=("a",)),
    )
    assert out["status"] == "unit_unknown"
    assert "`MAIN` (a)" in out["reason"]
    assert "gateway" in out["reason"]


def test_a_unit_the_gateway_recorded_computes():
    """The whole point of the change: 298 of this estate's 341 units came from
    the gateway and NONE were ever entered here, so demanding a second
    confirmation refused every metric on the estate forever."""
    assert ev._unit_guards_refusal(
        ["units_confirmed"],
        {"a": {"role": "energy_total"}},
        _bound(point(1, role="energy_total", unit="kWh", unit_source="reading"), names=("a",)),
    ) is None


def test_a_blank_unit_is_as_absent_as_a_missing_one():
    """`""` is what an unstated unit looks like coming off the wire, and it is
    not an assertion that the quantity is dimensionless."""
    out = ev._unit_guards_refusal(
        ["units_confirmed"],
        {"a": {"role": "energy_total"}},
        _bound(point(1, role="energy_total", unit="   ", unit_source="reading"), names=("a",)),
    )
    assert out["status"] == "unit_unknown"


def test_without_the_guard_a_point_with_no_unit_is_allowed_to_compute():
    """The guard is opt-in per definition. If it fired unconditionally, every
    definition that deliberately runs unit-open would refuse forever."""
    assert ev._unit_guards_refusal(
        [],
        {"a": {"role": "energy_total"}},
        _bound(point(1, role="energy_total", unit=None), names=("a",)),
    ) is None


def test_an_input_that_demands_an_exact_unit_refuses_the_wrong_one_naming_both():
    out = ev._unit_guards_refusal(
        [],
        {"a": {"role": "energy_total", "unit": "kWh"}},
        _bound(point(1, role="energy_total", tag="MAIN", unit="Wh"), names=("a",)),
    )
    assert out["status"] == "unit_mismatch"
    assert "`kWh`" in out["reason"]
    assert "`Wh`" in out["reason"]


def test_an_input_that_demands_a_dimension_refuses_a_unit_of_another_one():
    """Declared by dimension, an input still may not bind a temperature to an
    energy — and the refusal names the dimension it got, `unknown` included."""
    out = ev._unit_guards_refusal(
        [],
        {"a": {"role": "energy_total", "dimension": "energy"}},
        _bound(point(1, role="energy_total", unit="degC"), names=("a",)),
    )
    assert out["status"] == "unit_mismatch"
    assert "`energy`" in out["reason"]
    assert "temperature" in out["reason"]


def test_same_unit_refuses_two_sides_in_different_units_rather_than_converting():
    """°C on one side and °F on the other is the case the module documents:
    conversion is not modelled, so a ΔT across them is refused, not computed."""
    out = ev._unit_guards_refusal(
        ["same_unit"],
        {"a": {"role": "chw_supply_temp"}, "b": {"role": "chw_return_temp"}},
        _bound(
            point(1, role="chw_supply_temp", unit="degC"),
            point(2, role="chw_return_temp", unit="degF"),
        ),
    )
    assert out["status"] == "unit_mismatch"
    assert "conversion is not" in out["reason"]
    assert "a=`degC`" in out["reason"]
    assert "b=`degF`" in out["reason"]


def test_same_unit_passes_when_both_sides_agree():
    assert ev._unit_guards_refusal(
        ["same_unit"],
        {"a": {"role": "chw_supply_temp"}, "b": {"role": "chw_return_temp"}},
        _bound(
            point(1, role="chw_supply_temp", unit="degC"),
            point(2, role="chw_return_temp", unit="degC"),
        ),
    ) is None


def test_a_missing_unit_is_reported_before_a_wrong_one():
    """Both are true of this point; only one is actionable. Telling an operator
    the unit is wrong when there is no unit at all sends them to correct a value
    that was never asserted."""
    out = ev._unit_guards_refusal(
        ["units_confirmed"],
        {"a": {"role": "energy_total", "unit": "kWh"}},
        _bound(point(1, role="energy_total", unit=None), names=("a",)),
    )
    assert out["status"] == "unit_unknown"


# ── absence, and the flat input that is not absence ──────────────────────────


def test_a_point_with_no_bucket_in_the_window_refuses_as_absence_not_zero():
    """A kWh input with no rows is not 0 kWh. The whole `no_data` status exists
    so that a dashboard renders a gap rather than a perfect efficiency."""
    bound = _bound(point(1, role="energy_total", tag="MAIN"), names=("a",))
    out = run(ev._device_aggregates(FakeDb(aggs=[]), None, bound, at(1), at(2), "readings_1h"))
    assert out["status"] == "no_data"
    assert "`MAIN`" in out["reason"]
    assert "absence is absence, not zero" in out["reason"]


def test_a_bucket_row_whose_requested_aggregate_is_null_is_also_absence():
    """Text-only samples produce rows with a NULL numeric aggregate. Casting
    that to float would be a TypeError in production; reading it as 0 would be
    worse."""
    out = ev._device_input_values(
        {"a": {"role": "energy_total", "aggregation": "avg"}},
        _bound(point(1, role="energy_total", tag="MAIN"), names=("a",)),
        {pid(1): agg(1, avg=None)},
    )
    assert out["status"] == "no_data"
    assert "no numeric samples" in out["reason"]


def test_a_frozen_input_refuses_naming_the_input_its_point_and_the_flat_value():
    """Zero variance over a window means the metric is undefined, not zero — and
    the operator needs the point tag to go and look at the sensor."""
    out = ev._frozen_input_refusal(
        ["non_frozen"],
        _bound(point(1, role="chw_supply_temp", tag="CH1-CHWS"), names=("a",)),
        {pid(1): agg(1, avg=7.0, lo=7.0, hi=7.0, samples=120)},
    )
    assert out["status"] == "undefined_frozen"
    assert "`a`" in out["reason"]
    assert "`CH1-CHWS`" in out["reason"]
    assert "7" in out["reason"]
    assert "120 samples" in out["reason"]


def test_one_sample_is_not_evidence_that_an_input_is_frozen():
    """A single sample is trivially min == max. Calling that frozen would refuse
    every short window at 1h resolution."""
    assert ev._frozen_input_refusal(
        ["non_frozen"],
        _bound(point(1, role="chw_supply_temp"), names=("a",)),
        {pid(1): agg(1, avg=7.0, lo=7.0, hi=7.0, samples=1)},
    ) is None


def test_a_flat_input_computes_where_the_definition_does_not_forbid_it():
    """`non_frozen` is per definition. A flat kWh register is meaningful to some
    formulas and fatal to others, and the definition is what decides."""
    assert ev._frozen_input_refusal(
        [],
        _bound(point(1, role="chw_supply_temp"), names=("a",)),
        {pid(1): agg(1, avg=7.0, lo=7.0, hi=7.0, samples=120)},
    ) is None


def test_an_input_that_moved_passes_the_frozen_guard():
    assert ev._frozen_input_refusal(
        ["non_frozen"],
        _bound(point(1, role="chw_supply_temp"), names=("a",)),
        {pid(1): agg(1, avg=7.0, lo=6.0, hi=9.0, samples=120)},
    ) is None


def test_the_declared_aggregation_is_the_column_that_is_read():
    """`sum` and `avg` over the same window are different numbers; reading the
    wrong column produces a plausible one with no sign it is wrong."""
    bound = _bound(point(1, role="energy_total"), names=("a",))
    aggs = {pid(1): agg(1, avg=2.5, total=250.0, buckets=100, samples=100)}
    assert ev._device_input_values({"a": {"role": "r", "aggregation": "sum"}}, bound, aggs)["env"]["a"] == 250.0
    assert ev._device_input_values({"a": {"role": "r"}}, bound, aggs)["env"]["a"] == 2.5


# ── composites: a composite of a refusal is a refusal ────────────────────────


def test_a_composite_is_the_weighted_sum_and_shows_its_working():
    out = ev._compose(
        {"output": {"unit": "", "dimension": "dimensionless"}},
        [
            {"metric": "eei", "weight": 0.4, "status": "ok", "value": 80.0, "reason": None},
            {"metric": "cpi", "weight": 0.6, "status": "ok", "value": 60.0, "reason": None},
        ],
    )
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(0.4 * 80 + 0.6 * 60)
    assert out["arithmetic"] == "0.4 × eei(80) + 0.6 × cpi(60) = 68"


def test_one_refusing_component_refuses_the_composite_and_keeps_every_reason():
    """A CCEI that quietly renormalised over the components that DID evaluate
    would move with which sensors happen to be alive. The refusal carries the
    whole component list so the screen can explain itself input by input."""
    parts = [
        {"metric": "eei", "weight": 0.4, "status": "ok", "value": 80.0, "reason": None},
        {"metric": "cpi", "weight": 0.6, "status": "missing_role",
         "value": None, "reason": "no point is confirmed in role `chw_flow`"},
    ]
    out = ev._compose({}, parts)
    assert out["status"] == "blocked"
    assert out["value"] is None
    assert "1 of 2 component(s)" in out["reason"]
    assert "`cpi` missing_role: no point is confirmed in role `chw_flow`" in out["reason"]
    assert out["components"] == parts


def test_a_component_with_no_applicable_device_at_the_site_says_exactly_that():
    """Distinct from "the device refused": there is nothing to refuse. The
    status stays `missing_role` because the fix is to confirm a role somewhere."""
    out = ev._component_over_devices("chiller_kw_per_tr", [])
    assert out["status"] == "missing_role"
    assert "no applicable device" in out["reason"]


def test_any_device_refusal_refuses_the_component_and_names_that_device():
    """Averaging the two chillers that DID report would quietly present a
    two-thirds sample as the site's number."""
    out = ev._component_over_devices(
        "chiller_kw_per_tr",
        [
            {"device_id": pid(1), "device_tag": "CH-1", "status": "ok", "value": 0.6, "reason": None},
            {"device_id": pid(2), "device_tag": "CH-2", "status": "undefined_frozen",
             "value": None, "reason": "held one distinct value"},
        ],
    )
    assert out["status"] == "blocked"
    assert "CH-2" in out["reason"]
    assert "undefined_frozen" in out["reason"]
    assert "1 of 2 device(s)" in out["reason"]


def test_a_component_over_devices_is_the_mean_of_the_devices_that_evaluated():
    out = ev._component_over_devices(
        "chiller_kw_per_tr",
        [
            {"device_id": pid(1), "device_tag": "CH-1", "status": "ok", "value": 0.6, "reason": None},
            {"device_id": pid(2), "device_tag": "CH-2", "status": "ok", "value": 0.8, "reason": None},
        ],
    )
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(0.7)
    assert "over 2 device(s)" in out["arithmetic"]


def test_an_undefined_component_prints_the_parents_own_documentation():
    """"no metric `x` is effective" is true and useless. Where the pack
    documents the component, the operator learns whether the gap is a field job,
    a config job or a build job."""
    parent = {
        "display": {
            "components": {
                "iaq_co2": {
                    "label": "CO₂ in band",
                    "blocked_by": "no CO₂ sensor is installed on this estate",
                    "source": "CCEI spec §3.3",
                }
            }
        }
    }
    reason = ev._undefined_reason(parent, "iaq_co2", at(1))
    assert reason == (
        "CO₂ in band is not defined — no CO₂ sensor is installed on this "
        "estate (source: CCEI spec §3.3)"
    )


_UNDEFINED_PARENT = {
    "kind": "composite",
    "components": [{"metric": "iaq_co2", "weight": 1.0}],
    "output": {"unit": "", "dimension": "dimensionless"},
    "display": {
        "components": {
            "iaq_co2": {
                "label": "CO₂ in band",
                "blocked_by": "no CO₂ sensor is installed on this estate",
                "source": "CCEI spec §3.3",
            }
        }
    },
}


def test_a_device_composite_refuses_an_undefined_component_instead_of_raising():
    """The site path already answers this with `not_defined`; the device path
    let the "no metric is effective" EvaluationError out of the component and
    failed the WHOLE request — one undefined leaf and the composite could not
    even say which. A pack normally ships its components ahead of the metrics
    that compute them, so this is the ordinary state of a growing pack, not an
    exotic one, and the two paths must mean the same thing by it."""
    out = run(ev._evaluate_composite(
        FakeDb(definitions=[]), None, _UNDEFINED_PARENT, pid(1),
        at(1), at(2), "1h", 0,
    ))
    assert out["status"] == "blocked"
    assert out["value"] is None
    part = out["components"][0]
    assert (part["metric"], part["status"], part["weight"]) == ("iaq_co2", "not_defined", 1.0)
    # The pack's own documentation, exactly as the site path prints it.
    assert part["reason"] == (
        "CO₂ in band is not defined — no CO₂ sensor is installed on this "
        "estate (source: CCEI spec §3.3)"
    )


def test_an_undocumented_undefined_component_falls_back_to_the_bare_fact():
    """The fallback must still be a sentence, and must still name the key."""
    reason = ev._undefined_reason({}, "iaq_co2", at(1))
    assert "no metric `iaq_co2` is effective" in reason


# ── the happy path, enough of it to show the guards are not firing ───────────


_EPI_DEFN = {
    "kind": "formula",
    "formula": "kwh / area",
    "guards": ["units_confirmed"],
    "inputs": {
        "kwh": {"role": "energy_total", "unit": "kWh", "aggregation": "sum"},
        "area": {"role": "area_m2", "unit": "m2", "aggregation": "last"},
    },
    "output": {"unit": "kWh/m2", "dimension": "energy_per_area"},
}


def _bucket(n: int, day: int, **cols):
    row = {"point_id": pid(n), "bucket": at(day), "num_avg": None, "num_min": None,
           "num_max": None, "num_sum": None, "num_first": None, "num_last": None}
    row.update(cols)
    return row


def test_good_data_produces_a_value_its_unit_and_the_working_behind_it():
    """The counterweight to every refusal above: on confirmed units, moving
    inputs and present data, no guard fires and the number arrives with its
    provenance — which point, which aggregate, how many samples."""
    db = FakeDb(
        device_roles=[
            point(1, role="energy_total", tag="MAIN-KWH", unit="kWh"),
            point(2, role="area_m2", tag="AREA", unit="m2"),
        ],
        aggs=[
            agg(1, total=500.0, avg=5.0, lo=1.0, hi=9.0, buckets=100, samples=100),
            agg(2, last=250.0, avg=250.0, buckets=100, samples=100),
        ],
        buckets=[],
    )
    out = run(ev._evaluate_formula(db, None, _EPI_DEFN, pid(1), at(1), at(11), "readings_1h"))
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(2.0)
    assert out["unit"] == "kWh/m2"
    assert out["arithmetic"] == "kwh / area = 500 ÷ 250 = 2"
    by_name = {i["input"]: i for i in out["inputs"]}
    assert by_name["kwh"]["point_tag"] == "MAIN-KWH"
    assert by_name["kwh"]["aggregation"] == "sum"
    assert by_name["kwh"]["samples"] == 100


def test_a_bucket_where_only_one_input_reported_produces_no_point_in_the_series():
    """Inner alignment. On a ΔT, a bucket built from one side and a fabricated
    zero for the other reads as a critical plant fault."""
    db = FakeDb(
        buckets=[
            _bucket(1, 1, num_sum=100.0), _bucket(2, 1, num_last=50.0),   # both
            _bucket(1, 2, num_sum=100.0),                                  # kwh only
            _bucket(1, 3, num_sum=100.0), _bucket(2, 3, num_last=None),   # null side
            _bucket(1, 4, num_sum=100.0), _bucket(2, 4, num_last=0.0),    # /0
        ],
    )
    bound = {
        "kwh": point(1, role="energy_total", unit="kWh"),
        "area": point(2, role="area_m2", unit="m2"),
    }
    series = run(ev._series(db, None, _EPI_DEFN, bound, at(1), at(11), "readings_1h", 10.0))
    assert [p["t"] for p in series] == [at(1)]
    assert series[0]["value"] == pytest.approx(2.0)


# ── band occupancy: the coverage gate, and why it is not a percentage ────────


_BAND_DEFN = {
    "kind": "occupancy",
    "formula": "in_band(owt - iwt, 5, 7)",
    "guards": [],
    "inputs": {
        "owt": {"role": "chw_return_temp", "unit": "degC"},
        "iwt": {"role": "chw_supply_temp", "unit": "degC"},
    },
    "output": {"unit": "%", "dimension": "dimensionless"},
}


def _band_db(buckets, union):
    return FakeDb(
        device_roles=[
            point(1, role="chw_return_temp", tag="CHWR", unit="degC"),
            point(2, role="chw_supply_temp", tag="CHWS", unit="degC"),
        ],
        aggs=[agg(1, avg=13.0, lo=12.0, hi=14.0), agg(2, avg=7.0, lo=6.0, hi=8.0)],
        buckets=buckets,
        union_buckets=[{"buckets": union}],
    )


def _pair(day, owt, iwt):
    return [_bucket(1, day, num_avg=owt), _bucket(2, day, num_avg=iwt)]


def _run_band(buckets, union):
    return run(ev._evaluate_occupancy(
        _band_db(buckets, union), None, _BAND_DEFN, pid(1), at(1), at(11), "readings_1h"
    ))


def test_band_occupancy_is_the_mean_of_per_bucket_membership_not_one_test_of_the_mean():
    """The whole reason this kind exists: an average ΔT of 6 K sits inside a 5–7
    band even when the instantaneous ΔT was outside it half the time. Testing
    the aggregate once would answer 100%; the honest answer is the fraction of
    buckets."""
    buckets = _pair(1, 13.0, 7.0) + _pair(2, 20.0, 7.0) + _pair(3, 12.5, 7.0)
    out = _run_band(buckets, union=3)
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(200.0 / 3.0)
    assert (out["buckets_in_band"], out["buckets_valid"]) == (2, 3)


def test_a_window_where_the_inputs_rarely_reported_together_withholds_the_percentage():
    """Spec §7. Two of ten buckets with both inputs alive is a 20% sample, and
    "100% in band" computed from it is a claim about the window that the window
    cannot support. The refusal states both counts, so the number is auditable."""
    buckets = _pair(1, 13.0, 7.0) + _pair(2, 13.0, 7.0)
    out = _run_band(buckets, union=10)
    assert out["status"] == "insufficient_coverage"
    assert "only 2 of 10 bucket(s)" in out["reason"]
    assert "20%" in out["reason"]
    assert "80%" in out["reason"]
    assert out["coverage"] == 0.2
    assert out["inputs"] is not None


def test_coverage_exactly_at_the_gate_is_scored_not_withheld():
    """80% is the threshold the metric IS scored at; an exclusive comparison
    would withhold the boundary case the spec explicitly allows."""
    buckets = sum((_pair(d, 13.0, 7.0) for d in range(1, 5)), [])
    out = _run_band(buckets, union=5)
    assert out["status"] == "ok"
    assert out["coverage"] == 0.8


def test_no_bucket_with_every_input_reporting_is_absence_not_zero_percent():
    """A ΔT needs both ends. Reporting 0% in band for a window where the pair
    never reported together would read as a plant fault instead of a gap."""
    buckets = [_bucket(1, 1, num_avg=13.0), _bucket(2, 2, num_avg=7.0)]
    out = _run_band(buckets, union=2)
    assert out["status"] == "no_data"
    assert "no valid minutes" in out["reason"]
