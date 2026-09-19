"""Gate 6 (ACTS) — what a finding hands to the work it raises.

The workflow service owns the work and whether it is already open; this process
owns the finding. So what is pinned here is the finding's side of the contract:

  * the evidence is the outcome, slot or alert row EXACTLY as the read returned
    it — the arithmetic string, the inputs, a refusal's reason — never a number
    recomputed or a sentence in place of the working;
  * the source key names the finding and nothing about its current reading, so
    the same chiller's ΔT band keeps its open work while the value moves;
  * only `silent` and `ambiguous` slots are data faults — `unbound` and
    `unresolved` are gate 4's, and raising work on them here would send the job
    to the wrong person;
  * the `work` block is a complete `POST /workflow/instances` body less the
    procedure, sized to the columns it lands in;
  * the routes are reads: the tenant is the token's, `bi.read` gates them, and
    nothing in this module can publish or call anything that raises work.
"""

from __future__ import annotations

import ast
import pathlib
import uuid

import pytest
from metric_fakes import FakeDb, at, run

from app.api import findings as fx
from app.api import plant as pl
from test_plant_endpoint import CH1, SITE, TENANT, _estate, metrics  # noqa: F401 — fixture

EID = "44444444-5555-6666-7777-888888888888"

_OK = {
    "equipment_id": EID, "status": "ok", "value": 41.66666, "unit": "%",
    "metric": "chw_delta_t_in_band", "version": 2, "coverage": 1.0,
    "arithmetic": "5 of 12 bucket(s) inside the band (`in_band(abs(owt - iwt), "
                  "dt_min, dt_max)`) = 41.6667%",
    "inputs": [
        {"input": "owt", "slot": "chws", "point_id": "p-1", "point_tag": "1FYC1_OWT",
         "unit": "degC", "aggregation": "avg", "value": 7.25, "buckets": 12, "samples": 12},
        {"input": "iwt", "slot": "chwr", "point_id": "p-2", "point_tag": "1FYC1_IWT",
         "unit": "degC", "aggregation": "avg", "value": 9.05, "buckets": 12, "samples": 12},
        {"input": "dt_min", "source": "equipment_fact", "fact": "design_dt_min",
         "value": 5.0, "unit": "K"},
    ],
}
_REFUSED = {"equipment_id": EID, "status": "slot_ambiguous", "value": None,
            "metric": "chiller_kw_per_tr", "version": 1,
            "reason": "slot `kw` → `KW` names 2 live generations"}


def _plant(*, outcomes=None, slots=None):
    return {
        "site_id": str(SITE), "site_name": "HQ",
        "window": {"start": at(1), "end": at(1, 1)},
        "metrics": [
            {"metric": "chw_delta_t_in_band", "label": "ΔT in band", "precision": 1},
            {"metric": "chiller_kw_per_tr", "label": "kW/TR", "precision": 2},
        ],
        "systems": [{"equipment": [{
            "equipment_id": EID, "tag": "CH-01", "name": "York 1F", "equipment_class": "chiller",
            "system_id": "sys", "design": {"design_dt_min": 5.0}, "design_units": {},
            "slots": slots or [],
            "metrics": outcomes if outcomes is not None else {
                "chw_delta_t_in_band": _OK, "chiller_kw_per_tr": _REFUSED},
        }]}],
        "unassigned_equipment": [],
    }


def _by_key(found):
    return {f["source_key"]: f for f in found}


# ── the evidence ─────────────────────────────────────────────────────────────


