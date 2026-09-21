"""`GET /bi/sites/{site_id}/plant` — what the L3 schematic is drawn from.

WHY THIS FILE EXISTS. The L3 view colours equipment by DATA READINESS, and the
five states are the product: `reporting`, `silent`, `ambiguous`, `unresolved`,
`unbound`. Each is a different job for a different person — a dead transducer,
a ghost generation to collapse, a misspelt tag, a slot nobody filled in — and a
schematic that collapsed any two of them would send someone to the wrong place.
So these tests pin, per slot, which state comes back, what rides with it (the
point, the latest value only when it REPORTED, the ghosts, the candidates), and
how a piece of equipment and a system roll up.

Two things only the endpoint does are pinned as well:

  * a slot a metric of the equipment's class NEEDS is drawn even when core never
    stated it — as `unbound`, `declared: false`. Otherwise a chiller with only a
    `chwr` slot rolls up green while every chiller metric refuses for want of
    `chws`;
  * the tenant is the token's, never the request's, and another tenant's site is
    a 404 indistinguishable from no site at all.

The route is driven over HTTP with the scripted session, so the whole response
survives serialisation — a field the encoder dropped would be a blank on the
schematic.
"""

from __future__ import annotations

import uuid

import pytest
from metric_fakes import FakeDb, at, pid, run

from app.api import plant as pl
from app.metric_registry import evaluator, registry
from app.metric_registry import slots as sl

TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")
SITE = uuid.UUID("22222222-3333-4444-5555-666666666666")
SYSTEM = uuid.UUID("33333333-4444-5555-6666-777777777777")
CH1 = uuid.UUID("44444444-5555-6666-7777-888888888888")
CH2 = uuid.UUID("55555555-5555-6666-7777-888888888888")


def _eq(eid, tag, system=SYSTEM):
    return {"tenant_id": TENANT, "equipment_id": eid, "site_id": SITE, "system_id": system,
            "tag": tag, "name": None, "equipment_class": "chiller",
            "design": {"tr": 300, "design_dt_min": 4.5, "design_dt_max": 6.0},
            "design_units": {"tr": "TR", "design_dt_min": "K", "design_dt_max": "K"}}


def _slot(eid, name, ptag):
    return {"tenant_id": TENANT, "equipment_id": eid, "slot": name,
            "device_tag": "CH1" if ptag else None, "point_tag": ptag}


def _cand(n, ptag, *, fresh, unit_source="operator"):
    return {"want_tenant": TENANT, "want_device_tag": "CH1", "want_point_tag": ptag,
            "point_id": pid(n), "point_tag": ptag, "device_tag": "CH1",
            "device_id": uuid.UUID(int=100), "unit": "degC", "unit_source": unit_source,
            "last_seen_at": at(1), "last_in_window": at(1, 2) if fresh else None,
            "last_num": 7.25 if fresh else None, "last_txt": None}


def _estate(**over) -> dict:
    """CH-01 with one slot in every state; CH-02 with only a `chwr`."""
    script = dict(
        sites=[{"site_name": "HQ"}],
        systems=[{"system_id": SYSTEM, "name": "Plant A", "kind": "chw_plant",
                  "description": "main loop"}],
        equipment=[_eq(CH1, "CH-01"), _eq(CH2, "CH-02")],
        equipment_slots=[
            _slot(CH1, "chws", "OWT"),     # reporting, beside a silent ghost
            _slot(CH1, "chwr", "IWT"),     # silent
            _slot(CH1, "kw", "KW"),        # ambiguous: two live generations
            _slot(CH1, "load", "LOADD"),   # unresolved: a misspelt tag
            _slot(CH1, "trip", None),      # unbound
            _slot(CH2, "chwr", "IWT2"),
        ],
        candidates=[
            _cand(1, "OWT", fresh=True), _cand(11, "OWT", fresh=False),
            _cand(2, "IWT", fresh=False, unit_source=None),
            _cand(3, "KW", fresh=True), _cand(13, "KW", fresh=True),
            _cand(4, "IWT2", fresh=True),
        ],
    )
    script.update(over)
    return script


