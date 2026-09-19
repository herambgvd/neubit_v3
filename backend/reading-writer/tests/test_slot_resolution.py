"""Which point a slot MEANS — unique, ambiguous, unresolved, silent, unbound.

WHY THIS FILE EXISTS. A slot binds a chiller's supply temperature by the
gateway's tags, and on this deployment 45 tag pairs name two live generations of
a point at once — a gateway rebuild mints new ids under the same tags. A resolver
that took the first row would average whichever generation Postgres returned
first, and on the day that is the ghost, CH-01's ΔT is computed off a sensor
silent for a week, with nothing on the screen to say so.

So `slots.resolve` is the one place that decides, and these tests pin its table:
exactly one candidate REPORTING in the window resolves; more than one reporting
is ambiguous; none reporting is silent with one candidate and ambiguous with
several; no candidate is unresolved; no tags is unbound. "Reporting" is a row in
`readings` inside the window — never `LIVE_POINT`, which let a correlation be
satisfied off meters silent for eight days (`app/api/correlations.py`).

Pure, plus the fake session for the two statements: the rules are reached with
rows already fetched, and the fake records what each statement was bound with,
which is how tenant scope is asserted.
"""

from __future__ import annotations

import datetime as dt
import uuid

from metric_fakes import FakeDb, at, run

from app.metric_registry import slots as sl

TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")
OTHER = uuid.UUID("99999999-2222-3333-4444-555555555555")


def _slot(name="chws", dtag="CH1", ptag="CH1_OWT"):
    return {"slot": name, "device_tag": dtag, "point_tag": ptag}


def _cand(n: int, *, fresh: bool, tag="CH1_OWT", last_seen=None):
    return {
        "point_id": uuid.UUID(int=n), "point_tag": tag, "device_tag": "CH1",
        "device_id": uuid.UUID(int=100), "unit": "degC", "unit_source": "operator",
        "last_seen_at": last_seen or at(1),
        "last_in_window": at(10) if fresh else None,
        "last_num": 7.1 if fresh else None, "last_txt": None,
    }


# ── the table ────────────────────────────────────────────────────────────────


def test_a_slot_with_no_tags_is_unbound_and_says_where_to_bind_it():
    out = sl.resolve(_slot(dtag=None, ptag=None), None)
    assert out["readiness"] == sl.UNBOUND
    assert out["point"] is None
    assert sl.RECORDED_AT in out["reason"]


def test_tags_that_name_no_point_are_unresolved_and_the_tags_are_quoted():
    """So the operator can see the misspelling rather than being told "missing"."""
    out = sl.resolve(_slot(ptag="CH1_OWTT"), [])
    assert out["readiness"] == sl.UNRESOLVED
    assert out["point"] is None
    assert "`CH1_OWTT`" in out["reason"]


def test_one_candidate_that_reported_resolves_to_it():
    c = _cand(1, fresh=True)
    out = sl.resolve(_slot(), [c])
    assert out["readiness"] == sl.REPORTING
    assert out["point"] is c
    assert out["reason"] is None


def test_the_one_reporting_generation_wins_and_the_silent_ones_come_back_as_ghosts():
    """This is the estate's normal state after a rebuild. Refusing it would make
    every rebuilt chiller unmeasurable; picking by row order would sometimes pick
    the ghost. Picking the one that REPORTED is the only decision the data makes."""
    ghost, live = _cand(1, fresh=False), _cand(2, fresh=True)
    out = sl.resolve(_slot(), [ghost, live])
    assert out["readiness"] == sl.REPORTING
    assert out["point"] is live
    assert [g["point_id"] for g in out["ghosts"]] == [str(ghost["point_id"])]


def test_two_generations_both_reporting_is_ambiguous_and_neither_is_picked():
    out = sl.resolve(_slot(), [_cand(1, fresh=True), _cand(2, fresh=True)])
    assert out["readiness"] == sl.AMBIGUOUS
    assert out["point"] is None
    assert len(out["candidates"]) == 2
    assert "2 points" in out["reason"]


def test_one_candidate_that_did_not_report_is_silent_but_still_resolved():
    """The binding is right; the signal stopped. The point travels back so the
    schematic can show which sensor went quiet and when it was last seen."""
    c = _cand(1, fresh=False, last_seen=dt.datetime(2026, 9, 11, 11, 42, tzinfo=dt.timezone.utc))
    out = sl.resolve(_slot(), [c])
    assert out["readiness"] == sl.SILENT
    assert out["point"] is c
    assert "2026-09-11T11:42" in out["reason"]


def test_several_generations_none_reporting_is_ambiguous_not_silent():
    """The live estate's exact shape: two generations, both last seen 11 Sept.
    Calling it SILENT would name one of them as the meter, which silence cannot
    decide."""
    out = sl.resolve(_slot(), [_cand(1, fresh=False), _cand(2, fresh=False)])
    assert out["readiness"] == sl.AMBIGUOUS
    assert out["point"] is None
    assert "ghosts" in out["reason"]


