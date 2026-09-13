"""Site scope: the register arithmetic, and the order the refusals come in.

WHY THIS FILE EXISTS. `last − first` per register is the one piece of
arithmetic in this system that can be WRONG rather than absent: a meter that
rolls over, is replaced, or is swapped for a smaller register all read as a
negative delta, and an `abs()` anywhere on this path invents a consumption out
of a reset. The same window read from a dead meter gives a real zero, which
scores in the BEST benchmark band — so a zero has to be refused too, and for
its own reason, because a dead meter and an absent one are different jobs.

The second thing pinned here is ORDER. A site EPI has measured inputs, site
facts, a grid emission factor and a benchmark standard, and each can be
missing. The refusal an operator gets must be the gap they can act on, which
means the measurements resolve first and the benchmark is not even looked up
until they have. `FakeDb` fails on any query a test did not script, so a
lookup that happens too early fails here instead of costing three queries per
site and reporting the wrong missing thing.

Nothing here needs a database: every function under test is handed rows.
"""

from __future__ import annotations

import pytest
from metric_fakes import FakeDb, agg, at, pid, point, run

from app.metric_registry import evaluator as ev


# ── one register over one window ─────────────────────────────────────────────


def test_a_register_with_no_bucket_in_the_window_contributes_nothing_and_says_so():
    """Reported rather than absorbed: a consumption that silently skipped a
    register would be indistinguishable from one where every register reported."""
    row = ev._register_delta(point(1, role="energy_total", tag="MAIN"), None)
    assert row["status"] == "no_data"
    assert row["reason"] == "no bucket in this window"
    assert row["point_tag"] == "MAIN"


def test_a_register_whose_endpoints_are_null_is_also_no_data():
    """A bucket can exist with no numeric sample in it. `float(None)` would be a
    TypeError and a 500 where the honest answer is "no reading"."""
    row = ev._register_delta(point(1, role="energy_total"), agg(1, first=None, last=None))
    assert row["status"] == "no_data"


def test_a_meter_that_reset_to_zero_mid_window_is_excluded_and_named():
    """This is the case an `abs()` would turn into a gigantic fake consumption.
    The delta is negative, so the register is dropped from the sum AND reported
    with both endpoints, because a reset is a thing somebody has to know about."""
    row = ev._register_delta(
        point(1, role="energy_total", tag="MAIN"),
        agg(1, first=980000.0, last=1200.0, buckets=100),
    )
    assert row["status"] == "register_decreased"
    assert (row["first"], row["last"]) == (980000.0, 1200.0)
    assert "delta" not in row
    assert "no consumption can be derived" in row["reason"]


def test_a_register_that_merely_went_backwards_refuses_the_same_way():
    """A replaced meter reading lower than the old one is the same situation and
    gets the same status — one wrong number is not made right by being small."""
    row = ev._register_delta(
        point(1, role="energy_total"), agg(1, first=500.0, last=499.0, buckets=100)
    )
    assert row["status"] == "register_decreased"


def test_a_register_that_held_one_value_across_the_window_is_frozen_not_zero():
    """A consumption of 0 kWh scores in the best benchmark band. A meter that
    has stopped moving must not be graded as a perfectly efficient building."""
    row = ev._register_delta(
        point(1, role="energy_total", tag="MAIN"),
        agg(1, first=1000.0, last=1000.0, buckets=48),
    )
    assert row["status"] == "register_frozen"
    assert row["buckets"] == 48
    assert "stopped moving" in row["reason"]


def test_a_single_bucket_window_is_not_evidence_that_a_meter_stopped():
    """With one bucket, first == last is arithmetic, not a diagnosis. Calling it
    frozen would refuse every window short enough to hold a single bucket."""
    row = ev._register_delta(
        point(1, role="energy_total"), agg(1, first=1000.0, last=1000.0, buckets=1)
    )
    assert row["status"] == "ok"
    assert row["delta"] == 0.0


def test_a_register_that_advanced_contributes_its_difference():
    row = ev._register_delta(
        point(1, role="energy_total"), agg(1, first=1000.0, last=1500.0, buckets=100)
    )
    assert (row["status"], row["delta"]) == ("ok", 500.0)


# ── when no register produced a delta ────────────────────────────────────────


