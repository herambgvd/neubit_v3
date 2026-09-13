"""What the expression layer does at EVALUATION time, and what it refuses to do.

`test_metric_expr_normalization.py` proves the normalization functions are the
CCEI spec's. This file covers the other half of `metric_registry.expr`: the
arithmetic walk itself, and the three places it must produce a structured
refusal instead of a number — a zero divisor, an `annualize()` with no window,
and a `benchmark_score()` with no resolved standard. Each of those has exactly
one honest answer and several plausible dishonest ones (inf, nan, 0, "assume a
year", "assume the national band table"), and nothing else in the suite would
notice if one of them were chosen.

It also pins the dimension arithmetic at the two points an operator would feel:
a kWh cannot be added to a mass of CO2, and the unit that comes out of a
formula is the one the formula's own algebra produced, not the one somebody
declared.
"""

from __future__ import annotations

import math

import pytest

from app.metric_registry import expr
from app.metric_registry.units import DimensionError, qty_of_unit


def ev(formula: str, env=None, **kw) -> float:
    return expr.evaluate(expr.parse(formula), env or {}, **kw)


# ── division: the refusal that must never be an infinity ─────────────────────


def test_a_zero_divisor_refuses_instead_of_returning_an_infinity():
    """Python's float division by zero raises, and a `try: ... except: return 0`
    anywhere in this path would put a fabricated 0 on a dashboard. The contract
    is a `blocked` refusal that says which arithmetic failed."""
    with pytest.raises(expr.EvalRefusal) as exc:
        ev("kwh / area", {"kwh": 500.0, "area": 0.0})
    assert exc.value.status == "blocked"
    assert "division by zero" in exc.value.reason


def test_a_divisor_that_becomes_zero_deeper_in_the_formula_still_refuses():
    """The guard is on the evaluated divisor, not on a name being literally 0 —
    `owt - iwt` with both sides equal is the realistic way this happens."""
    with pytest.raises(expr.EvalRefusal) as exc:
        ev("load / (owt - iwt)", {"load": 90.0, "owt": 7.0, "iwt": 7.0})
    assert exc.value.status == "blocked"


def test_dividing_zero_by_something_is_a_number_not_a_refusal():
    """Only the DIVISOR is the problem. Refusing 0/x too would withhold a real,
    correct zero — the refusals are meant to be rare and specific."""
    assert ev("a / b", {"a": 0.0, "b": 4.0}) == 0.0


def test_an_input_with_no_value_refuses_by_name_rather_than_reading_as_zero():
    """A name the environment does not carry is a wiring mistake upstream; the
    refusal names it so the mistake is findable."""
    with pytest.raises(expr.EvalRefusal) as exc:
        ev("a + b", {"a": 1.0})
    assert exc.value.status == "blocked"
    assert "`b`" in exc.value.reason


# ── annualize(): the window it scales over is the one it was handed ──────────


def test_annualize_scales_by_the_window_it_was_given():
    """365/30, not 12, not 365/31 — a wrong factor here restates a month's
    consumption as an annual EPI and grades the site against a benchmark with
    it."""
    assert ev("annualize(kwh)", {"kwh": 300.0}, window_days=30.0) == pytest.approx(
        300.0 * 365.0 / 30.0
    )


def test_annualize_without_a_window_refuses_rather_than_assuming_a_year():
    """A missing window is not "×1". Both None and 0 are refusals, because the
    site path passes a COVERED span that can legitimately be zero."""
    for window in (None, 0.0, -3.0):
        with pytest.raises(expr.EvalRefusal) as exc:
            ev("annualize(kwh)", {"kwh": 300.0}, window_days=window)
        assert exc.value.status == "blocked"
        assert "annualize()" in exc.value.reason


def test_annualize_scales_the_sub_expression_it_wraps_not_the_whole_formula():
    """`annualize(kwh) / area` and `annualize(kwh / area)` are the same number,
    but `annualize(kwh) / area` must not annualise the area away."""
    a = ev("annualize(kwh) / area", {"kwh": 300.0, "area": 100.0}, window_days=30.0)
    b = ev("annualize(kwh / area)", {"kwh": 300.0, "area": 100.0}, window_days=30.0)
    assert a == pytest.approx(b) == pytest.approx(3.0 * 365.0 / 30.0)


# ── band_score(): the shape, at every edge ───────────────────────────────────


@pytest.mark.parametrize(
    "v, expected",
    [
        (-1.0, 0.0),     # a negative reading scores 0, never a mirrored score
        (0.0, 0.0),
        (2.5, 50.0),     # linear 0 → lo
        (5.0, 100.0),    # the lower edge is INSIDE the band
        (6.0, 100.0),
        (7.0, 100.0),    # the upper edge is INSIDE the band
        (10.5, 50.0),    # linear hi → 2·hi
        (14.0, 0.0),     # twice hi is the zero
        (20.0, 0.0),     # and nothing beyond it goes negative
    ],
)
def test_band_score_is_flat_inside_the_band_and_falls_off_both_sides(v, expected):
    """The score's shape is the whole of what it means. An exclusive edge, a
    missing clamp or a symmetric-about-lo slope each produce a plausible number
    that grades the estate wrongly and nothing would flag."""
    assert ev("band_score(x, 5, 7)", {"x": v}) == pytest.approx(expected)