def test_a_metric_finding_carries_its_outcome_exactly_as_the_read_returned_it():
    f = _by_key(fx.plant_findings(_plant()))[fx.metric_key(EID, "chw_delta_t_in_band")]
    assert f["kind"] == "equipment_metric" and f["status"] == "ok"
    assert f["evidence"]["outcome"] == _OK, "copied, not rebuilt"
    assert f["evidence"]["equipment"]["tag"] == "CH-01"
    assert f["evidence"]["window"] == {"start": at(1).isoformat(), "end": at(1, 1).isoformat()}
    # A person reads the value at the metric's own precision, and the working and
    # the points it stands on, verbatim.
    assert f["title"] == "CH-01 · ΔT in band: 41.7 %"
    assert _OK["arithmetic"] in f["summary"]
    assert "`1FYC1_OWT` (chws slot), avg 7.25 degC" in f["summary"]
    assert "`1FYC1_IWT` (chwr slot), avg 9.05 degC" in f["summary"]
    assert "dt_min = 5 K (design fact `design_dt_min`)" in f["summary"]


def test_a_refusal_is_a_finding_with_its_reason_and_no_number():
    f = _by_key(fx.plant_findings(_plant()))[fx.metric_key(EID, "chiller_kw_per_tr")]
    assert f["status"] == "slot_ambiguous"
    assert f["title"] == "CH-01 · kW/TR: refused (slot_ambiguous)"
    assert "Reason: slot `kw` → `KW` names 2 live generations" in f["summary"]
    assert f["evidence"]["outcome"]["value"] is None


def test_the_work_block_is_the_whole_raise_body_but_the_procedure():
    f = fx.plant_findings(_plant())[0]
    work = f["work"]
    assert set(work) == {"source_key", "name", "description", "site_id", "trigger_data"}
    assert work["source_key"] == f["source_key"]
    assert work["site_id"] == str(SITE)
    assert work["name"] == f["title"] and work["description"] == f["summary"]
    env = work["trigger_data"]
    assert env["source"] == "bi" and env["raised_by"] == "operator"
    assert env["type"] == "bi.finding.equipment_metric"
    assert env["payload"] is f["evidence"]


def test_text_is_cut_to_the_columns_it_lands_in_and_the_evidence_is_not():
    long = dict(_REFUSED, reason="x" * 5000)
    f = _by_key(fx.plant_findings(_plant(outcomes={"chiller_kw_per_tr": long})))[
        fx.metric_key(EID, "chiller_kw_per_tr")]
    assert len(f["work"]["description"]) == 2048
    assert f["work"]["description"].endswith("…")
    assert f["evidence"]["outcome"]["reason"] == "x" * 5000


# ── the source key ───────────────────────────────────────────────────────────


def test_the_key_names_the_finding_not_its_current_reading():
    """The same chiller's ΔT band is ONE finding whether it reads 41.7% or has
    started refusing — so its open work keeps answering for it."""
    now = _plant(outcomes={"chw_delta_t_in_band": _OK})
    later = _plant(outcomes={"chw_delta_t_in_band": dict(
        _REFUSED, metric="chw_delta_t_in_band", version=3, status="no_data")})
    assert [f["source_key"] for f in fx.plant_findings(now)] == \
        [f["source_key"] for f in fx.plant_findings(later)] == \
        [f"bi:equipment:{EID}:metric:chw_delta_t_in_band"]


def test_metric_and_slot_keys_cannot_collide():
    assert fx.metric_key(EID, "chws") != fx.slot_key(EID, "chws")


# ── data faults ──────────────────────────────────────────────────────────────


def test_only_silent_and_ambiguous_slots_are_data_faults(metrics):  # noqa: F811
    """CH-01 has one slot in every state (see test_plant_endpoint._estate)."""
    body = run(pl.plant(FakeDb(**_estate()), TENANT, SITE, start=at(1), end=at(1, 3)))
    faults = [f for f in fx.plant_findings(body) if f["kind"] == "data_fault"]
    assert {(f["equipment_tag"], f["evidence"]["slot"]["slot"], f["status"])
            for f in faults} == {("CH-01", "chwr", "silent"), ("CH-01", "kw", "ambiguous")}
    silent = next(f for f in faults if f["status"] == "silent")
    assert silent["source_key"] == f"bi:equipment:{CH1}:slot:chwr"
    assert silent["title"] == "CH-01 · CHW return (entering) temperature (chwr): silent"
    assert "Bound to: `IWT` on `CH1`" in silent["summary"]
    assert silent["work"]["trigger_data"]["type"] == "bi.finding.data_fault"