def test_every_register_frozen_refuses_as_undefined_not_as_missing_data():
    """Two refusals, two destinations: `undefined_frozen` sends someone to the
    plant, `no_data` sends them to the pipeline. Merging them loses that."""
    registers = [
        {"status": "register_frozen", "point_tag": "M1"},
        {"status": "register_frozen", "point_tag": "M2"},
    ]
    out = ev._refuse_unusable_registers("kwh", "energy_total", [1, 2], registers)
    assert out["status"] == "undefined_frozen"
    assert "the meters have stopped moving" in out["reason"]
    assert out["registers"] == registers


def test_a_mix_of_frozen_and_absent_registers_refuses_as_no_data():
    """Only "every register is frozen" supports the stronger claim. One absent
    register means the window genuinely has no usable evidence."""
    out = ev._refuse_unusable_registers(
        "kwh", "energy_total", [1, 2],
        [{"status": "register_frozen"}, {"status": "no_data"}],
    )
    assert out["status"] == "no_data"
    assert "produced a usable delta" in out["reason"]


# ── the role's registers, summed ─────────────────────────────────────────────


_KWH_SPEC = {"role": "energy_total", "unit": "kWh", "aggregation": "consumption"}


def test_consumption_sums_the_usable_registers_and_still_reports_the_reset_one():
    """The sum must exclude the reset register — and the report must not, or the
    number looks like a complete reading of the site when it is not."""
    candidates = [
        point(1, role="energy_total", tag="M1"),
        point(2, role="energy_total", tag="M2"),
        point(3, role="energy_total", tag="M3"),
    ]
    db = FakeDb(aggs=[
        agg(1, first=1000.0, last=1400.0, buckets=100),
        agg(2, first=200.0, last=300.0, buckets=100),
        agg(3, first=90000.0, last=5.0, buckets=100),   # reset mid-window
    ])
    out = run(ev._consumption_input(db, None, "kwh", _KWH_SPEC, candidates,
                                    at(1), at(31), "readings_1h"))
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(500.0)
    by_tag = {r["point_tag"]: r for r in out["report"]["registers"]}
    assert by_tag["M3"]["status"] == "register_decreased"
    assert set(by_tag) == {"M1", "M2", "M3"}


def test_the_covered_span_is_what_the_usable_registers_actually_span():
    """Not the requested window. `annualize()` scales over this, so a 10-day
    span inside a 30-day request must annualise by 365/10 — reading the request
    instead would under-report an annual EPI by a factor of three."""
    db = FakeDb(aggs=[
        agg(1, first=0.0, last=100.0, first_bucket=at(3), last_bucket=at(13)),
        agg(2, first=0.0, last=100.0, first_bucket=at(5), last_bucket=at(9)),
    ])
    out = run(ev._consumption_input(
        db, None, "kwh", _KWH_SPEC,
        [point(1, role="energy_total"), point(2, role="energy_total")],
        at(1), at(31), "readings_1h",
    ))
    assert out["days_covered"] == pytest.approx(10.0)


def test_consumption_with_no_usable_register_refuses_and_carries_every_register():
    db = FakeDb(aggs=[agg(1, first=7.0, last=7.0, buckets=50)])
    out = run(ev._consumption_input(
        db, None, "kwh", _KWH_SPEC, [point(1, role="energy_total", tag="M1")],
        at(1), at(31), "readings_1h",
    ))
    assert out["status"] == "undefined_frozen"
    assert out["registers"][0]["point_tag"] == "M1"


def test_a_non_consumption_aggregation_needs_exactly_one_point_in_the_role():
    """Summing two registers is `consumption`'s job and only its. Averaging two
    points confirmed in one role would answer a question nobody asked, and the
    refusal says which aggregation does sum."""
    out = run(ev._single_point_input(
        FakeDb(), None, "kw", {"role": "power_total", "aggregation": "avg"},
        [point(1, role="power_total", tag="M1"), point(2, role="power_total", tag="M2")],
        at(1), at(31), "readings_1h",
    ))
    assert out["status"] == "ambiguous_role"
    assert "M1" in out["reason"] and "M2" in out["reason"]
    assert "`consumption` is the" in out["reason"]


def test_no_point_at_the_site_in_the_role_refuses_naming_the_site_scope():
    """The device-scope sentence says "on this device"; this one must say "at
    this site", or a site metric sends an operator hunting on one device."""
    out = run(ev._role_points_input(
        FakeDb(), None, "kwh", _KWH_SPEC, [], {}, at(1), at(31), "readings_1h"
    ))
    assert out["status"] == "missing_role"
    assert "at this site" in out["reason"]


