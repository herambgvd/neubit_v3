"""The building's facts record — asked only where something reads it.

  * WHICH facts are asked for is read from the metric definitions, the same
    effective-version rule as the plate facts and the reading roles; a
    platform-seeded definition is every tenant's;
  * `occupancy` and `city` are in the mirror and are NOT here — nothing reads
    them, and a box nobody's figure reads is not a box worth filling;
  * a fact on file carries where it came from and when it was recorded; an
    emission factor with no citation is an invented figure, so its source
    travels with it;
  * the benchmark is a SET of inputs and says for itself which one is unset —
    the live estate is missing `ac_share_percent`, which is why no star renders;
  * a fact nothing reads yet (the tariff) is still shown as recorded, with an
    empty `reads`, rather than being hidden or claimed to be doing work.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest

from app.api import building_facts as bf

FRAGMENTS = {
    "demands": "'site_fact', 'emission_factor'",
    "zones": "jsonb_object_keys",
    "facts": "FROM site_facts f",
    "factors": "FROM site_emission_factors e",
}


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


class Db:
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
                    raise AssertionError(f"the `{name}` query ran, which this test did not script")
                self.asked.append(name)
                return _Result(self.script[name])
        raise AssertionError(f"unrecognised statement: {sql[:160]}")


TENANT = uuid.uuid4()
SITE = uuid.uuid4()
RECORDED = dt.datetime(2026, 8, 31, 19, 26, tzinfo=dt.timezone.utc)

# As the live estate holds them: platform-seeded definitions, null tenant.
DEMANDS = [
    {"key": "carbon_intensity", "version": 1, "tenant_id": None, "source": "site_fact", "fact": "gross_floor_area_sqm"},
    {"key": "carbon_intensity", "version": 1, "tenant_id": None, "source": "emission_factor", "fact": None},
    {"key": "intensity_score", "version": 1, "tenant_id": None, "source": "site_fact", "fact": "gross_floor_area_sqm"},
]

FACTS_ROW = {
    "site_id": SITE, "site_name": "Aeon Tower", "gross_floor_area_sqm": 40000,
    "energy_tariff_per_kwh": 10, "tariff_currency": "INR", "occupancy": 1200,
    "facts_updated_at": RECORDED,
}
FACTOR_ROW = {
    "position": 0, "kg_co2_per_kwh": 0.716, "source": "CEA CO2 Baseline Database v20.0",
    "effective_from": dt.date(2025, 4, 1), "mirrored_at": RECORDED,
}

# What the resolver says on the live estate: the standard is loaded, the zone is
# set, and the January-2022 version wants the continuous AC share, which is not.
RESOLVED_MISSING_SHARE = {
    "ok": False, "missing": "ac_share_percent", "standard": "bee_star_office", "version": "jan-2022",
    "title": "BEE Star Rating of Commercial Buildings — Office Buildings",
    "citation": "Bureau of Energy Efficiency, Section 6", "zone": "warm_humid",
    "ac_category": "gt50pct_ac", "ac_share_percent": None, "size_category": "large",
    "reason": "`ac_share_percent` not recorded for this site",
}
RESOLVED_OK = {**RESOLVED_MISSING_SHARE, "ok": True, "missing": None, "ac_share_percent": 78.0,
               "reason": "loaded and set"}


@pytest.fixture
def resolver(monkeypatch):
    """`resolve_benchmark` is the evaluator's; this fixture scripts it."""
    state = {"value": RESOLVED_MISSING_SHARE}

    async def fake(db, tenant, site_id, *, as_of=None):
        return state["value"]

    from app.metric_registry import evaluator

    monkeypatch.setattr(evaluator, "resolve_benchmark", fake)
    return state


def run(db, **_):
    return asyncio.run(bf.building_facts(db, TENANT, SITE))


ZONE_ROWS = [{"zone": "warm_humid"}, {"zone": "composite"}, {"zone": "hot_dry"}]


def full_db(**over):
    return Db(
        demands=over.get("demands", DEMANDS),
        facts=over.get("facts", [FACTS_ROW]),
        factors=over.get("factors", []),
        zones=over.get("zones", ZONE_ROWS),
    )


# ── which facts are asked for ────────────────────────────────────────────────


def test_a_platform_seeded_definition_decides_what_is_asked():
    wanted = asyncio.run(bf.demands(Db(demands=DEMANDS), TENANT))
    assert wanted == {
        "gross_floor_area_sqm": {"carbon_intensity", "intensity_score"},
        "emission_factor": {"carbon_intensity"},
    }