@pytest.fixture
def metrics(monkeypatch):
    """One effective equipment metric reading chws + chwr, with a series the
    endpoint must NOT pass through. The evaluator itself is tested elsewhere;
    what is under test here is how its outcome is attached."""
    defn = {"key": "chw_delta_t", "version": 1, "applies_to":
            {"scope": "equipment", "equipment_class": "chiller"},
            "inputs": {"owt": {"source": "slot", "slot": "chws"},
                       "iwt": {"source": "slot", "slot": "chwr"}}}

    async def list_definitions(db, tenant):
        return [defn, {"key": "carbon_intensity", "version": 1}]

    async def effective(db, tenant, key, at_):
        return defn if key == "chw_delta_t" else {"applies_to": {"scope": "site"}}

    async def evaluate(db, tenant, key, **kw):
        return {"version": 1, "display": {"label": "Chilled-water ΔT", "precision": 1},
                "resolution": "1m",
                "items": [{"equipment_id": str(CH1), "status": "no_data", "value": None,
                           "reason": "slot `chwr` → `IWT` produced no reading",
                           "series": [{"t": at(1), "value": 1.0}]}]}

    monkeypatch.setattr(registry, "list_definitions", list_definitions)
    monkeypatch.setattr(registry, "effective", effective)
    monkeypatch.setattr(evaluator, "evaluate", evaluate)


def _plant(db, tenant=TENANT):
    return run(pl.plant(db, tenant, SITE, start=at(1), end=at(1, 3)))


def _slots(body, tag):
    (eq,) = [e for s in body["systems"] for e in s["equipment"] if e["tag"] == tag]
    return eq, {s["slot"]: s for s in eq["slots"]}


# ── each slot's state ────────────────────────────────────────────────────────


def test_every_slot_carries_one_of_the_five_states(metrics):
    body = _plant(FakeDb(**_estate()))
    _, slots = _slots(body, "CH-01")
    assert {k: v["readiness"] for k, v in slots.items()} == {
        "chws": "reporting", "chwr": "silent", "kw": "ambiguous",
        "load": "unresolved", "trip": "unbound",
    }
    assert body["readiness_states"] == list(sl.READINESS)


def test_a_reporting_slot_carries_its_point_its_latest_value_and_its_ghosts(metrics):
    _, slots = _slots(_plant(FakeDb(**_estate())), "CH-01")
    chws = slots["chws"]
    assert chws["point"]["point_id"] == pid(1)
    assert chws["point"]["unit_confirmed"] is True
    assert chws["latest"] == {"t": at(1, 2), "value": 7.25, "text": None}
    assert [g["point_id"] for g in chws["ghosts"]] == [pid(11)]
    assert chws["binding"] == {"device_tag": "CH1", "point_tag": "OWT"}


def test_a_silent_slot_names_its_point_but_draws_no_latest_value(metrics):
    """A silent point's last value is history. Drawing it beside the chiller
    would present an eight-day-old temperature as the current one."""
    _, slots = _slots(_plant(FakeDb(**_estate())), "CH-01")
    chwr = slots["chwr"]
    assert chwr["point"]["point_id"] == pid(2)
    assert chwr["latest"] is None
    # Its unit came off the wire and nobody typed one here. That used to read
    # as unconfirmed; the gateway is where a signal is described now, so a unit
    # that arrived IS the answer — and silence is a separate fact from it.
    assert chwr["point"]["unit_confirmed"] is True
    assert "no reading in the window" in chwr["reason"]


def test_an_ambiguous_slot_lists_every_candidate_and_names_no_point(metrics):
    _, slots = _slots(_plant(FakeDb(**_estate())), "CH-01")
    kw = slots["kw"]
    assert kw["point"] is None and kw["latest"] is None
    assert sorted(c["point_id"] for c in kw["candidates"]) == [pid(3), pid(13)]


def test_unresolved_and_unbound_say_different_things(metrics):
    _, slots = _slots(_plant(FakeDb(**_estate())), "CH-01")
    assert "`LOADD`" in slots["load"]["reason"]
    assert slots["trip"]["binding"] is None
    assert sl.RECORDED_AT in slots["trip"]["reason"]


# ── rolling up ───────────────────────────────────────────────────────────────


def test_equipment_and_system_roll_up_to_their_least_ready_part(metrics):
    body = _plant(FakeDb(**_estate()))
    ch1, _ = _slots(body, "CH-01")
    assert ch1["readiness"] == "ambiguous"
    assert ch1["readiness_counts"] == {"ambiguous": 1, "unresolved": 1, "silent": 1,
                                       "unbound": 1, "reporting": 1}
    assert body["systems"][0]["readiness"] == "ambiguous"