def test_an_unconfirmed_unit_on_any_register_in_the_role_refuses_the_input():
    """One of three registers on an assumed unit is enough to make the SUM
    wrong, so the guard is over the whole role, not over a chosen point."""
    out = run(ev._role_points_input(
        FakeDb(), None, "kwh", _KWH_SPEC, ["units_confirmed"],
        {"energy_total": [
            point(1, role="energy_total", tag="M1"),
            point(2, role="energy_total", tag="M2", unit_source="inferred"),
        ]},
        at(1), at(31), "readings_1h",
    ))
    assert out["status"] == "unit_unconfirmed"
    assert "`M2`" in out["reason"] and "M1" not in out["reason"]


# ── site facts and the emission factor ───────────────────────────────────────


def test_an_unrecorded_site_fact_names_the_fact_and_where_it_is_recorded():
    """"missing_fact" is a config job, and the operator needs the screen name —
    this is the difference between a fixable dash and a mysterious one."""
    out = ev._site_fact_input(
        {"site_id": pid(1), "gross_floor_area_sqm": None},
        "area", {"source": "site_fact", "fact": "gross_floor_area_sqm"},
    )
    assert out["status"] == "missing_fact"
    assert "Gross floor area" in out["reason"]
    assert "Configurations → Sites → Building" in out["reason"]
    assert "nothing is defaulted or estimated" in out["reason"]


def test_a_recorded_site_fact_is_used_as_the_number_it_is():
    out = ev._site_fact_input(
        {"site_id": pid(1), "gross_floor_area_sqm": 2500},
        "area", {"source": "site_fact", "fact": "gross_floor_area_sqm", "unit": "m2"},
    )
    assert (out["status"], out["value"]) == ("ok", 2500.0)
    assert out["report"]["unit"] == "m2"


def test_no_emission_factor_refuses_rather_than_assuming_a_national_average():
    """A national average is defensible — but it is a value somebody must choose
    and cite. The refusal has to say so, or the next person adds a constant."""
    out = run(ev._emission_factor_input(FakeDb(factor=[]), None, pid(1), "ef", at(31)))
    assert out["status"] == "missing_factor"
    assert "2026-03-31" in out["reason"]
    assert "not one this metric may assume" in out["reason"]


def test_the_emission_factor_travels_with_the_citation_it_was_entered_under():
    """A carbon number on a screen must be traceable to the document it came
    from. Dropping `source` makes a cited factor look like a typed constant."""
    out = run(ev._emission_factor_input(
        FakeDb(factor=[{"kg_co2_per_kwh": 0.71, "effective_from": at(1).date(),
                        "source": "CEA CO2 Baseline Database v19"}]),
        None, pid(1), "ef", at(31),
    ))
    assert out["value"] == pytest.approx(0.71)
    assert out["report"]["factor_source"] == "CEA CO2 Baseline Database v19"
    assert out["report"]["unit"] == "kgCO2/kWh"


# ── a whole site formula, and the order it refuses in ────────────────────────


_SITE_EPI = {
    "kind": "formula",
    "formula": "annualize(kwh) / area",
    "guards": ["units_confirmed"],
    "inputs": {
        "kwh": {"role": "energy_total", "unit": "kWh", "aggregation": "consumption"},
        "area": {"source": "site_fact", "fact": "gross_floor_area_sqm", "unit": "m2"},
    },
    "output": {"unit": "kWh/m2", "dimension": "energy_per_area"},
    "applies_to": {"scope": "site"},
}

_GRADED_EPI = dict(_SITE_EPI, formula="benchmark_score(annualize(kwh) / area)",
                   output={"unit": "", "dimension": "dimensionless"})

_SITE = {"site_id": pid(9), "site_name": "HQ", "gross_floor_area_sqm": 250}


def _epi_db(**over):
    script = {
        "site_roles": [point(1, role="energy_total", tag="MAIN-KWH", unit="kWh")],
        "aggs": [agg(1, first=1000.0, last=1500.0, buckets=240,
                     first_bucket=at(1), last_bucket=at(11))],
    }
    script.update(over)
    return FakeDb(**script)