# ── alerts ───────────────────────────────────────────────────────────────────

_ALERT = {"ts": at(1, 2), "alert_id": uuid.UUID(int=7), "severity": "critical",
          "alert_type": "range", "device_tag": "EM-3", "device_category": "energy",
          "device_type": None, "device_id": None, "point_id": None,
          "point_addr": "aeon/B2_Main Incomer/CAvg_A", "message": "CAvg_A 412 > 400",
          "conn_slug": "aeon", "proto": "modbus"}


def test_an_alert_is_a_finding_in_the_gateways_own_words():
    f = fx.alert_finding(_ALERT)
    assert f["source_key"] == f"bi:iot_alert:{uuid.UUID(int=7)}"
    work = f["work"]
    assert work["name"] == "EM-3 · critical range: CAvg_A 412 > 400"
    assert "Point: aeon/B2_Main Incomer/CAvg_A" in work["description"]
    assert work["trigger_data"]["payload"]["alert"] == _ALERT
    # The gateway knows no site, so the work names none rather than a guessed one.
    assert work["site_id"] is None


# ── over the wire ────────────────────────────────────────────────────────────


@pytest.fixture
def wired(app, metrics):  # noqa: F811
    from reporting.db import get_db

    state = {"db": FakeDb(**_estate())}

    async def _db():
        yield state["db"]

    app.dependency_overrides[get_db] = _db
    return state


@pytest.mark.asyncio
async def test_site_findings_over_http_are_the_plants_under_the_tokens_tenant(app, wired):
    from conftest import PREFIX, auth, client

    async with client(app) as c:
        r = await c.get(f"{PREFIX}/bi/sites/{SITE}/findings?tenant_id={uuid.uuid4()}",
                        headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["site_name"] == "HQ"
    keys = {f["source_key"] for f in body["findings"]}
    assert f"bi:equipment:{CH1}:metric:chw_delta_t" in keys
    assert f"bi:equipment:{CH1}:slot:kw" in keys
    assert wired["db"].params["equipment"][0]["tenant"] == str(TENANT)


@pytest.mark.asyncio
async def test_site_findings_need_bi_read(app, wired):
    from conftest import PREFIX, auth, client

    async with client(app) as c:
        r = await c.get(f"{PREFIX}/bi/sites/{SITE}/findings",
                        headers=auth(tenant_id=TENANT, permissions=["iot.read"]))
    assert r.status_code == 403
    assert wired["db"].asked == []


@pytest.mark.asyncio
async def test_every_alert_in_the_feed_carries_its_finding(app, monkeypatch):
    from conftest import PREFIX, auth, client

    from app.api import queries as q

    async def alerts(db, tenant, **kw):
        return {"available": True, "window_hours": 24, "start": at(1), "end": at(2),
                "generated_at": at(2), "total": 1, "by_severity": [], "by_category": [],
                "items": [dict(_ALERT)]}

    monkeypatch.setattr(q, "alerts", alerts)
    async with client(app) as c:
        r = await c.get(f"{PREFIX}/bi/alerts",
                        headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
    assert r.status_code == 200, r.text
    item = r.json()["items"][0]
    assert item["source_key"] == f"bi:iot_alert:{uuid.UUID(int=7)}"
    assert item["work"]["source_key"] == item["source_key"]
    assert item["work"]["trigger_data"]["payload"]["alert"]["message"] == "CAvg_A 412 > 400"


# ── nothing raises work on its own ───────────────────────────────────────────


def test_the_findings_module_can_reach_nothing_that_raises_work():
    """Gate 6 raises on an explicit request only — the console's POST to the
    workflow service. This module composes; if it could publish on the bus or
    call out over HTTP, "listing the findings" could raise them."""
    src = (pathlib.Path(fx.__file__)).read_text()
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            imported |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            imported.add(("." * node.level) + (node.module or ""))
    assert imported <= {"__future__", "datetime", "typing", "..metric_registry"}, imported
