"""The two CCEI leaves this estate can measure — their rules, not their luck.

Neither leaf can be proved against live data today: every chilled-water pair on
this estate is either moving or frozen depending on the chiller, and all three
kWh registers have been flat for the whole recorded history. So the arithmetic
is proved HERE, with numbers chosen so the expected answer comes from the spec's
own worked example rather than from whatever the plant happens to be doing.

What is checked is the part that would fail silently: the type rules that decide
whether a definition may exist at all. A registration error is loud; a metric
that registers and quietly means something else is not.
"""

from __future__ import annotations

import pytest

from app.metric_registry import expr, registry
from app.metric_registry.units import DimensionError, Qty, mul_div, qty_of_unit
from reporting.ccei_spec import LEAF_DEFINITIONS


# ── in_band: membership, not a score ─────────────────────────────────────────


@pytest.mark.parametrize(
    "x, expected",
    [(4.9, 0.0), (5.0, 1.0), (6.0, 1.0), (7.0, 1.0), (7.1, 0.0)],
)
def test_in_band_is_inclusive_of_both_edges(x, expected):
    """A ΔT of exactly 5 K is inside a 5–7 K band. An exclusive edge would quietly
    mark a plant running exactly on its design point as out of band."""
    assert expr.evaluate(expr.parse("in_band(x, 5, 7)"), {"x": x}) == expected


def test_a_ceiling_band_may_start_at_zero():
    """CO₂ < 1000 ppm is a real band with no lower bound. `band_score` needs a
    positive floor to have a shape; `in_band` does not, and refusing lo = 0
    would make three of the spec's comfort metrics inexpressible."""
    assert expr.evaluate(expr.parse("in_band(x, 0, 1000)"), {"x": 999}) == 1.0
    assert expr.evaluate(expr.parse("in_band(x, 0, 1000)"), {"x": 1001}) == 0.0


def test_an_inverted_band_is_a_registration_error_naming_the_range():
    with pytest.raises(expr.ExprError) as exc:
        expr.parse("in_band(x, 7, 5)")
    assert "0 <= lo < hi" in str(exc.value)


# ── the occupancy kind ───────────────────────────────────────────────────────


def _occupancy_defn(**over):
    d = dict(LEAF_DEFINITIONS["chw_delta_t_in_band"])
    d.update(over)
    return d


def test_the_delta_t_leaf_registers_as_seeded():
    registry.typecheck(LEAF_DEFINITIONS["chw_delta_t_in_band"])


def test_an_occupancy_formula_must_be_the_band_itself():
    """Otherwise the answer is "the fraction of buckets where some expression was
    non-zero", which is not what a reader of "% in band" is being told."""
    with pytest.raises(registry.RegistrationError) as exc:
        registry.typecheck(_occupancy_defn(formula="owt - iwt"))
    assert "in_band" in str(exc.value)


def test_occupancy_is_device_scope_only_and_says_so():
    """A site-scope occupancy would have to aggregate before testing the band —
    the exact mistake this kind exists to avoid. Refused by name, not by
    producing a plausible wrong percentage."""
    with pytest.raises(registry.RegistrationError) as exc:
        registry.typecheck(_occupancy_defn(applies_to={"scope": "site"}))
    assert "device-scope only" in str(exc.value)


def test_an_occupancy_metric_outputs_a_percentage_not_a_temperature():
    with pytest.raises(registry.RegistrationError):
        registry.typecheck(_occupancy_defn(output={"dimension": "temperature"}))


# ── emissions: the dimension that keeps a factor from being anything else ────


def test_energy_times_an_emission_factor_is_the_only_way_to_a_mass():
    got = mul_div("*", qty_of_unit("kWh"), qty_of_unit("kgCO2/kWh"))
    assert (got.dimension, got.unit) == ("mass", "kgCO2")
    per_area = mul_div("/", got, qty_of_unit("m2"))
    assert (per_area.dimension, per_area.unit) == ("mass_per_area", "kgCO2/m2")