def test_the_facts_nothing_reads_are_not_on_the_record(resolver):
    out = run(full_db())
    keys = {f["key"] for f in out["on_file"] + out["missing"]}
    # `occupancy` and `city` sit in the mirror and are asked for nowhere.
    assert keys == {"area", "tariff", "emission_factor", "benchmark"}


# ── what is on file ──────────────────────────────────────────────────────────


def test_an_area_on_file_names_what_divides_by_it(resolver):
    f = bf.area_fact(FACTS_ROW, {"carbon_intensity", "intensity_score"})
    assert (f["value"], f["unit"], f["recorded_at"]) == (40000.0, "m²", RECORDED)
    # The star bands read the building's SIZE off the same number.
    assert f["reads"] == ["bee_star_band", "carbon_intensity", "intensity_score"]


def test_a_fact_nothing_reads_yet_is_still_shown_as_recorded(resolver):
    out = run(full_db())
    tariff = next(f for f in out["on_file"] if f["key"] == "tariff")
    assert (tariff["value"], tariff["unit"]) == (10.0, "INR / kWh")
    # Honest: recorded, and nothing computes with it yet.
    assert tariff["reads"] == []


def test_an_emission_factor_carries_its_citation(resolver):
    f = bf.emission_fact([FACTOR_ROW], {"carbon_intensity"})
    assert f["value"] == 0.716
    assert f["source"] == "CEA CO2 Baseline Database v20.0"
    assert f["factors"][0]["effective_from"] == dt.date(2025, 4, 1)


def test_an_unrecorded_fact_is_never_rendered_as_zero(resolver):
    out = run(full_db(facts=[{**FACTS_ROW, "gross_floor_area_sqm": None, "facts_updated_at": RECORDED}]))
    area = next(f for f in out["missing"] if f["key"] == "area")
    assert area["value"] is None
    assert area["recorded_at"] is None


# ── what is waiting ──────────────────────────────────────────────────────────


def test_the_live_gaps_are_the_carbon_factor_and_the_ac_share(resolver):
    out = run(full_db())
    assert [f["key"] for f in out["missing"]] == ["emission_factor", "benchmark"]
    assert out["totals"] == {"on_file": 2, "missing": 2}
    bench = next(f for f in out["missing"] if f["key"] == "benchmark")
    assert bench["missing"] == "ac_share_percent"
    # What IS established still travels: the standard, its citation, the zone.
    assert (bench["climate_zone"], bench["version"]) == ("warm_humid", "jan-2022")
    assert bench["source"].startswith("Bureau of Energy Efficiency")


def test_a_carbon_factor_on_file_moves_to_the_record(resolver):
    out = run(full_db(factors=[FACTOR_ROW]))
    assert [f["key"] for f in out["missing"]] == ["benchmark"]
    assert {f["key"] for f in out["on_file"]} == {"area", "tariff", "emission_factor"}


def test_a_benchmark_with_every_input_set_is_on_file(resolver):
    resolver["value"] = RESOLVED_OK
    out = run(full_db(factors=[FACTOR_ROW]))
    assert out["missing"] == []
    bench = next(f for f in out["on_file"] if f["key"] == "benchmark")
    assert bench["ac_share_percent"] == 78.0


def test_the_star_rating_is_named_as_something_a_fact_blocks(resolver):
    out = run(full_db())
    bench = next(f for f in out["missing"] if f["key"] == "benchmark")
    assert bench["reads"] == [bf.STAR_BAND]


def test_the_zone_picker_offers_exactly_the_words_the_seeded_table_publishes(resolver):
    out = run(full_db())
    bench = next(f for f in out["missing"] if f["key"] == "benchmark")
    assert bench["zone_options"] == ["composite", "hot_dry", "warm_humid"]


def test_what_the_screen_does_not_ask_about_still_travels_so_a_put_cannot_clear_it(resolver):
    # Core's building-facts write REPLACES the set. `occupancy` is asked for
    # nowhere on this screen and must survive an edit of the area.
    out = run(full_db())
    assert out["carried"] == {"occupancy": 1200.0, "tariff_currency": "INR"}


def test_a_building_this_store_has_no_record_of_says_so(resolver):
    out = run(Db(demands=DEMANDS, facts=[], zones=ZONE_ROWS))
    assert out["known"] is False
    assert (out["on_file"], out["missing"]) == ([], [])
