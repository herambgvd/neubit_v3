"""The chiller metrics that read the equipment registry — and every way they refuse.

WHY THIS FILE EXISTS. `chw_delta_t_in_band` v1 graded every chiller against one
literal band, 5–7 K. v2 (migration 0026) reads the band OFF THE CHILLER — its
recorded `design_dt_min` / `design_dt_max` — and the one property that makes that
worth doing is the one most likely to be quietly undone: a chiller with NO
recorded band must REFUSE, naming the fact, and never fall back to 5–7. A
fallback would be the literal again, on exactly the machines nobody described,
and the screen could not tell a graded chiller from a guessed one.

So the band tests use a ΔT of 4.8 K against a 4.5–6.0 K design band: inside the
chiller's own band, OUTSIDE 5–7. A v2 that silently read the literal scores it
0%; the honest one scores it 100%.

`chiller_kw_per_tr` = kw / (tr × load / 100). Every input can be missing or
unconfirmed in its own way, and each refusal is asserted separately, because a
kW/TR computed off a watt meter, or off a load confirmed as a 0–1 fraction, is
wrong by a factor a thousand or a hundred and LOOKS like an efficiency.

The definitions under test are 0026's own `_ROWS`, loaded from the revision file
— so the rows the database gets and the rows these tests evaluate are one copy.
"""

from __future__ import annotations

import ast
import datetime as dt
import importlib.util
import pathlib
import uuid

import pytest
import reporting.models
from metric_fakes import FakeDb, agg, at, pid, run

from app.metric_registry import evaluator as ev
from app.metric_registry import expr, registry
from app.metric_registry.units import DimensionError, Qty

VERSIONS = (
    pathlib.Path(reporting.models.__file__).resolve().parent.parent / "migrations" / "versions"
)