# ── rolling up ───────────────────────────────────────────────────────────────


def test_readiness_is_a_closed_set_ordered_worst_first():
    assert sl.READINESS == ("ambiguous", "unresolved", "silent", "unbound", "reporting")


def test_equipment_rolls_up_to_its_least_ready_slot():
    assert sl.rollup(["reporting", "silent", "reporting"]) == "silent"
    assert sl.rollup(["unbound", "unresolved"]) == "unresolved"
    assert sl.rollup(["unresolved", "ambiguous"]) == "ambiguous"
    assert sl.rollup(["reporting", "reporting"]) == "reporting"


def test_equipment_with_no_slots_is_not_green():
    assert sl.rollup([]) == sl.UNBOUND


# ── the statements: window, bound slots only, tenant from the binding ────────


def _equipment(tenant, eid, slots):
    return {"tenant_id": tenant, "equipment_id": eid, "tag": "CH-01",
            "slots": [{"equipment_id": eid, **s} for s in slots]}


def test_resolution_is_asked_over_the_window_it_is_given():
    db = FakeDb(candidates=[])
    start, end = at(1), at(2)
    run(sl.resolve_equipment(db, [_equipment(TENANT, "e1", [_slot()])], start=start, end=end))
    p = db.params["candidates"][0]
    assert (p["start"], p["end"]) == (start, end)


def test_only_bound_slots_are_sent_to_the_store():
    db = FakeDb(candidates=[])
    out = run(sl.resolve_equipment(
        db, [_equipment(TENANT, "e1", [_slot(), _slot("trip", None, None)])],
        start=at(1), end=at(2),
    ))
    assert db.params["candidates"][0]["point_tags"] == ["CH1_OWT"]
    assert out[("e1", "trip")]["readiness"] == sl.UNBOUND


def test_a_binding_resolves_only_against_its_own_tenants_points():
    """Two tenants' gateways can spell a tag identically. The candidate query is
    keyed on the EQUIPMENT's tenant, and a row the store returns for another
    tenant is not a candidate for this slot — even for a platform caller who can
    see both."""
    other_tenants_point = {**_cand(9, fresh=True), "want_tenant": OTHER,
                           "want_device_tag": "CH1", "want_point_tag": "CH1_OWT"}
    db = FakeDb(candidates=[other_tenants_point])
    out = run(sl.resolve_equipment(
        db, [_equipment(TENANT, "e1", [_slot()])], start=at(1), end=at(2)))
    assert db.params["candidates"][0]["tenants"] == [str(TENANT)]
    assert out[("e1", "chws")]["readiness"] == sl.UNRESOLVED


def test_slot_names_narrow_what_is_resolved():
    db = FakeDb(candidates=[])
    out = run(sl.resolve_equipment(
        db, [_equipment(TENANT, "e1", [_slot(), _slot("kw", "CH1", "CH1_KW")])],
        start=at(1), end=at(2), slot_names={"kw"},
    ))
    assert set(out) == {("e1", "kw")}


def test_equipment_is_read_under_the_callers_tenant_and_slots_under_each_rows_own():
    rows = [{"tenant_id": TENANT, "equipment_id": uuid.UUID(int=1), "site_id": uuid.UUID(int=2),
             "system_id": uuid.UUID(int=3), "tag": "CH-01", "name": None,
             "equipment_class": "chiller", "design": {"tr": 300}, "design_units": {"tr": "TR"}}]
    slot_rows = [
        {"tenant_id": TENANT, "equipment_id": uuid.UUID(int=1), "slot": "chws",
         "device_tag": "CH1", "point_tag": "CH1_OWT"},
        # Same equipment id under another tenant: never this equipment's slot.
        {"tenant_id": OTHER, "equipment_id": uuid.UUID(int=1), "slot": "kw",
         "device_tag": "X", "point_tag": "Y"},
    ]
    db = FakeDb(equipment=rows, equipment_slots=slot_rows)
    out = run(sl.load_equipment(db, TENANT, site_id=uuid.UUID(int=2), equipment_class="chiller"))
    assert db.params["equipment"][0]["tenant"] == str(TENANT)
    assert db.params["equipment"][0]["cls"] == "chiller"
    assert [s["slot"] for s in out[0]["slots"]] == ["chws"]


def test_fact_value_takes_only_finite_numbers():
    assert sl.fact_value({"tr": 300}, "tr") == 300.0
    assert sl.fact_value({"tr": True}, "tr") is None
    assert sl.fact_value({"tr": "300"}, "tr") is None
    assert sl.fact_value({"tr": float("nan")}, "tr") is None
    assert sl.fact_value({}, "tr") is None