@pytest.mark.parametrize(
    "op, a, b",
    [
        ("*", "kWh", "m2"),                  # energy × area is nothing
        ("*", "kgCO2/kWh", "degC"),          # a factor × a temperature is nothing
        ("/", "kgCO2/kWh", "m2"),            # a factor per square metre is nothing
    ],
)
def test_a_product_outside_the_table_is_refused_not_guessed(op, a, b):
    with pytest.raises(DimensionError):
        mul_div(op, qty_of_unit(a), qty_of_unit(b))


def test_an_emission_factor_is_not_a_tariff_or_a_mass():
    """Both are "a number per kWh" or "a number of kg" in someone's head. The
    type system is where that stops being true."""
    assert qty_of_unit("kgCO2/kWh").dimension == "emission_factor"
    assert qty_of_unit("kgCO2").dimension == "mass"
    with pytest.raises(DimensionError):
        mul_div("*", qty_of_unit("kgCO2/kWh"), qty_of_unit("kgCO2/kWh"))


# ── carbon intensity ─────────────────────────────────────────────────────────


def _carbon_defn(**over):
    d = dict(LEAF_DEFINITIONS["carbon_intensity"])
    d.update(over)
    return d


def test_the_carbon_leaf_registers_as_seeded():
    registry.typecheck(LEAF_DEFINITIONS["carbon_intensity"])


def test_the_emission_factor_input_is_site_scope_only():
    with pytest.raises(registry.RegistrationError) as exc:
        registry.typecheck(_carbon_defn(applies_to={"scope": "device"}))
    assert "scope = 'site'" in str(exc.value)


def test_an_emission_factor_input_takes_no_aggregation():
    """It is one dated, cited row for the window — not a series to average."""
    inputs = {k: dict(v) for k, v in LEAF_DEFINITIONS["carbon_intensity"]["inputs"].items()}
    inputs["factor"]["aggregation"] = "avg"
    with pytest.raises(registry.RegistrationError) as exc:
        registry.typecheck(_carbon_defn(inputs=inputs))
    assert "no aggregation" in str(exc.value)


def test_a_factor_declared_as_the_wrong_dimension_is_rejected():
    inputs = {k: dict(v) for k, v in LEAF_DEFINITIONS["carbon_intensity"]["inputs"].items()}
    inputs["factor"] = {"source": "emission_factor", "unit": "kWh"}
    with pytest.raises(registry.RegistrationError):
        registry.typecheck(_carbon_defn(inputs=inputs))


def test_carbon_intensity_reproduces_the_spec_s_own_worked_value():
    """§5 Step 3 scores a carbon intensity of 11.8 kg CO₂/m²/yr at 74.5.

    The inputs here are chosen to LAND on 11.8 so the assertion is the spec's
    number and not one derived from this formula by the same code that computes
    it: 664,788.7 kWh over a 365-day window, a 0.71 kg/kWh grid factor and a
    40,000 m² floor area give 664788.7 × 0.71 ÷ 40000 = 11.8.
    """
    tree = expr.parse(LEAF_DEFINITIONS["carbon_intensity"]["formula"])
    env = {"energy": 664788.7, "factor": 0.71, "area": 40000.0}
    assert expr.evaluate(tree, env, window_days=365.0) == pytest.approx(74.5, abs=0.05)


def test_a_shorter_window_is_annualized_not_extrapolated_silently():
    """The same consumption measured over half a year is half the annual figure
    only because `annualize` says so — and the call is IN the formula row, where
    a reader can see the scaling rather than infer it."""
    tree = expr.parse(LEAF_DEFINITIONS["carbon_intensity"]["formula"])
    env = {"energy": 664788.7 / 2, "factor": 0.71, "area": 40000.0}
    assert expr.evaluate(tree, env, window_days=182.5) == pytest.approx(74.5, abs=0.05)
    assert "annualize(" in LEAF_DEFINITIONS["carbon_intensity"]["formula"]


def test_a_site_at_or_better_than_target_scores_100_and_never_more():
    tree = expr.parse(LEAF_DEFINITIONS["carbon_intensity"]["formula"])
    # 2.0 kg CO2/m2/yr — far inside the 9.0 target
    env = {"energy": 112676.0, "factor": 0.71, "area": 40000.0}
    assert expr.evaluate(tree, env, window_days=365.0) == 100.0
