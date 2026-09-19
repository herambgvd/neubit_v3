"""A finding raises work ONCE — ``source_key`` on the incident.

Building Intelligence's gate 6 (ACTS) turns a finding into work: a chiller's ΔT
band, a silent slot, a gateway alert. The producer names the finding in
``source_key`` and hands its evidence over in ``trigger_data``; this service owns
whether work for that key is already open, because it owns the work. So these
tests hold, over HTTP:

  * raised work carries its evidence and its key, verbatim;
  * a second raise while that work is OPEN returns the open incident (200), with
    nothing written — and a raise once it has CLOSED is new work (201);
  * the dedup survives the race the pre-check cannot see: the partial unique
    index refuses the second insert and the loser returns the winner's row;
  * "which of these keys have open work" answers every asked key exactly once;
  * all of it is per tenant, the tenant is the token's, and both routes are
    gated by the keys the rest of the incident API already uses;
  * nothing raises work on its own: the lookup writes nothing, and the
    correlation engine does not listen where BI's findings are published.

Not here: "a raise with no key is never deduplicated". It is true, but no single
line holds it — the pre-check is skipped for a NULL key AND `source_key IN
(NULL)` matches nothing AND the index excludes NULL keys — so no one-line
mutation can make a test of it fail, and a test no mutation can fail proves
nothing. The Postgres half (keyless rows coexist under the index) was checked on
a throwaway database when 0010 was written.
"""

from __future__ import annotations

import pathlib
import re
import uuid

import pytest
from sqlalchemy import func, select

from kernel.auth import Scope

from app.workflow.core.enums import CLOSED_STATUSES
from app.workflow.instances import models as IM
from app.workflow.instances.models import WorkflowInstance
from app.workflow.instances.service import InstanceService
from app.workflow.sops.service import SopService
from conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
RAISE = ["workflow.instance.create", "workflow.instance.read", "workflow.instance.update"]
URL = f"{PREFIX}/workflow/instances"
KEY = "bi:equipment:44444444-5555-6666-7777-888888888888:metric:chw_delta_t_in_band"


class _Actor:
    user_id = "operator-1"
    id = "operator-1"


async def _general_sop(sm, tenant) -> str:
    """The catch-all starter's id — a real SOP with a real initial state."""
    async with sm() as db:
        created, _ = await SopService(
            db, Scope(tenant_id=tenant, is_superadmin=False)
        ).install_starters(actor=_Actor())
    return next(s.sop_id for s in created if s.name == "General alarm")


def _evidence(value=41.7):
    """The shape reading-writer's finding hands over — copied, never recomputed."""
    return {
        "source": "bi", "raised_by": "operator", "type": "bi.finding.equipment_metric",
        "payload": {
            "source_key": KEY, "equipment_tag": "CH-01", "metric": "chw_delta_t_in_band",
            "outcome": {"status": "ok", "value": value, "unit": "%",
                        "arithmetic": "5 of 12 bucket(s) inside the band = 41.6667%"},
            "window": {"start": "2026-09-19T09:00:00Z", "end": "2026-09-19T10:00:00Z"},
        },
    }


def _body(sop_id, **over):
    body = {"sop_id": sop_id, "source_key": KEY, "site_id": str(uuid.uuid4()),
            "name": "CH-01 · ΔT in band 41.7 %", "description": "5 of 12 buckets in band",
            "trigger_data": _evidence()}
    body.update(over)
    return body


async def _count(sm, **where) -> int:
    async with sm() as db:
        stmt = select(func.count()).select_from(WorkflowInstance)
        for col, val in where.items():
            stmt = stmt.where(getattr(WorkflowInstance, col) == val)
        return int(await db.scalar(stmt))


# ── raising ──────────────────────────────────────────────────────────────────


async def test_raised_work_carries_the_evidence_and_the_source_key(app, http_sessionmaker):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    async with client(app) as c:
        made = await c.post(URL, headers=auth(tenant_id=TENANT_A, permissions=RAISE),
                            json=_body(sop))
        assert made.status_code == 201, made.text
        got = await c.get(f"{URL}/{made.json()['instance_id']}",
                          headers=auth(tenant_id=TENANT_A, permissions=RAISE))
    body = got.json()
    assert body["source_key"] == KEY
    assert body["trigger_data"] == _evidence(), "the evidence is stored as handed over"
    assert body["name"] == "CH-01 · ΔT in band 41.7 %"
    # The envelope's own `source` is what the incident list's Source filter reads.
    assert body["event_source"] == "bi"