def test_a_slot_a_metric_needs_is_drawn_unbound_even_when_core_never_stated_it(metrics):
    """CH-02 has only `chwr`, and it reports. Without this it would be drawn
    green while its ΔT refuses for want of `chws`."""
    ch2, slots = _slots(_plant(FakeDb(**_estate())), "CH-02")
    assert slots["chwr"]["readiness"] == "reporting"
    assert slots["chws"]["readiness"] == "unbound"
    assert slots["chws"]["declared"] is False
    assert slots["chws"]["required_by"] == ["chw_delta_t"]
    assert slots["chwr"]["declared"] is True
    assert ch2["readiness"] == "unbound"


def test_totals_count_every_drawn_slot_by_state(metrics):
    body = _plant(FakeDb(**_estate()))
    assert body["totals"] == {"ambiguous": 1, "unresolved": 1, "silent": 1,
                              "unbound": 2, "reporting": 2}


# ── metrics per equipment ────────────────────────────────────────────────────


def test_each_equipment_carries_its_metric_outcome_without_the_series(metrics):
    body = _plant(FakeDb(**_estate()))
    ch1, _ = _slots(body, "CH-01")
    outcome = ch1["metrics"]["chw_delta_t"]
    assert outcome["status"] == "no_data" and "IWT" in outcome["reason"]
    assert "series" not in outcome
    assert [m["metric"] for m in body["metrics"]] == ["chw_delta_t"]
    assert body["metrics"][0]["slots"] == ["chwr", "chws"]


# ── what is not there ────────────────────────────────────────────────────────


def test_equipment_whose_system_is_unknown_is_listed_not_dropped(metrics):
    body = _plant(FakeDb(**_estate(systems=[])))
    assert body["systems"] == []
    assert {e["tag"] for e in body["unassigned_equipment"]} == {"CH-01", "CH-02"}


def test_a_site_nothing_is_known_about_is_a_404(metrics):
    from kernel.errors import NotFoundError

    db = FakeDb(sites=[], systems=[], equipment=[])
    with pytest.raises(NotFoundError):
        _plant(db)


def test_every_read_is_scoped_to_the_callers_tenant(metrics):
    db = FakeDb(**_estate())
    _plant(db)
    assert db.params["sites"][0]["tenant"] == str(TENANT)
    assert db.params["systems"][0]["tenant"] == str(TENANT)
    assert db.params["equipment"][0]["tenant"] == str(TENANT)


# ── over the wire ────────────────────────────────────────────────────────────


@pytest.fixture
def wired(app, metrics):
    from reporting.db import get_db

    state = {"db": FakeDb(**_estate())}

    async def _db():
        yield state["db"]

    app.dependency_overrides[get_db] = _db
    return state


@pytest.mark.asyncio
async def test_the_whole_shape_survives_serialisation(app, wired):
    from conftest import PREFIX, auth, client

    async with client(app) as c:
        resp = await c.get(f"{PREFIX}/bi/sites/{SITE}/plant",
                           headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["site_name"] == "HQ"
    ch1 = body["systems"][0]["equipment"][0]
    assert ch1["tag"] == "CH-01" and ch1["readiness"] == "ambiguous"
    assert {s["slot"]: s["readiness"] for s in ch1["slots"]}["chws"] == "reporting"


@pytest.mark.asyncio
async def test_the_tenant_is_the_tokens_and_a_query_parameter_cannot_widen_it(app, wired):
    from conftest import PREFIX, auth, client

    async with client(app) as c:
        resp = await c.get(f"{PREFIX}/bi/sites/{SITE}/plant?tenant_id={uuid.uuid4()}",
                           headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
    assert resp.status_code == 200
    assert wired["db"].params["equipment"][0]["tenant"] == str(TENANT)


@pytest.mark.asyncio
async def test_another_tenants_site_is_a_404_like_no_site_at_all(app, wired):
    from conftest import PREFIX, auth, client

    wired["db"] = FakeDb(sites=[], systems=[], equipment=[])
    async with client(app) as c:
        resp = await c.get(f"{PREFIX}/bi/sites/{SITE}/plant",
                           headers=auth(tenant_id=uuid.uuid4(), permissions=["bi.read"]))
    assert resp.status_code == 404


# ── the power chain's edges ──────────────────────────────────────────────────


def test_each_equipment_carries_what_feeds_it(metrics):
    """The single-line is drawn from this: a board names its feeder, and a
    feeder with none says so as null rather than being left out."""
    fed = {**_eq(CH2, "CH-02"), "fed_by_id": CH1}
    body = _plant(FakeDb(**_estate(equipment=[_eq(CH1, "CH-01"), fed])))
    first, _ = _slots(body, "CH-01")
    second, _ = _slots(body, "CH-02")
    assert first["fed_by_id"] is None
    assert second["fed_by_id"] == str(CH1)