def _load_0026():
    (path,) = VERSIONS.glob("0026_*.py")
    spec = importlib.util.spec_from_file_location("rev_0026", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


REV = _load_0026()
ROWS = {(r["key"], r["version"]): r for r in REV._ROWS}

TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")
SITE = uuid.UUID("22222222-3333-4444-5555-666666666666")
EQ = uuid.UUID("44444444-5555-6666-7777-888888888888")
START, END = at(1), at(1, 3)


def defn(key: str, version: int) -> dict:
    """A 0026 row as `metric_definitions` returns it."""
    return {**ROWS[(key, version)], "effective_from": at(1), "tenant_id": None}


# ── the estate ───────────────────────────────────────────────────────────────

_TAGS = {"chws": "CH1_OWT", "chwr": "CH1_IWT", "kw": "CH1_KW", "load": "CH1_LOAD"}
_PIDS = {"chws": 1, "chwr": 2, "kw": 3, "load": 4}


def chiller(*, design=None, units=None, slots=("chws", "chwr", "kw", "load"), tag="CH-01"):
    design = {"tr": 300, "design_dt_min": 4.5, "design_dt_max": 6.0} if design is None else design
    units = ({k: {"tr": "TR"}.get(k, "K") for k in design} if units is None else units)
    return {
        "tenant_id": TENANT, "equipment_id": EQ, "site_id": SITE,
        "system_id": uuid.UUID(int=9), "tag": tag, "name": None,
        "equipment_class": "chiller", "design": design, "design_units": units,
    }, [
        {"tenant_id": TENANT, "equipment_id": EQ, "slot": s,
         "device_tag": "CH1", "point_tag": _TAGS[s]}
        for s in slots
    ]


def cand(slot: str, *, unit: str, unit_source: str = "operator", fresh: bool = True, n=None):
    return {
        "want_tenant": TENANT, "want_device_tag": "CH1", "want_point_tag": _TAGS[slot],
        "point_id": pid(n or _PIDS[slot]), "point_tag": _TAGS[slot], "device_tag": "CH1",
        "device_id": uuid.UUID(int=100), "unit": unit, "unit_source": unit_source,
        "last_seen_at": at(1, 2), "last_in_window": at(1, 2) if fresh else None,
        "last_num": 1.0 if fresh else None, "last_txt": None,
    }


def temps(unit="degC", **over):
    return [cand("chws", unit=unit, **over), cand("chwr", unit=unit, **over)]


def buckets(values: dict[int, list[float]]) -> list[dict]:
    out = []
    for n, series in values.items():
        for i, v in enumerate(series):
            out.append({"point_id": pid(n), "bucket": at(1, 1) + dt.timedelta(minutes=i),
                        "num_avg": v, "num_min": v, "num_max": v, "num_sum": v,
                        "num_first": v, "num_last": v})
    return out


# ΔT = |7.0 − 11.8| = 4.8 K in every bucket: inside 4.5–6.0, OUTSIDE 5–7.
_OWT = [7.0, 7.1, 6.9]
_IWT = [11.8, 11.9, 11.7]
_TEMP_AGGS = [agg(1, avg=7.0, lo=6.9, hi=7.1, buckets=3, samples=3),
              agg(2, avg=11.8, lo=11.7, hi=11.9, buckets=3, samples=3)]


def band_db(eq=None, cands=None, **extra) -> FakeDb:
    row, slot_rows = eq or chiller()
    script = dict(
        definitions=[defn("chw_delta_t_in_band", 2)],
        equipment=[row], equipment_slots=slot_rows,
        candidates=temps() if cands is None else cands,
        aggs=_TEMP_AGGS,
        buckets=buckets({1: _OWT, 2: _IWT}),
        union_buckets=[{"buckets": 3}],
    )
    script.update(extra)
    return FakeDb(**script)


def evaluate(db, key, **kw):
    kw.setdefault("site_id", SITE)
    out = run(ev.evaluate(db, TENANT, key, start=START, end=END, **kw))
    return out["items"]


# ── the seeded rows themselves ───────────────────────────────────────────────


def test_the_revision_owns_exactly_the_rows_it_pins():
    assert [(r["key"], r["version"]) for r in REV._ROWS] == list(REV._SEEDS)
    assert REV._SEEDS == (("chw_delta_t", 1), ("chw_delta_t_in_band", 2),
                          ("chiller_kw_per_tr", 1))


@pytest.mark.parametrize("key_version", sorted(ROWS))
def test_every_seeded_row_passes_the_registrys_own_type_check(key_version):
    """The row the database gets is the row the registry would accept over the
    API. A seed that could not type-check would refuse every evaluation with a
    reason nobody could act on."""
    registry.typecheck(ROWS[key_version])


def test_v2s_band_is_two_named_facts_and_contains_no_literal():
    """The whole point of v2. A literal anywhere in the band arguments is the
    fixed 5–7 coming back."""
    row = ROWS[("chw_delta_t_in_band", 2)]
    call = expr.parse(row["formula"]).body
    assert isinstance(call, ast.Call) and call.func.id == "in_band"
    assert [a.id for a in call.args[1:]] == ["dt_min", "dt_max"]
    assert row["inputs"]["dt_min"] == {"source": "equipment_fact", "fact": "design_dt_min",
                                       "dimension": "temperature_delta"}
    assert row["inputs"]["dt_max"]["fact"] == "design_dt_max"


def test_kw_per_tr_states_its_formula_and_its_assumptions_in_the_row():
    row = ROWS[("chiller_kw_per_tr", 1)]
    assert row["formula"] == "kw / (tr * load / 100)"
    assert row["output"] == {"unit": "kW/TR"}
    text = " ".join(row["display"]["assumptions"])
    for said in ("RATED COOLING", "%RLA", "nameplate", "flow", "ratio of window averages"):
        assert said in text


# ── the band comes off the equipment ─────────────────────────────────────────


def test_the_band_is_read_from_the_chiller_not_from_a_literal():
    """4.8 K sits inside this chiller's 4.5–6.0 and outside 5–7. 100% is only
    reachable by reading the chiller."""
    (item,) = evaluate(band_db(), "chw_delta_t_in_band")
    assert item["status"] == "ok", item.get("reason")
    assert item["value"] == 100.0
    facts = {i["fact"]: i for i in item["inputs"] if i.get("source") == "equipment_fact"}
    assert facts["design_dt_min"]["value"] == 4.5
    assert facts["design_dt_max"]["value"] == 6.0
    assert item["equipment_tag"] == "CH-01"


def test_a_different_chillers_band_gives_a_different_answer_on_the_same_water():
    """Same readings, a chiller designed for 5–7 K: the same 4.8 K is now OUT
    of band. Per-chiller, which the literal could never be."""
    eq = chiller(design={"tr": 300, "design_dt_min": 5.0, "design_dt_max": 7.0})
    (item,) = evaluate(band_db(eq=eq), "chw_delta_t_in_band")
    assert item["status"] == "ok" and item["value"] == 0.0


@pytest.mark.parametrize("missing", ["design_dt_min", "design_dt_max"])
def test_a_chiller_with_no_recorded_band_refuses_naming_the_fact_and_does_not_fall_back(missing):
    """No band → no score. The readings are never even read: there is nothing
    to grade them against, and computing first would invite a default."""
    design = {"tr": 300, "design_dt_min": 4.5, "design_dt_max": 6.0}
    design.pop(missing)
    db = band_db(eq=chiller(design=design))
    (item,) = evaluate(db, "chw_delta_t_in_band")
    assert item["status"] == "missing_fact"
    assert item["value"] is None
    assert f"`{missing}`" in item["reason"]
    assert "CH-01" in item["reason"]
    assert "nothing is defaulted" in item["reason"]
    assert "aggs" not in db.asked and "buckets" not in db.asked


def test_a_band_stated_in_another_unit_refuses_rather_than_being_read_as_kelvin():
    eq = chiller(units={"tr": "TR", "design_dt_min": "degF", "design_dt_max": "degF"})
    (item,) = evaluate(band_db(eq=eq), "chw_delta_t_in_band")
    assert item["status"] == "unit_mismatch"
    assert "`degF`" in item["reason"] and "`K`" in item["reason"]


def test_temperatures_confirmed_in_fahrenheit_do_not_meet_a_kelvin_band():
    """Their difference is a °F delta. Registration cannot know the confirmed
    unit; the evaluator re-runs the type-check on it and refuses."""
    (item,) = evaluate(band_db(cands=temps(unit="degF")), "chw_delta_t_in_band")
    assert item["status"] == "unit_mismatch"
    assert "degF_delta" in item["reason"]


def test_an_inverted_band_refuses_instead_of_scoring_everything_out_of_band():
    eq = chiller(design={"tr": 300, "design_dt_min": 6.0, "design_dt_max": 4.5})
    (item,) = evaluate(band_db(eq=eq), "chw_delta_t_in_band")
    assert item["status"] == "blocked"
    assert "0 <= lo < hi" in item["reason"]


def test_chw_delta_t_is_leaving_minus_entering_off_the_chillers_own_slots():
    db = band_db(definitions=[defn("chw_delta_t", 1)])
    (item,) = evaluate(db, "chw_delta_t")
    assert item["status"] == "ok"
    assert item["value"] == pytest.approx(7.0 - 11.8)
    assert {i["slot"] for i in item["inputs"]} == {"chws", "chwr"}


# ── slot refusals: the resolver's states, as the metric says them ───────────


def test_a_slot_with_two_live_generations_refuses_ambiguous_and_names_them():
    cands = [cand("chws", unit="degC"), cand("chws", unit="degC", n=11),
             cand("chwr", unit="degC")]
    (item,) = evaluate(band_db(cands=cands), "chw_delta_t_in_band")
    assert item["status"] == "slot_ambiguous"
    assert len(item["candidates"]) == 2


def test_a_silent_slot_refuses_no_data_before_any_readings_are_read():
    db = band_db(cands=[cand("chws", unit="degC", fresh=False), cand("chwr", unit="degC")])
    (item,) = evaluate(db, "chw_delta_t_in_band")
    assert item["status"] == "no_data"
    assert "produced no reading in the window" in item["reason"]
    assert "aggs" not in db.asked


def test_a_chiller_with_no_chws_slot_refuses_slot_unbound():
    db = band_db(eq=chiller(slots=("chwr",)), cands=[cand("chwr", unit="degC")])
    (item,) = evaluate(db, "chw_delta_t_in_band")
    assert item["status"] == "slot_unbound"
    assert "`chws`" in item["reason"]


def test_a_slot_whose_tags_name_nothing_refuses_slot_unresolved():
    db = band_db(cands=[cand("chwr", unit="degC")])
    (item,) = evaluate(db, "chw_delta_t_in_band")
    assert item["status"] == "slot_unresolved"


# ── kW/TR ────────────────────────────────────────────────────────────────────


def kw_db(*, kw_unit="kW", kw_source="operator", load_unit="%", load_avg=60.0,
          load_samples=10, design=None) -> FakeDb:
    return FakeDb(
        definitions=[defn("chiller_kw_per_tr", 1)],
        equipment=[chiller(design=design)[0]], equipment_slots=chiller()[1],
        candidates=[cand("kw", unit=kw_unit, unit_source=kw_source),
                    cand("load", unit=load_unit)],
        aggs=[agg(3, avg=180.0, lo=170.0, hi=190.0),
              agg(4, avg=load_avg, lo=load_avg - 5 if load_samples > 1 else load_avg,
                  hi=load_avg + 5 if load_samples > 1 else load_avg,
                  samples=load_samples)],
        buckets=[],
    )


def test_kw_per_tr_is_input_power_over_the_cooling_the_load_signal_says_was_delivered():
    """180 kW at 60% of a 300 TR chiller is 180 TR delivered: 1.00 kW/TR."""
    (item,) = evaluate(kw_db(), "chiller_kw_per_tr")
    assert item["status"] == "ok", item.get("reason")
    assert item["value"] == pytest.approx(1.0)
    assert item["unit"] == "kW/TR"
    assert "180 ÷ ((300 × 60) ÷ 100)" in item["arithmetic"]


def test_kw_per_tr_refuses_a_kw_point_nobody_confirmed():
    (item,) = evaluate(kw_db(kw_source="inferred"), "chiller_kw_per_tr")
    assert item["status"] == "unit_unconfirmed"
    assert "CH1_KW" in item["reason"]


def test_kw_per_tr_refuses_a_watt_meter_rather_than_scoring_it_a_thousand_times_worse():
    (item,) = evaluate(kw_db(kw_unit="W"), "chiller_kw_per_tr")
    assert item["status"] == "unit_mismatch"
    assert "`kW`" in item["reason"]


def test_kw_per_tr_refuses_a_load_confirmed_as_a_fraction_rather_than_a_percent():
    (item,) = evaluate(kw_db(load_unit=""), "chiller_kw_per_tr")
    assert item["status"] == "unit_mismatch"
    assert "`%`" in item["reason"]


def test_kw_per_tr_refuses_a_chiller_with_no_rated_tr():
    (item,) = evaluate(kw_db(design={"design_dt_min": 4.5, "design_dt_max": 6.0}),
                       "chiller_kw_per_tr")
    assert item["status"] == "missing_fact"
    assert "`tr`" in item["reason"]


def test_kw_per_tr_at_zero_load_refuses_rather_than_reporting_infinity():
    (item,) = evaluate(kw_db(load_avg=0.0, load_samples=1), "chiller_kw_per_tr")
    assert item["status"] == "blocked"
    assert "division by zero" in item["reason"]


# ── scope ────────────────────────────────────────────────────────────────────


def test_an_equipment_metric_cannot_be_asked_per_device():
    """A chiller's slots can sit on several gateway devices; a device id does
    not name a chiller."""
    with pytest.raises(ev.EvaluationError, match="per piece of equipment"):
        run(ev.evaluate(FakeDb(definitions=[defn("chw_delta_t_in_band", 2)]), TENANT,
                        "chw_delta_t_in_band", device_id=uuid.uuid4(),
                        start=START, end=END))


def test_equipment_is_read_under_the_callers_tenant():
    db = band_db()
    evaluate(db, "chw_delta_t_in_band")
    assert db.params["equipment"][0]["tenant"] == str(TENANT)
    assert db.params["equipment"][0]["cls"] == "chiller"


def _eei_part(db):
    parent = {"key": "eei", "display": {}, "components": []}
    site = {"site_id": SITE}
    return run(ev._site_composite_part(
        db, TENANT, parent, site, {"metric": "chw_delta_t_in_band", "weight": 0.25},
        START, END, "1m", 0))


def test_the_eei_component_with_no_chiller_registered_says_so():
    """Not `missing_role`: the fix is registering chillers, not binding roles."""
    part = _eei_part(FakeDb(definitions=[defn("chw_delta_t_in_band", 2)], equipment=[]))
    assert part["status"] == "missing_equipment"
    assert "no chiller is registered" in part["reason"]


def test_the_eei_component_refuses_when_any_chiller_refuses_and_names_it():
    design = {"tr": 300}
    part = _eei_part(band_db(eq=chiller(design=design)))
    assert part["status"] == "blocked"
    assert "CH-01 (missing_fact" in part["reason"]
    assert part["equipment"][0]["equipment_tag"] == "CH-01"


def test_the_eei_component_is_the_chillers_score_when_they_all_score():
    part = _eei_part(band_db())
    assert part["status"] == "ok" and part["value"] == 100.0


# ── registration: what an equipment definition may and may not say ───────────


def _v2(**over):
    row = dict(ROWS[("chw_delta_t_in_band", 2)])
    row.update(over)
    return row


def test_a_band_edge_that_is_a_measured_slot_is_refused_at_registration():
    """A band whose edge is a live reading is a comparison between two sensors,
    and would score "in band" whenever they drifted together."""
    inputs = dict(_v2()["inputs"])
    inputs["dt_max"] = {"source": "slot", "slot": "cws", "dimension": "temperature"}
    with pytest.raises(registry.RegistrationError, match="band edge must be a literal or a recorded fact"):
        registry.typecheck(_v2(inputs=inputs))


def test_a_slot_input_needs_equipment_scope():
    """`chw_delta_t` reads slots only, so the slot check is the one that must fire."""
    row = {**ROWS[("chw_delta_t", 1)], "applies_to": {"scope": "device"}}
    with pytest.raises(registry.RegistrationError, match="reads an equipment slot"):
        registry.typecheck(row)


def test_an_equipment_fact_needs_equipment_scope():
    row = {"key": "x", "kind": "formula", "applies_to": {"scope": "site"},
           "inputs": {"tr": {"source": "equipment_fact", "fact": "tr",
                             "dimension": "refrigeration"}},
           "formula": "tr", "output": {"dimension": "refrigeration"}}
    with pytest.raises(registry.RegistrationError, match="reads an equipment design fact"):
        registry.typecheck(row)


def test_an_equipment_metric_may_not_read_points_by_role():
    inputs = dict(_v2()["inputs"])
    inputs["owt"] = {"role": "outlet_water_temp", "dimension": "temperature"}
    with pytest.raises(registry.RegistrationError, match="reads points through"):
        registry.typecheck(_v2(inputs=inputs))


def test_an_equipment_metric_names_a_class_from_the_vocabulary():
    with pytest.raises(registry.RegistrationError, match="equipment_class must be one of"):
        registry.typecheck(_v2(applies_to={"scope": "equipment", "equipment_class": "Chiller"}))


def test_a_design_band_declared_as_an_absolute_temperature_is_refused():
    inputs = dict(_v2()["inputs"])
    inputs["dt_min"] = {**inputs["dt_min"], "dimension": "temperature"}
    with pytest.raises(registry.RegistrationError, match="is `temperature_delta`"):
        registry.typecheck(_v2(inputs=inputs))


def test_a_named_band_bound_must_be_the_same_quantity_as_what_it_bounds():
    tree = expr.parse("in_band(abs(a - b), lo, hi)")
    env = {"a": Qty("temperature", "degF"), "b": Qty("temperature", "degF"),
           "lo": Qty("temperature_delta", "K"), "hi": Qty("temperature_delta", "K")}
    with pytest.raises(DimensionError, match="conversion is not modelled"):
        expr.infer(tree, env)


def test_literal_bands_still_work_exactly_as_before():
    """v1 and every other occupancy row keep their literal bands."""
    tree = expr.parse("in_band(x, 5, 7)")
    assert expr.evaluate(tree, {"x": 6.0}) == 1.0
    assert expr.evaluate(tree, {"x": 4.8}) == 0.0
    with pytest.raises(expr.ExprError, match="0 <= lo < hi"):
        expr.parse("in_band(x, 7, 5)")