def test_a_site_formula_annualises_over_the_covered_span_not_the_asked_window():
    """The §21 rule, and the one number `/bi/rating` and the registry must agree
    on: 500 kWh over a 10-day covered span inside a 30-day request annualises to
    500 × 365/10, not 500 × 365/30."""
    out = run(ev._evaluate_site_formula(
        _epi_db(), None, _SITE_EPI, _SITE, at(1), at(31), "readings_1h"
    ))
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(500.0 * 365.0 / 10.0 / 250.0)
    assert out["unit"] == "kWh/m2"
    assert out["days_covered"] == pytest.approx(10.0)
    assert out["arithmetic"].startswith("annualize(kwh) / area = annualize(500) ÷ 250")


def test_a_covered_span_shorter_than_one_bucket_refuses_instead_of_annualising():
    """Dividing by a zero span is an infinite EPI. The refusal names the span as
    the problem rather than surfacing as a division-by-zero somewhere below."""
    db = _epi_db(aggs=[agg(1, first=1000.0, last=1500.0, buckets=1,
                           first_bucket=at(5), last_bucket=at(5))])
    out = run(ev._evaluate_site_formula(db, None, _SITE_EPI, _SITE, at(1), at(31), "readings_1h"))
    assert out["status"] == "no_data"
    assert "no interval to annualise over" in out["reason"]


# ── two consumption inputs, two covered spans ────────────────────────────────


_TWO_METER_EPI = {
    "kind": "formula",
    "formula": "annualize(main + sub)",
    "guards": [],
    "inputs": {
        "main": {"role": "energy_total", "unit": "kWh", "aggregation": "consumption"},
        "sub": {"role": "energy_sub", "unit": "kWh", "aggregation": "consumption"},
    },
    "output": {"unit": "kWh", "dimension": "energy"},
    "applies_to": {"scope": "site"},
}

_TWO_METERS = [point(1, role="energy_total", tag="MAIN"),
               point(2, role="energy_sub", tag="SUB")]


def _two_meter_db(sub_first, sub_last):
    return FakeDb(
        site_roles=_TWO_METERS,
        aggs=[
            agg(1, first=0.0, last=400.0, buckets=240,
                first_bucket=at(1), last_bucket=at(11)),
            agg(2, first=0.0, last=100.0, buckets=240,
                first_bucket=sub_first, last_bucket=sub_last),
        ],
    )


def test_two_consumption_inputs_over_different_spans_refuse_to_be_annualised():
    """There is no span to scale by. Whichever one is picked, the other input is
    annualised over a stretch it was not measured over — a sub-meter alive for
    two of the main meter's ten days would be multiplied by five. The old code
    picked the LAST input in declaration order, which made the answer depend on
    the order the inputs happen to be written in."""
    out = run(ev._evaluate_site_formula(
        _two_meter_db(at(9), at(11)), None, _TWO_METER_EPI, _SITE,
        at(1), at(31), "readings_1h",
    ))
    assert out["status"] == "blocked"
    assert out["value"] is None
    assert "`main` over 10 day(s)" in out["reason"]
    assert "`sub` over 2 day(s)" in out["reason"]
    # The refusal still shows what DID resolve, so the screen can say which
    # meter covered what rather than only that something disagreed.
    assert [i["input"] for i in out["inputs"]] == ["main", "sub"]


def test_two_consumption_inputs_over_the_same_span_annualise_over_it():
    """The refusal is about DISAGREEMENT, not about there being two meters. Two
    registers covering the same ten days have one honest span between them."""
    out = run(ev._evaluate_site_formula(
        _two_meter_db(at(1), at(11)), None, _TWO_METER_EPI, _SITE,
        at(1), at(31), "readings_1h",
    ))
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(500.0 * 365.0 / 10.0)
    assert out["days_covered"] == pytest.approx(10.0)


def test_disagreeing_spans_without_annualize_still_compute_and_report_no_span():
    """Nothing is scaled, so nothing is wrong: the sum of two registers is the
    sum of two registers whatever they cover. The top-level span is omitted
    rather than asserting one of them, and each input keeps its own."""
    defn = dict(_TWO_METER_EPI, formula="main + sub")
    out = run(ev._evaluate_site_formula(
        _two_meter_db(at(9), at(11)), None, defn, _SITE, at(1), at(31), "readings_1h",
    ))
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(500.0)
    assert "days_covered" not in out
    assert [i["days_covered"] for i in out["inputs"]] == [10.0, 2.0]


