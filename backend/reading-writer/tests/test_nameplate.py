"""The plate facts — asked only where a metric reads them, and never invented.

The rules under test:

  * WHICH facts are asked for is read from the metric definitions, latest
    version only: a fact an older version wanted is not asked for, and a metric
    that stopped reading one stops asking;
  * every question says which metrics stay refused without it;
  * half a band on file is still a question — the metric refuses on half a band;
  * the ΔT band is OBSERVED from the rollup, over the hours where both water
    temperatures reported and the machine was actually cooling, and the offered
    range is rounded OUTWARDS so it never narrows what the readings showed;
  * too few such hours is no observation, never a made-up one;
  * a machine whose facts are all on file is not asked, and is counted answered.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app.api import nameplate as np

# ── a scripted store ─────────────────────────────────────────────────────────

FRAGMENTS = {
    "demands": "'equipment_fact'",
    "observed": "WITH pair AS",
    "equipment": "FROM site_equipment e",
    "equipment_slots": "FROM equipment_point_slots s",
    "candidates": "WITH wanted(tenant_id",
}


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


class Db:
    """Rows per statement; an unscripted statement is a loud failure."""

    def __init__(self, **script):
        unknown = set(script) - set(FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        self.script = script
        self.asked: list[str] = []
        self.params: dict[str, list] = {}

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name, frag in FRAGMENTS.items():
            if frag in sql:
                if name not in self.script:
                    raise AssertionError(f"the `{name}` query ran, which this test did not script")
                self.asked.append(name)
                self.params.setdefault(name, []).append(params)
                return _Result(self.script[name])
        raise AssertionError(f"unrecognised statement: {sql[:160]}")


TENANT = uuid.uuid4()
SITE = uuid.uuid4()
CH1, CH2, PUMP = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
IWT, OWT = uuid.uuid4(), uuid.uuid4()

def demand(key, fact, *, cls="chiller", version=1, tenant=None):
    return {"key": key, "version": version, "tenant_id": tenant, "cls": cls, "fact": fact}


# As the estate really holds them: SEEDED BY THE PLATFORM, `tenant_id` null.
DEMAND_ROWS = [
    demand("chiller_kw_per_tr", "tr"),
    demand("chw_delta_t_in_band", "design_dt_min"),
    demand("chw_delta_t_in_band", "design_dt_max"),
]


def equipment_row(eid, tag, cls="chiller", design=None):
    return {
        "tenant_id": TENANT, "equipment_id": eid, "site_id": SITE, "system_id": uuid.uuid4(),
        "tag": tag, "name": None, "equipment_class": cls, "design": design or {},
        "design_units": {}, "fed_by_id": None,
    }


def slot_row(eid, slot, point_tag):
    return {"tenant_id": TENANT, "equipment_id": eid, "slot": slot,
            "device_tag": "CH1", "point_tag": point_tag}


def candidate_row(point_id, point_tag, *, reported=True):
    return {
        "want_tenant": TENANT, "want_device_tag": "CH1", "want_point_tag": point_tag,
        "point_id": point_id, "point_tag": point_tag, "device_id": uuid.uuid4(),
        "device_tag": "CH1", "unit": "degC", "unit_source": "operator",
        "last_seen_at": "2026-09-20T00:00:00Z",
        "last_in_window": "2026-09-20T00:00:00Z" if reported else None,
        "last_num": 28.4, "last_txt": None,
    }


def run(**script):
    return asyncio.run(np.nameplate(Db(**script), TENANT, SITE))


# ── which facts are asked for ────────────────────────────────────────────────


def test_a_platform_seeded_metric_is_read_for_a_tenants_building():
    # Every metric on this estate is seeded by the PLATFORM, with a null tenant.
    # Filtering them out left a building with six chillers asked nothing at all.
    db = Db(demands=[demand("chiller_kw_per_tr", "tr")])
    assert asyncio.run(np.demands(db, TENANT)) == {"chiller": {"tr": {"chiller_kw_per_tr"}}}
    assert "d.tenant_id IS NULL OR" in np._DEMANDS_SQL


def test_a_tenants_own_definition_overrides_the_platforms_for_that_key():
    rows = [
        demand("chw_delta_t_in_band", "design_dt_min"),
        demand("chw_delta_t_in_band", "design_dt_max"),
        # The tenant's own version of the same metric reads no plate fact.
        demand("chw_delta_t_in_band", "tr", version=1, tenant=TENANT),
    ]
    assert asyncio.run(np.demands(Db(demands=rows), TENANT)) == {
        "chiller": {"tr": {"chw_delta_t_in_band"}}
    }


def test_only_the_latest_version_of_a_metric_decides_what_is_asked():
    rows = [
        # v1 of the band metric read no fact at all; v2 reads both ends.
        demand("chw_delta_t_in_band", "tr", version=1),
        demand("chw_delta_t_in_band", "design_dt_min", version=2),
        demand("chw_delta_t_in_band", "design_dt_max", version=2),
    ]
    assert asyncio.run(np.demands(Db(demands=rows), TENANT)) == {
        "chiller": {
            "design_dt_min": {"chw_delta_t_in_band"},
            "design_dt_max": {"chw_delta_t_in_band"},
        }
    }


def test_a_fact_no_definition_names_and_a_metric_with_no_class_are_dropped():
    db = Db(demands=DEMAND_ROWS + [
        demand("made_up", "not_a_fact"),
        demand("site_thing", "tr", cls=None),
    ])
    assert asyncio.run(np.demands(db, TENANT)) == {
        "chiller": {
            "tr": {"chiller_kw_per_tr"},
            "design_dt_min": {"chw_delta_t_in_band"},
            "design_dt_max": {"chw_delta_t_in_band"},
        }
    }


def test_a_question_says_which_metrics_stay_refused_without_it():
    qs = np.questions_of(equipment_row(CH1, "CH-01"), {
        "tr": {"chiller_kw_per_tr"},
        "design_dt_min": {"chw_delta_t_in_band"},
        "design_dt_max": {"chw_delta_t_in_band"},
    }, None, days=30)
    assert [(q["kind"], q["blocks"]) for q in qs] == [
        ("band", ["chw_delta_t_in_band"]),
        ("capacity", ["chiller_kw_per_tr"]),
    ]


def test_half_a_band_on_file_is_still_a_question():
    wanted = {"design_dt_min": {"m"}, "design_dt_max": {"m"}}
    half = np.questions_of(equipment_row(CH1, "CH-01", design={"design_dt_min": 5}), wanted, None, days=30)
    whole = np.questions_of(
        equipment_row(CH1, "CH-01", design={"design_dt_min": 5, "design_dt_max": 7}), wanted, None, days=30
    )
    assert [q["kind"] for q in half] == ["band"]
    assert whole == []


def test_a_fact_already_on_file_is_not_asked_for_again():
    qs = np.questions_of(
        equipment_row(CH1, "CH-01", design={"tr": 350}), {"tr": {"chiller_kw_per_tr"}}, None, days=30
    )
    assert qs == []


def test_a_capacity_carries_the_unit_core_stores_it_in():
    [q] = np.questions_of(equipment_row(CH1, "CH-01"), {"tr": {"m"}}, None, days=30)
    assert (q["unit"], q["facts"]) == ("TR", ["tr"])


# ── the observed band ────────────────────────────────────────────────────────


@pytest.mark.parametrize("hours, offered", [(np.MIN_HOURS - 1, False), (np.MIN_HOURS, True)])
def test_too_few_hours_is_no_observation_rather_than_a_made_up_one(hours, offered):
    row = {"hours": hours, "low": 4.81, "mid": 5.6, "high": 6.83, "spread_low": 4.0, "spread_high": 7.2}
    assert (np.observation(row, days=30) is not None) is offered


def test_the_offered_range_is_rounded_outwards_so_it_never_narrows_the_readings():
    o = np.observation(
        {"hours": 500, "low": 4.81, "mid": 5.63, "high": 6.82, "spread_low": 4.2, "spread_high": 7.1}, days=30
    )
    assert (o["low"], o["high"], o["median"]) == (4.8, 6.9, 5.6)
    assert (o["hours"], o["days"]) == (500, 30)
    assert o["wide"] is False


def test_a_flat_reading_is_widened_rather_than_offered_as_a_band_of_zero():
    o = np.observation(
        {"hours": 500, "low": 5.0, "mid": 5.0, "high": 5.0, "spread_low": 5.0, "spread_high": 5.0}, days=30
    )
    assert o["high"] > o["low"]


def test_a_machine_that_ran_every_which_way_has_its_middle_marked_as_such():
    # The live estate: one chiller's whole spread ran 0.4-8.5 K over the window.
    # The middle of that is where it usually sat, not a band to stand behind.
    o = np.observation(
        {"hours": 48, "low": 1.9, "mid": 2.5, "high": 3.4, "spread_low": 0.4, "spread_high": 8.5}, days=30
    )
    assert o["wide"] is True
    assert o["spread"] == [0.4, 8.5]


def test_the_offered_band_is_the_middle_half_not_the_whole_spread():
    assert "percentile_cont(0.25)" in np._OBSERVED_SQL
    assert "percentile_cont(0.75)" in np._OBSERVED_SQL


def test_only_the_hours_the_machine_was_cooling_count_towards_the_band():
    assert ":min_dt" in np._OBSERVED_SQL
    assert "WHERE dt >= :min_dt" in np._OBSERVED_SQL
    # Both ends of the ΔT must have reported in the same hour, or the hour says
    # nothing: the rollup is joined to itself ON THE BUCKET.
    assert "s.bucket = r.bucket" in np._OBSERVED_SQL


def test_a_machine_missing_either_water_temperature_is_not_observed():
    # Only the return resolved: a ΔT needs two ends, so nothing is asked of the
    # rollup at all.
    db = Db()
    resolutions = {(str(CH1), "chwr"): {"point": {"point_id": IWT}}, (str(CH1), "chws"): {"point": None}}
    got = asyncio.run(np.observed_bands(db, [equipment_row(CH1, "CH-01")], resolutions, days=30))
    assert got == {}
    assert db.asked == []


# ── the whole answer ─────────────────────────────────────────────────────────


def test_the_building_is_asked_only_where_a_metric_reads_a_plate_fact():
    db = Db(
        demands=DEMAND_ROWS,
        equipment=[
            equipment_row(CH1, "CH-01"),
            equipment_row(CH2, "CH-02", design={"tr": 350, "design_dt_min": 5, "design_dt_max": 7}),
            # No metric reads a plate fact off a pump, so it is never asked.
            equipment_row(PUMP, "PP-01", cls="chw_primary_pump"),
        ],
        equipment_slots=[slot_row(CH1, "chwr", "IWT"), slot_row(CH1, "chws", "OWT")],
        candidates=[candidate_row(IWT, "IWT"), candidate_row(OWT, "OWT")],
        observed=[{"eq": str(CH1), "hours": 512, "low": 4.81, "mid": 5.6, "high": 6.88,
                   "spread_low": 4.2, "spread_high": 7.4}],
    )
    out = asyncio.run(np.nameplate(db, TENANT, SITE))

    assert [a["tag"] for a in out["asks"]] == ["CH-01"]
    assert out["totals"] == {"machines": 3, "of_interest": 2, "asked": 1, "answered": 1}
    band = next(q for q in out["asks"][0]["questions"] if q["kind"] == "band")
    assert band["observed"] == {
        "low": 4.8, "high": 6.9, "median": 5.6, "hours": 512, "days": 30,
        "wide": False, "spread": [4.2, 7.4],
    }
    # The band was never filled in behind the operator's back.
    assert band["value"] is None


def test_a_building_with_nothing_to_ask_asks_the_rollup_nothing():
    db = Db(
        demands=DEMAND_ROWS,
        equipment=[equipment_row(PUMP, "PP-01", cls="chw_primary_pump")],
        equipment_slots=[],
    )
    out = asyncio.run(np.nameplate(db, TENANT, SITE))
    assert out["asks"] == []
    assert out["totals"]["of_interest"] == 0
    assert "observed" not in db.asked and "candidates" not in db.asked


def test_a_band_with_no_observation_is_still_asked_as_a_question():
    db = Db(
        demands=DEMAND_ROWS,
        equipment=[equipment_row(CH1, "CH-01")],
        equipment_slots=[slot_row(CH1, "chwr", "IWT"), slot_row(CH1, "chws", "OWT")],
        candidates=[candidate_row(IWT, "IWT"), candidate_row(OWT, "OWT")],
        observed=[],
    )
    out = asyncio.run(np.nameplate(db, TENANT, SITE))
    band = next(q for q in out["asks"][0]["questions"] if q["kind"] == "band")
    assert band["observed"] is None
    assert band["blocks"] == ["chw_delta_t_in_band"]
