"""The seeded CCEI v2 pack, checked against the registry's own rules and the spec.

Migration 0018 writes rows with raw SQL, which bypasses `registry.typecheck` —
the check that every definition written through the API must pass. A seed that
could not be registered through the front door would be a definition the
platform cannot reason about, so it is checked HERE instead, from the same
`reporting.ccei_spec` pack the migration inserts. One copy of the definition,
two readers.

The weights are asserted against the spec directly. They are the part a
well-meaning edit is most likely to "clean up" — and a weight set that no longer
sums to 1 does not fail loudly; it just quietly scores every site low.
"""

from __future__ import annotations

import pytest

from app.metric_registry import registry
from reporting.ccei_spec import (
    CCEI_KEY,
    CCEI_VERSION,
    LEAVES,
    SUB_INDICES,
    definitions,
)


def _by_key() -> dict:
    return {d["key"]: d for d in definitions()}


def test_every_seeded_row_passes_the_registry_typecheck():
    """A seeded row must be one the API would have accepted."""
    for d in definitions():
        registry.typecheck(d)


def test_the_composite_is_the_spec_s_composite():
    """§2: CCEI = 0.35·EEI + 0.25·OPI + 0.20·CPI + 0.20·CCI."""
    ccei = _by_key()[CCEI_KEY]
    assert ccei["version"] == CCEI_VERSION
    assert {c["metric"]: c["weight"] for c in ccei["components"]} == {
        "eei": 0.35, "opi": 0.25, "cpi": 0.20, "cci": 0.20,
    }


@pytest.mark.parametrize(
    "key, expected",
    [
        ("eei", {"plant_kw_per_tr": 0.40, "chw_delta_t_in_band": 0.25,
                 "economizer_capture": 0.20, "consumption_vs_baseline": 0.15}),
        ("opi", {"equipment_uptime": 0.35, "alarm_mtta": 0.20,
                 "alarm_mttr": 0.20, "automation_success": 0.25}),
        ("cpi", {"carbon_intensity": 0.50, "avoided_emissions": 0.30,
                 "clean_energy_share": 0.20}),
        ("cci", {"temp_in_band": 0.40, "co2_in_band": 0.35,
                 "humidity_in_band": 0.25}),
    ],
)
def test_sub_index_component_weights_are_the_spec_s(key, expected):
    """§4.1–§4.4, component tables."""
    row = _by_key()[key]
    assert {c["metric"]: c["weight"] for c in row["components"]} == expected


def test_every_weight_set_sums_to_one():
    """§3.4: `SubIndex = Σ(wᵢ · scoreᵢ) with Σ wᵢ = 1`. A set that sums to less
    does not fail — it scores every site low, forever, and looks like a fleet in
    poor shape rather than a spec typo."""
    for key, sub in SUB_INDICES.items():
        assert sum(w for _, w in sub["components"]) == pytest.approx(1.0), key
    assert sum(s["weight_in_ccei"] for s in SUB_INDICES.values()) == pytest.approx(1.0)


def test_all_fourteen_components_are_named_exactly_once():
    """Every leaf the spec lists is claimed by exactly one sub-index, and every
    leaf named by a sub-index has an entry describing it."""
    named = [m for s in SUB_INDICES.values() for m, _ in s["components"]]
    assert len(named) == 14
    assert len(set(named)) == 14, "a component is claimed by two sub-indices"
    assert set(named) == set(LEAVES)


def test_no_leaf_is_seeded_as_a_definition():
    """The refusal IS the deliverable. Seeding a leaf that cannot be measured —
    as a stub, a zero, or a redistributed weight — turns "we cannot measure this"
    into a number, which is the one thing this registry exists to prevent."""
    seeded = set(_by_key())
    assert seeded == {"ccei", "eei", "opi", "cpi", "cci"}
    assert not (seeded & set(LEAVES))


def test_every_leaf_says_what_blocks_it():
    """A named gap with no reason is a dead end for whoever has to close it."""
    for key, leaf in LEAVES.items():
        assert leaf.get("blocked_by"), key
        assert leaf.get("source"), key
        assert leaf["direction"] in ("higher", "lower"), key
        # a direction implies which bound the spec states
        if leaf["direction"] == "higher":
            assert "floor" in leaf and "target" in leaf, key
        else:
            assert "worst" in leaf and "target" in leaf, key


def test_every_row_carries_the_citation():
    """A definition that cannot name its source is back to being invented."""
    for d in definitions():
        assert "CCEI" in d["display"]["citation"]
        assert "Version 1.0" in d["display"]["citation"]