async def test_a_second_raise_while_work_is_open_returns_that_work(app, http_sessionmaker):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    hdr = auth(tenant_id=TENANT_A, permissions=RAISE)
    async with client(app) as c:
        first = await c.post(URL, headers=hdr, json=_body(sop))
        # A later raise with DIFFERENT evidence is still the same finding.
        again = await c.post(URL, headers=hdr, json=_body(sop, trigger_data=_evidence(12.0),
                                                           name="something else"))
    assert first.status_code == 201
    assert again.status_code == 200, again.text
    assert again.json()["instance_id"] == first.json()["instance_id"]
    assert again.json()["trigger_data"] == _evidence(), "the open work was not rewritten"
    assert await _count(http_sessionmaker, source_key=KEY) == 1


@pytest.mark.parametrize("closing", ["resolved", "cancelled"])
async def test_once_that_work_has_closed_a_raise_is_new_work(app, http_sessionmaker, closing):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    hdr = auth(tenant_id=TENANT_A, permissions=RAISE)
    async with client(app) as c:
        first = (await c.post(URL, headers=hdr, json=_body(sop))).json()["instance_id"]
        shut = await c.patch(f"{URL}/{first}/status", headers=hdr,
                             json={"status": closing, "outcome": "fixed the valve"})
        assert shut.status_code == 200, shut.text
        again = await c.post(URL, headers=hdr, json=_body(sop))
    assert again.status_code == 201, again.text
    assert again.json()["instance_id"] != first
    assert await _count(http_sessionmaker, source_key=KEY) == 2


async def test_the_race_the_pre_check_cannot_see_is_held_by_the_index(
    http_sessionmaker, monkeypatch
):
    """Two raises both pass the "is there open work" check, then both INSERT. The
    partial unique index refuses the second, and it returns the first's row."""
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    scope = Scope(tenant_id=TENANT_A, is_superadmin=False)
    from app.workflow.instances import schemas as S

    async with http_sessionmaker() as db:
        winner, created = await InstanceService(db, scope).create_or_existing(
            S.CreateInstanceRequest(**_body(sop)), actor=_Actor())
    assert created

    real = InstanceService._open_for_source
    calls = {"n": 0}

    async def blind_first(self, key):
        calls["n"] += 1
        return None if calls["n"] == 1 else await real(self, key)

    monkeypatch.setattr(InstanceService, "_open_for_source", blind_first)
    async with http_sessionmaker() as db:
        loser, created = await InstanceService(db, scope).create_or_existing(
            S.CreateInstanceRequest(**_body(sop)), actor=_Actor())
    assert created is False
    assert loser.instance_id == winner.instance_id
    assert await _count(http_sessionmaker, source_key=KEY) == 1


async def test_the_index_predicate_is_exactly_the_closed_statuses():
    """A partial index predicate is a literal; CLOSED_STATUSES is Python. If they
    drift, work in a newly-added closed status still blocks its finding forever
    (or an open one stops blocking it). The model and the migration must both
    spell the same set."""
    closed = {s.value for s in CLOSED_STATUSES}
    in_model = set(re.findall(r"'(\w+)'", IM.OPEN_SOURCE_KEY_PREDICATE))
    assert in_model == closed
    mig = (pathlib.Path(__file__).resolve().parents[1]
           / "migrations" / "versions" / "0010_instance_source_key.py").read_text()
    clause = re.search(r"status NOT IN \(([^)]*)\)", mig).group(1)
    assert set(re.findall(r"'(\w+)'", clause)) == closed


async def test_a_key_without_a_namespace_is_refused(app, http_sessionmaker):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    async with client(app) as c:
        r = await c.post(URL, headers=auth(tenant_id=TENANT_A, permissions=RAISE),
                         json=_body(sop, source_key="chiller-1"))
    assert r.status_code == 422, r.text
    assert await _count(http_sessionmaker) == 0


# ── which keys have open work ────────────────────────────────────────────────


