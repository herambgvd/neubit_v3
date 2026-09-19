"""What each device is — proposed from its tags, and never more than proposed.

Every fixture here is a real device's tag list from the Aeon Tower estate, so a
rule that passes here passes on the building it was written for. The rules
under test:

  * the NAME decides where it is unambiguous (a pump, a TFA unit, a solar
    panel) and the SHAPE of the points decides where it is not;
  * `4F-5F UPS DB` is a distribution board, not a UPS;
  * of several generations of one sensor, the one that read most recently is
    proposed, and the others are COUNTED;
  * a lifetime register is never proposed as power, a DC reading never as AC
    output, "this month's kWh" never as the lifetime register;
  * a reading that contradicts what it is proposed as is a WARNING beside it;
  * a feeder is proposed only when exactly one could be it — otherwise a
    shortlist, and the person picks.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from app.api import suggest_equipment as sx

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 20, 10, tzinfo=UTC)


def pts(*tags, values=None, ats=None):
    values = values or {}
    ats = ats or {}
    return [sx.Pt(uuid.uuid4(), t, values.get(t), ats.get(t, NOW)) for t in tags]


YORK_1F = [
    "1F-York Chiller-1 EM - Total kW", "1FChiller1EM_kVAh", "1FYC1 EM - Total kW",
    "1FYC1_AmbTemp", "1FYC1_EM_kVAh", "1FYC1_EM_kW", "1FYC1_IWT", "1FYC1_OWT",
    "1FYC1_OnOff STS", "1FYC1_Run Hours", "1FYC1_SysLoad", "1FYorkChiller1 EM - Total kW",
    "1FYorkChiller1EM_kVAh", "1FYorkChiller1EM_kWh", "1FYorkChiller1_AmbTemp",
    "1FYorkChiller1_IWT", "1FYorkChiller1_OnOff STS", "1FYorkChiller1_Run Hours", "IWT",
    "OWT", "On Off STS", "Run Hours", "SYS Load",
]
UPS = ["4F_UPS01_OutCurrL1_A", "Batt_Cap_Rem", "Batt_Time_Rem", "KVA", "KW_kw", "Load", "PF_pf"]
# `4FSP1_This_Year_KWH` is the real trap: it ENDS in `_kwh` like a register does.
SOLAR = ["4FSP1_Tot_DC_kW", "4FSP1_Tot_kW", "4FSP1_TodaykWh", "4FSP1_This_MonthkWh",
         "4FSP1_This_Year_KWH", "4FSP1_kWh"]
BOARD = ["INHERITANCE_PROOF_kW", "KWH", "KW_L1", "KW_L2", "KW_L3", "PF", "TOT KW"]
FLOW = ["Cum_Flow", "Flow Rate", "For_Flow", "Rev_Flow"]


# ── what it is ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("device, tags, want", [
    ("1F York Chiller01", YORK_1F, "chiller"),
    ("4F_UPS01", UPS, "ups"),
    ("4F_Solar_Panel1", SOLAR, "pv_inverter"),
    ("4F-3F Light DB", BOARD, "energy_meter"),
    ("B2_Main Incomer", ["TOTKW_kw", "KWH_kwh", "VoltL1_V"], "energy_meter"),
    ("B1-2F4-Sump Pump1", BOARD, "water_pump"),
    ("B1-2F3-TFA Unit", BOARD, "tfa"),
    ("B1_Water_Flow Meter", FLOW, "flow_meter"),
])
def test_each_kind_of_device_on_the_estate_is_recognised(device, tags, want):
    cls, why = sx.classify(device, tags)
    assert cls == want, why


def test_a_board_named_after_the_ups_it_feeds_is_a_board_not_a_ups():
    cls, _ = sx.classify("4F-5F UPS DB", BOARD)
    assert cls == "energy_meter"


def test_a_device_that_matches_nothing_is_said_to_match_nothing():
    cls, why = sx.classify("Mystery Box", ["Point1", "Batt_Time_Rem"])
    assert cls is None
    assert "no machine" in why


# ── what goes where ──────────────────────────────────────────────────────────


def test_of_several_generations_of_one_sensor_the_freshest_is_proposed_and_the_rest_counted():
    points = pts("IWT", "1FYC1_IWT", "1FYorkChiller1_IWT",
                 ats={"IWT": NOW - dt.timedelta(days=10),
                      "1FYorkChiller1_IWT": NOW - dt.timedelta(days=5),
                      "1FYC1_IWT": NOW})
    [slot] = sx.pick_slots(sx.ClassRule("x", "chw_plant", ("chwr",)), points)
    assert slot["point_tag"] == "1FYC1_IWT"
    assert slot["alternatives"] == 2


def test_a_register_is_never_power_and_a_period_total_is_never_the_register():
    # The live bug this engine fixed on sight: 2,312 was the kWh register.
    points = pts(*SOLAR)
    slots = {s["slot"]: s["point_tag"] for s in sx.pick_slots(sx.CLASSES["pv_inverter"], points)}
    assert slots["kw"] == "4FSP1_Tot_kW"          # AC, not `Tot_DC_kW`
    assert slots["kwh"] == "4FSP1_kWh"            # lifetime, not today / this month / this year


def test_one_point_is_never_proposed_for_two_slots():
    points = pts(*YORK_1F)
    chosen = [s["point_tag"] for s in sx.pick_slots(sx.CLASSES["chiller"], points)]
    assert len(chosen) == len(set(chosen))


def test_a_ups_gets_its_battery_and_load():
    slots = {s["slot"]: s["point_tag"] for s in sx.pick_slots(sx.CLASSES["ups"], pts(*UPS))}
    assert slots == {"kw": "KW_kw", "load": "Load", "battery": "Batt_Cap_Rem"}


def test_a_flow_meter_gets_its_rate_and_its_total():
    slots = {s["slot"]: s["point_tag"] for s in sx.pick_slots(sx.CLASSES["flow_meter"], pts(*FLOW))}
    assert slots == {"flow_rate": "Flow Rate", "flow_total": "Cum_Flow"}


# ── what the readings say about the proposal ─────────────────────────────────


def _checked(device, tags, values):
    rule = sx.CLASSES[sx.classify(device, tags)[0]]
    points = pts(*tags, values=values)
    slots = sx.pick_slots(rule, points)
    warnings = sx.check(device, slots, [p.value for p in points])
    return {s["slot"]: s for s in slots}, warnings


def test_power_that_is_really_an_energy_counter_is_called_out():
    slots, _ = _checked("1F York Chiller01", ["1FYC1_IWT", "1FYC1_OWT", "1FYC1_EM_kW", "1FYC1_OnOff STS"],
                        {"1FYC1_EM_kW": 2312.1, "1FYC1_OnOff STS": 0.0, "1FYC1_IWT": 28, "1FYC1_OWT": 25.8})
    assert "energy counter" in slots["kw"]["warning"]


def test_full_load_on_a_machine_that_is_off_is_called_out():
    slots, _ = _checked("2F York Chiller01", ["2FYC1_IWT", "2FYC1_OWT", "SYS Load", "2FYC1_OnOff STS"],
                        {"SYS Load": 100.0, "2FYC1_OnOff STS": 0.0})
    assert "load while the machine is off" in slots["load"]["warning"]


def test_a_point_tagged_for_another_machine_is_called_out():
    slots, _ = _checked("2F York Chiller01", ["2FYC1_IWT", "2FYC2_OWT"], {})
    assert slots["chws"]["warning"] == "the tag names machine 2, on a device numbered 1"
    assert slots["chwr"]["warning"] is None


def test_a_device_sending_only_zeros_is_called_out():
    _, warnings = _checked("5F York Chiller01", ["5FYorkChiller1_IWT", "5FYorkChiller1_OWT"],
                           {"5FYorkChiller1_IWT": 0.0, "5FYorkChiller1_OWT": 0.0})
    assert warnings == ["every value it sends is zero"]


def test_a_plausible_machine_raises_no_warning():
    slots, warnings = _checked("4F Khem Chiller01", ["4FKC1_IWT", "4FKC1_OWT", "4FKC1_On Off STS"],
                               {"4FKC1_IWT": 29.1, "4FKC1_OWT": 28.4, "4FKC1_On Off STS": 0.0})
    assert warnings == []
    assert all(s["warning"] is None for s in slots.values())


# ── what feeds what ──────────────────────────────────────────────────────────


POWER = [
    "B2_Main Incomer", "4F_Incomer_EM", "4F_Incomer1_EM", "4F_Sub Incomer1",
    "4F_Sub Incomer2", "4F-3F Light DB", "B1 Guard Room",
]


def test_the_main_incomer_is_fed_by_the_grid():
    chain = sx.feeders(POWER)
    assert chain["B2_Main Incomer"]["suggested"] is None
    assert "grid" in chain["B2_Main Incomer"]["reason"]


def test_an_incomer_is_proposed_under_the_one_main_incomer():
    assert sx.feeders(POWER)["4F_Incomer1_EM"]["suggested"] == "B2_Main Incomer"


def test_two_possible_feeders_are_a_shortlist_never_a_pick():
    # Two 4F sub-incomers could feed a 4F board, and the name cannot say which.
    board = sx.feeders(POWER)["4F-3F Light DB"]
    assert board["suggested"] is None
    assert board["candidates"] == ["4F_Sub Incomer1", "4F_Sub Incomer2"]
    assert "choose" in board["reason"]


def test_a_floor_with_no_feeder_of_its_own_falls_back_up_the_chain():
    # Nothing on B1 but the board itself: the next tier up is the main incomer.
    assert sx.feeders(POWER)["B1 Guard Room"]["suggested"] == "B2_Main Incomer"


# ── fragments and totals ─────────────────────────────────────────────────────


def test_leftovers_are_not_machines_and_the_gateway_is_not_either():
    old = NOW - dt.timedelta(days=9)
    by_device = {
        "1F Khem Chiller01": pts("1FKC1_OWT"),
        "gateway": pts("heartbeat"),
        "4F Khem Chiller01": pts("4FKC1_IWT", "4FKC1_OWT", "4FKC1_kWh"),
    }
    seen = {"1F Khem Chiller01": old, "gateway": NOW, "4F Khem Chiller01": NOW}
    out = sx.assemble(by_device, seen, NOW, {})
    by = {d["device_tag"]: d for d in out["devices"]}
    assert by["1F Khem Chiller01"]["fragment"] is True
    assert by["gateway"]["fragment"] is True
    assert by["4F Khem Chiller01"]["equipment_class"] == "chiller"
    assert out["totals"] == {"devices": 3, "machines": 1, "unknown": 0, "fragments": 2, "registered": 0}


def test_a_registered_device_says_what_it_was_registered_as():
    out = sx.assemble({"4F Khem Chiller01": pts("4FKC1_IWT", "4FKC1_OWT")},
                      {"4F Khem Chiller01": NOW}, NOW,
                      {"4F Khem Chiller01": {"equipment_tag": "CH-3", "equipment_id": "e3"}})
    assert out["devices"][0]["registered"] == {"equipment_tag": "CH-3", "equipment_id": "e3"}
    assert out["totals"]["registered"] == 1


def test_the_gateway_is_never_a_machine_however_many_points_it_carries():
    out = sx.assemble({"gateway": pts("TOT KW", "KWH", "uptime")}, {"gateway": NOW}, NOW, {})
    assert out["devices"][0]["fragment"] is True
    assert out["devices"][0]["equipment_class"] is None
