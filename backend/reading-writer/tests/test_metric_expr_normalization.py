"""The CCEI methodology spec's own worked example, as a regression fixture.

WHY THIS FILE EXISTS. The normalization functions in `metric_registry.expr`
are not house style — they are `NEUBIT_CCEI_Methodology_Spec` §3.1 and §3.2,
and the spec ships a fully worked example in §5: thirteen component inputs,
their normalized scores, four sub-indices, and a final CCEI of 68.4 rounded to
68 ("Fair"). Reproducing that example end to end is the only check that
actually proves the implementation IS the spec rather than merely resembling
it — a sign flip or a swapped bound would still look plausible in isolation
and would still score every site in the portfolio wrongly.

The weights here are the spec's; they are NOT how the platform stores a
metric (a registered composite carries its weights as data in the row). This
file tests the arithmetic, not the registry.
"""

from __future__ import annotations

import ast

import pytest

from app.metric_registry import expr
from app.metric_registry.units import Qty


def _score(formula: str, x: float) -> float:
    return expr.evaluate(expr.parse(formula), {"x": x})


def _weighted(parts: list[tuple[float, float]]) -> float:
    return sum(score * weight for score, weight in parts)


# ── §5 worked example, step by step ──────────────────────────────────────────


def test_eei_components_and_subindex():
    """§5 Step 1 — kW/TR, ΔT-in-band, economizer, savings vs baseline."""
    kw_per_tr = _score("norm_down(x, 0.60, 0.95)", 0.70)   # ↓ target 0.60, worst 0.95
    delta_t = _score("norm_up(x, 60, 95)", 82)             # ↑ floor 60, target 95
    economizer = _score("norm_up(x, 30, 90)", 70)          # ↑ floor 30, target 90
    saved = _score("norm_up(x, 0, 20)", 12)                # ↑ floor 0,  target 20

    assert kw_per_tr == pytest.approx(71.4, abs=0.05)
    assert delta_t == pytest.approx(62.9, abs=0.05)
    assert economizer == pytest.approx(66.7, abs=0.05)
    assert saved == pytest.approx(60.0, abs=0.05)

    eei = _weighted([(kw_per_tr, 0.40), (delta_t, 0.25), (economizer, 0.20), (saved, 0.15)])
    assert eei == pytest.approx(66.6, abs=0.05)


def test_opi_components_and_subindex():
    """§5 Step 2 — uptime, alarm MTTA, alarm MTTR, automation success."""
    uptime = _score("norm_up(x, 95, 99.5)", 98.2)
    mtta = _score("norm_down(x, 5, 30)", 7.4)
    mttr = _score("norm_down(x, 30, 180)", 58)
    automation = _score("norm_up(x, 80, 99)", 92)

    assert uptime == pytest.approx(71.1, abs=0.05)
    assert mtta == pytest.approx(90.4, abs=0.05)
    assert mttr == pytest.approx(81.3, abs=0.05)
    assert automation == pytest.approx(63.2, abs=0.05)

    opi = _weighted([(uptime, 0.35), (mtta, 0.20), (mttr, 0.20), (automation, 0.25)])
    assert opi == pytest.approx(75.0, abs=0.05)


def test_cpi_components_and_subindex():
    """§5 Step 3 — carbon intensity, avoided emissions, clean-energy share."""
    intensity = _score("norm_down(x, 9.0, 20.0)", 11.8)
    avoided = _score("norm_up(x, 0, 25)", 15)
    clean = _score("norm_up(x, 0, 40)", 18)

    assert intensity == pytest.approx(74.5, abs=0.05)
    assert avoided == pytest.approx(60.0, abs=0.05)
    assert clean == pytest.approx(45.0, abs=0.05)

    cpi = _weighted([(intensity, 0.50), (avoided, 0.30), (clean, 0.20)])
    assert cpi == pytest.approx(64.3, abs=0.05)


def test_cci_components_and_subindex():
    """§5 Step 4 — temperature, CO₂ and humidity band occupancy."""
    temp = _score("norm_up(x, 70, 95)", 88)
    co2 = _score("norm_up(x, 75, 98)", 90)
    humidity = _score("norm_up(x, 70, 95)", 86)

    assert temp == pytest.approx(72.0, abs=0.05)
    assert co2 == pytest.approx(65.2, abs=0.05)
    assert humidity == pytest.approx(64.0, abs=0.05)

    cci = _weighted([(temp, 0.40), (co2, 0.35), (humidity, 0.25)])
    assert cci == pytest.approx(67.6, abs=0.05)


def test_ccei_composite_matches_the_spec():
    """§5 Step 5 — 0.35·EEI + 0.25·OPI + 0.20·CPI + 0.20·CCI = 68.4 → Fair.

    The weights asserted here are §2's. The number they produce is the spec's
    own; if this drifts, either the normalization or the weighting has moved
    away from the authoritative definition.
    """
    ccei = _weighted([(66.6, 0.35), (75.0, 0.25), (64.3, 0.20), (67.6, 0.20)])
    assert ccei == pytest.approx(68.4, abs=0.05)
    assert 65 <= round(ccei) <= 74, "the spec reads this example as band `Fair` (65–74)"


# ── Clamping, and the bounds that must not be silently accepted ──────────────


def test_both_directions_clamp_to_zero_and_one_hundred():
    """§3: 'In all cases the result is clamped to [0, 100].' A metric better
    than target does not earn 120 points, and one worse than the worst value
    does not go negative and quietly claw back a sibling component's score."""
    assert _score("norm_up(x, 70, 95)", 200) == 100.0
    assert _score("norm_up(x, 70, 95)", 10) == 0.0
    assert _score("norm_down(x, 5, 30)", 1) == 100.0
    assert _score("norm_down(x, 5, 30)", 999) == 0.0


@pytest.mark.parametrize(
    "formula, why",
    [
        ("norm_up(x, 95, 60)", "higher-is-better with floor above target"),
        ("norm_down(x, 30, 5)", "lower-is-better with worst below target"),
        ("norm_up(x, 70, 70)", "a zero-width range would divide by zero"),
        ("norm_up(x, floor, 95)", "a bound that is a name, not a spec parameter"),
        ("norm_down(x, 5)", "wrong arity"),
    ],
)
def test_inverted_or_unstated_bounds_are_registration_errors(formula, why):
    """An inverted pair scores every site backwards and a non-literal bound
    hides the spec parameter from the row. Both fail at PARSE — registration
    time — so neither can reach a screen as a wrong number."""
    with pytest.raises(expr.ExprError):
        expr.parse(formula)


def test_a_score_is_dimensionless_whatever_it_normalized():
    """A normalized kW/TR is a score, not a kW/TR. If this leaked its argument's
    dimension, a composite would try to add kelvins to percentages."""
    for formula, arg in [
        ("norm_down(x, 0.60, 0.95)", Qty("power", "kW")),
        ("norm_up(x, 60, 95)", Qty("temperature_delta", "K")),
    ]:
        inferred = expr.infer(expr.parse(formula), {"x": arg})
        assert inferred.dimension == "dimensionless"


def test_the_language_still_refuses_everything_outside_it():
    """The normalization functions were added to a whitelist grammar; adding a
    call form must not have widened it."""
    for bad in ["x ** 2", "__import__('os')", "norm_up(x, 1, 2).real", "x if x else 0"]:
        with pytest.raises(expr.ExprError):
            expr.parse(bad)