async def test_the_lookup_answers_every_asked_key_exactly_once(app, http_sessionmaker):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    hdr = auth(tenant_id=TENANT_A, permissions=RAISE)
    closed_key = "bi:iot_alert:closed-one"
    async with client(app) as c:
        opened = (await c.post(URL, headers=hdr, json=_body(sop))).json()
        gone = (await c.post(URL, headers=hdr,
                             json=_body(sop, source_key=closed_key))).json()["instance_id"]
        await c.patch(f"{URL}/{gone}/status", headers=hdr, json={"status": "cancelled"})
        before = await _count(http_sessionmaker)
        r = await c.post(f"{URL}/open-by-source", headers=hdr, json={
            "source_keys": [KEY, "bi:iot_alert:never", closed_key, KEY, "bi:iot_alert:never"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert list(body["with_work"]) == [KEY]
    ref = body["with_work"][KEY]
    assert ref["instance_id"] == opened["instance_id"]
    assert ref["status"] == "active" and ref["sop_name"] == "General alarm"
    # Closed work is not open work, and a duplicate ask is answered once.
    assert body["without_work"] == ["bi:iot_alert:never", closed_key]
    # Asking is not raising — the gate strip reads this on every render.
    assert await _count(http_sessionmaker) == before


async def test_the_lookup_is_bounded(app):
    async with client(app) as c:
        r = await c.post(f"{URL}/open-by-source",
                         headers=auth(tenant_id=TENANT_A, permissions=RAISE),
                         json={"source_keys": [f"bi:k:{i}" for i in range(501)]})
    assert r.status_code == 422


async def test_the_correlation_engine_does_not_listen_where_findings_are_published():
    """Gate 6 raises work on an explicit request only. BI's alerts ride
    `tenant.<id>.iot.alert.*`; a correlation pattern that caught them would turn
    every gateway alert into an incident with nobody having asked."""
    from app.workflow.correlation.engine import SUBSCRIBE_PATTERNS

    def caught(subject):
        for pat in SUBSCRIBE_PATTERNS:
            p = pat.split(".")
            s = subject.split(".")
            ok = True
            for i, tok in enumerate(p):
                if tok == ">":
                    break
                if i >= len(s) or (tok != "*" and tok != s[i]):
                    ok = False
                    break
            else:
                ok = len(p) == len(s)
            if ok:
                return True
        return False

    for subject in ("tenant.t1.iot.alert.raised", "tenant.t1.bi.finding.raised",
                    "tenant.t1.reporting.metric.evaluated"):
        assert not caught(subject), subject


# ── tenant scope ─────────────────────────────────────────────────────────────


async def test_another_tenants_open_work_is_neither_returned_nor_blocking(
    app, http_sessionmaker
):
    sop_a = await _general_sop(http_sessionmaker, TENANT_A)
    sop_b = await _general_sop(http_sessionmaker, TENANT_B)
    async with client(app) as c:
        a = await c.post(URL, headers=auth(tenant_id=TENANT_A, permissions=RAISE),
                         json=_body(sop_a))
        seen_by_b = await c.post(f"{URL}/open-by-source",
                                 headers=auth(tenant_id=TENANT_B, permissions=RAISE),
                                 json={"source_keys": [KEY]})
        b = await c.post(URL, headers=auth(tenant_id=TENANT_B, permissions=RAISE),
                         json=_body(sop_b))
    assert seen_by_b.json()["with_work"] == {}
    assert b.status_code == 201, "B's finding is B's; A's open work must not answer for it"
    assert b.json()["instance_id"] != a.json()["instance_id"]


async def test_the_tenant_is_the_tokens_not_the_bodys(app, http_sessionmaker):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    async with client(app) as c:
        r = await c.post(URL, headers=auth(tenant_id=TENANT_A, permissions=RAISE),
                         json=_body(sop, tenant_id=str(TENANT_B)))
    assert r.status_code == 201
    assert await _count(http_sessionmaker, tenant_id=TENANT_A) == 1
    assert await _count(http_sessionmaker, tenant_id=TENANT_B) == 0


# ── permissions ──────────────────────────────────────────────────────────────


async def test_raising_needs_the_create_key_and_writes_nothing_without_it(
    app, http_sessionmaker
):
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    async with client(app) as c:
        r = await c.post(URL, json=_body(sop), headers=auth(
            tenant_id=TENANT_A,
            permissions=["workflow.instance.read", "workflow.instance.update"]))
    assert r.status_code == 403
    assert await _count(http_sessionmaker) == 0


async def test_the_lookup_needs_the_read_key(app):
    async with client(app) as c:
        r = await c.post(f"{URL}/open-by-source", json={"source_keys": [KEY]},
                         headers=auth(tenant_id=TENANT_A,
                                      permissions=["workflow.instance.create"]))
    assert r.status_code == 403


# ── the request refuses what the column cannot hold ──────────────────────────


async def test_a_name_longer_than_the_column_is_a_422_not_a_500(app, http_sessionmaker):
    """`name` is String(512) and `description` String(2048). With no limit on the
    request they reached Postgres, which is a 500 — an error that names no field
    and reads as the server's fault for a request the API could have refused."""
    sop = await _general_sop(http_sessionmaker, TENANT_A)
    hdr = auth(tenant_id=TENANT_A, permissions=RAISE)
    async with client(app) as c:
        long_name = await c.post(URL, headers=hdr,
                                 json=_body(sop, source_key=None, name="x" * 513))
        long_desc = await c.post(URL, headers=hdr,
                                 json=_body(sop, source_key=None, description="y" * 2049))
        # The edge itself still fits: the limit is the column's, not one under it.
        edge = await c.post(URL, headers=hdr,
                            json=_body(sop, source_key=None,
                                       name="x" * 512, description="y" * 2048))
    assert long_name.status_code == 422, long_name.text
    assert long_desc.status_code == 422, long_desc.text
    assert edge.status_code == 201, edge.text
    assert await _count(http_sessionmaker) == 1, "neither refusal wrote a row"