# ── benchmark_score(): edges are DATA, and their absence is a refusal ────────


def test_benchmark_score_with_no_resolved_standard_refuses_by_that_name():
    """The evaluator normally refuses earlier with the missing input named; this
    is the backstop that keeps a formula from scoring against nothing. The
    status must be `no_benchmark`, not `blocked` — they send an operator to two
    different screens."""
    with pytest.raises(expr.EvalRefusal) as exc:
        ev("benchmark_score(epi)", {"epi": 120.0})
    assert exc.value.status == "no_benchmark"


@pytest.mark.parametrize(
    "epi, expected",
    [
        (40.0, 100.0),   # better than the best edge is still 100, not >100
        (70.0, 100.0),
        (110.0, 50.0),   # linear between the edges
        (150.0, 0.0),
        (400.0, 0.0),    # worse than the worst edge is 0, never negative
    ],
)
def test_benchmark_score_maps_best_to_100_worst_to_0_and_clamps_outside(epi, expected):
    """Lower EPI is better, so `best` is the SMALLER edge. A flipped comparison
    scores every efficient building zero and every wasteful one a hundred."""
    got = ev(
        "benchmark_score(epi)", {"epi": epi},
        benchmark={"best": 70.0, "worst": 150.0},
    )
    assert got == pytest.approx(expected)


# ── the working an operator reads ────────────────────────────────────────────


def test_render_substitutes_the_numbers_that_were_actually_used():
    """`arithmetic` is the audit trail for a number on a screen. If it renders
    the formula rather than the values, a wrong input is invisible."""
    tree = expr.parse("kwh / area")
    assert expr.render(tree, {"kwh": 500.0, "area": 250.0}) == "500 ÷ 250"


def test_render_marks_an_input_it_has_no_value_for_rather_than_printing_none():
    tree = expr.parse("a + b")
    assert expr.render(tree, {"a": 1.0}) == "1 + ?"


def test_uses_answers_for_the_function_asked_about_only():
    """The evaluator branches on `uses()` to decide whether to resolve a
    benchmark at all — a false positive costs three queries per site, a false
    negative loses the refusal that names the missing standard."""
    tree = expr.parse("annualize(kwh) / area")
    assert expr.uses(tree, "annualize") is True
    assert expr.uses(tree, "benchmark_score") is False
    assert expr.names(tree) == {"kwh", "area"}


# ── unit algebra, at the two points an operator would feel it ────────────────


def test_energy_cannot_be_added_to_a_mass_of_carbon():
    """kWh + kgCO2e is the archetype of a formula that runs fine and means
    nothing. It is refused at REGISTRATION, naming both dimensions."""
    tree = expr.parse("kwh + co2")
    with pytest.raises(DimensionError) as exc:
        expr.infer(tree, {"kwh": qty_of_unit("kWh"), "co2": qty_of_unit("kgCO2")})
    assert "energy" in str(exc.value) and "mass" in str(exc.value)


def test_the_result_unit_is_the_one_the_formula_computes():
    """kWh ÷ m² is an EPI in kWh/m². Nothing here trusts the declared output —
    the algebra produces the unit and registration compares the two."""
    got = expr.infer(
        expr.parse("annualize(kwh) / area"),
        {"kwh": qty_of_unit("kWh"), "area": qty_of_unit("m2")},
    )
    assert (got.dimension, got.unit) == ("energy_per_area", "kWh/m2")


def test_a_score_carries_no_unit_however_it_was_computed():
    """A 0-100 score of an EPI is not an EPI. If the score kept kWh/m², a
    composite could add it to a temperature."""
    got = expr.infer(
        expr.parse("benchmark_score(epi)"),
        {"epi": expr.infer(
            expr.parse("kwh / area"),
            {"kwh": qty_of_unit("kWh"), "area": qty_of_unit("m2")},
        )},
    )
    assert got.dimension == "dimensionless"


def test_two_absolute_temperatures_in_different_units_refuse_to_subtract():
    """°C − °F is the silent-conversion trap this platform does not model; it is
    refused with the refusal saying so, not quietly treated as kelvin."""
    with pytest.raises(DimensionError) as exc:
        expr.infer(
            expr.parse("owt - iwt"),
            {"owt": qty_of_unit("degC"), "iwt": qty_of_unit("degF")},
        )
    assert "conversion is not modelled" in str(exc.value)


def test_nothing_in_the_language_can_produce_a_nan_or_an_infinity():
    """The whole refusal design rests on this: there is no operator or function
    here whose result is unbounded, so a non-finite number on a screen would
    have to have come from an input, not from the arithmetic."""
    got = ev(
        "band_score(a, 1, 2) + norm_down(b, 1, 9) - annualize(c) / d",
        {"a": 1e9, "b": -1e9, "c": 1e6, "d": 1e-6},
        window_days=1.0,
    )
    assert math.isfinite(got)