def test_a_missing_area_refuses_before_the_benchmark_is_ever_looked_up():
    """The actionable gap is the unrecorded area, not the standard. Resolving
    the benchmark first would report `no_benchmark` for a site whose real
    problem is a blank field — and would cost three queries to say so. The
    scripted session has no benchmark queries at all, so an early lookup fails
    here."""
    site = dict(_SITE, gross_floor_area_sqm=None)
    out = run(ev._evaluate_site_formula(
        _epi_db(), None, _GRADED_EPI, site, at(1), at(31), "readings_1h"
    ))
    assert out["status"] == "missing_fact"
    assert "gross_floor_area_sqm" in out["reason"]


def test_a_missing_role_refuses_before_the_benchmark_too_and_carries_no_value():
    out = run(ev._evaluate_site_formula(
        _epi_db(site_roles=[]), None, _GRADED_EPI, _SITE, at(1), at(31), "readings_1h"
    ))
    assert out["status"] == "missing_role"
    assert out["value"] is None


def test_a_site_whose_measurements_resolve_then_refuses_on_the_standard_itself():
    """Once the measurements are in, "against what standard?" is the next honest
    question — and its refusal keeps the resolved inputs attached so the screen
    can show what DID work."""
    db = _epi_db(bench_config=[], standard=[])
    out = run(ev._evaluate_site_formula(db, None, _GRADED_EPI, _SITE, at(1), at(31), "readings_1h"))
    assert out["status"] == "no_benchmark"
    assert "bee_star_office" in out["reason"]
    assert [i["input"] for i in out["inputs"]] == ["kwh", "area"]


# ── which benchmark, and what is missing from it ─────────────────────────────


_FIXED_STD = {
    "key": "bee_star_office", "version": "feb-2009", "title": "BEE Star Rating",
    "citation": "BEE, Star Rating for Office Buildings, Feb 2009",
    "source_url": None, "notes": None, "effective_from": None,
    "bands": {
        "kind": "fixed_ranges", "unit": "kWh/m2/yr",
        "zones": {"composite": {"label": "Composite", "over_50": [
            {"stars": 5, "min": None, "max": 90},
            {"stars": 4, "min": 90, "max": 110},
            {"stars": 1, "min": 110, "max": 200},
        ]}},
    },
}


def test_a_standard_that_is_not_seeded_refuses_naming_the_key_and_the_date():
    out = run(ev.resolve_benchmark(
        FakeDb(bench_config=[], standard=[]), None, pid(9), as_of=at(31)
    ))
    assert out["ok"] is False
    assert "`bee_star_office`" in out["reason"]
    assert "2026-03-31" in out["reason"]


def test_a_site_with_no_climate_zone_still_reports_the_standard_and_its_citation():
    """The regression this exists for: dropping the head on the refusal path
    made a cited, loaded standard look like no standard at all. "your standard
    is here, only the zone is missing" is a different screen."""
    out = run(ev.resolve_benchmark(
        FakeDb(bench_config=[{"site_id": pid(9), "standard_key": "bee_star_office",
                              "climate_zone": None, "ac_category": None}],
               standard=[_FIXED_STD]),
        None, pid(9), as_of=at(31),
    ))
    assert (out["ok"], out["missing"]) == (False, "climate_zone")
    assert out["standard"] == "bee_star_office"
    assert out["citation"] == _FIXED_STD["citation"]


def test_a_2009_site_with_no_ac_category_says_which_two_tables_it_cannot_pick():
    out = run(ev.resolve_benchmark(
        FakeDb(bench_config=[{"site_id": pid(9), "standard_key": "bee_star_office",
                              "climate_zone": "composite", "ac_category": None}],
               standard=[_FIXED_STD]),
        None, pid(9), as_of=at(31),
    ))
    assert (out["ok"], out["missing"]) == (False, "ac_category")
    assert ">50%" in out["reason"]


def test_a_2009_table_grades_between_its_five_star_and_one_star_edges():
    out = run(ev.resolve_benchmark(
        FakeDb(bench_config=[{"site_id": pid(9), "standard_key": "bee_star_office",
                              "climate_zone": "composite", "ac_category": "over_50"}],
               standard=[_FIXED_STD]),
        None, pid(9), as_of=at(31),
    ))
    assert out["ok"] is True
    assert (out["best"], out["worst"]) == (90.0, 200.0)


def test_a_2022_site_with_no_recorded_area_cannot_choose_a_size_table():
    """The 2022 equations are per size category, and the category is DERIVED
    from the area — so the refusal names the area, and prints the three ranges
    it would have chosen between."""
    out = run(ev.resolve_benchmark(
        FakeDb(bench_config=[{"site_id": pid(9), "standard_key": "bee_star_office",
                              "climate_zone": "composite", "ac_category": None}],
               standard=[dict(_FIXED_STD, version="jan-2022",
                              bands={"kind": "linear_by_ac_share", "zones": {}})],
               area=[]),
        None, pid(9), as_of=at(31),
    ))
    assert (out["ok"], out["missing"]) == (False, "gross_floor_area_sqm")
    assert "30,000 m²" in out["reason"]


def test_a_2022_site_with_an_area_but_no_ac_share_names_the_ac_share():
    """Two different unrecorded inputs, two different sentences — and the second
    one can only be asked once the first is answered."""
    out = run(ev.resolve_benchmark(
        FakeDb(bench_config=[{"site_id": pid(9), "standard_key": "bee_star_office",
                              "climate_zone": "composite", "ac_category": None}],
               standard=[dict(_FIXED_STD, version="jan-2022",
                              bands={"kind": "linear_by_ac_share", "zones": {}})],
               area=[{"gross_floor_area_sqm": 45000}]),
        None, pid(9), as_of=at(31),
    ))
    assert (out["ok"], out["missing"]) == (False, "ac_share_percent")
    assert out["size_category"] == "large"


@pytest.mark.parametrize(
    "area, expected",
    [(9999.0, "small"), (10000.0, "medium"), (30000.0, "medium"), (30001.0, "large")],
)
def test_the_size_category_is_derived_at_the_documents_own_boundaries(area, expected):
    """ECBC's ranges, with the inclusive edges the document's fees table implies.
    A boundary off by one puts a 30,000 m² office on the wrong equations."""
    assert ev.size_category_for(area) == expected


# The jan-2022 composite-zone LARGE coefficients, as seeded by migration 0017 —
# y = a·x + c per star, x = % of built-up area that is air-conditioned.
_LARGE_COMPOSITE = {
    "1": {"a": 0.95, "c": 60}, "2": {"a": 0.9, "c": 50}, "3": {"a": 0.85, "c": 40},
    "4": {"a": 0.8, "c": 30}, "5": {"a": 0.75, "c": 20},
}


def test_the_2022_equations_reproduce_the_documents_own_worked_example():
    """The document, verbatim: a building at 75% AC area with an EPI below
    131.25 but at or above 117.5 is 2-star. Those two numbers are the 1-star and
    2-star equations at x = 75, and they are the whole proof that the equations
    were transcribed the right way round."""
    table = {b["stars"]: b for b in ev.linear_band_table(_LARGE_COMPOSITE, 75)}
    assert table[1]["equation_value"] == pytest.approx(131.25)
    assert table[2]["equation_value"] == pytest.approx(117.5)


@pytest.mark.parametrize(
    "epi, stars",
    [(117.5, 2), (125.0, 2), (131.24, 2), (131.25, 1), (400.0, 1), (10.0, 5)],
)
def test_a_star_band_is_inclusive_below_and_exclusive_above(epi, stars):
    """The document's example again, as the band lookup sees it. An exclusive
    lower edge would drop a building sitting exactly on its equation one star,
    and the 1-star row must stay open above or the worst buildings get no band
    at all."""
    table = ev.linear_band_table(_LARGE_COMPOSITE, 75)
    assert ev._band_for(table, epi)["stars"] == stars


def test_a_2009_table_awards_no_band_above_its_worst_upper_bound():
    """Unlike 2022's, the fixed-range rows do not cover the whole line: above
    200 the scheme awards no star, and pretending the bottom band stretches
    forever would hand a 1-star rating to a building the scheme refuses to
    rate."""
    table = _FIXED_STD["bands"]["zones"]["composite"]["over_50"]
    assert ev._band_for(table, 199.0)["stars"] == 1
    assert ev._band_for(table, 201.0) is None
