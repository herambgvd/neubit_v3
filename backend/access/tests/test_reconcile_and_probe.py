"""The last two routes: /test-connection and /reconcile.

Both talk to the controller, and both promise NEVER to 500 when it is not there —
`test_connection` records the outcome on the instance and answers ok/error, and
`reconcile` records a degraded job rather than failing the request. A promise like
that is only worth what a test says it is, so the unreachable path is asserted as
carefully as the working one.

`reconcile` is also the only thing that DELETES from the mirror. Its orphan
cleanup works off a seen-set: anything in the mirror for a collection that the
controller did not return this time goes. That is correct when the controller
answered and dangerous when it did not, which is why a collection whose fetch
FAILED must not be treated as a collection that returned nothing — the test below
would be the one to notice if it ever were.

Same seam as the other two controller files: `get_connector`, here on
`app.access.service`.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from conftest import PREFIX, _client, auth
from app.access.crypto import encrypt_secret
from app.access.models import AccessMirror, Instance
from app.connectors.base import ConnectionResult

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
MANAGE = ["access.read", "access.manage"]
SECRET = "controller-password-1"


class FakeConnector:
    """`collections` maps a collection name to the DTOs it returns, or to an
    Exception to raise for it."""

    def __init__(self, log, secret, *, probe=None, collections=None):
        self.log = log
        self.secret = secret
        self._probe = probe if probe is not None else ConnectionResult(ok=True, detail={"v": "1"})
        self._collections = collections or {}

    async def test_connection(self):
        self.log.append(("probe",))
        return self._probe

    async def list_collection(self, collection):
        self.log.append(("list", collection))
        got = self._collections.get(collection, [])
        if isinstance(got, Exception):
            raise got
        return got

    @staticmethod
    def uid_of(dto):
        return dto.get("UID")

    async def aclose(self):
        pass


@pytest.fixture
def controller(monkeypatch):
    state = {"log": [], "secrets": [], "probe": None, "collections": {}}

    def _fake(row, secret=None):
        state["secrets"].append(secret)
        return FakeConnector(
            state["log"], secret,
            probe=state["probe"], collections=state["collections"],
        )

    monkeypatch.setattr("app.access.service.get_connector", _fake)
    return state


async def _instance(session, tenant_id) -> Instance:
    row = Instance(
        tenant_id=tenant_id, brand="dds", name=f"ctrl-{uuid.uuid4().hex[:8]}",
        base_url="https://controller.example", auth_type="basic", username="svc",
        secret_enc=encrypt_secret(tenant_id, SECRET),
        verify_tls=True, is_active=True, status="unknown",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


# ── test-connection ──────────────────────────────────────────────────────────

async def test_a_successful_probe_marks_the_instance_online(app, session, controller):
    inst = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/test-connection",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    await session.refresh(inst)
    assert inst.status == "online"
    assert inst.last_connected_at is not None
    assert inst.last_error is None
    assert controller["secrets"] == [SECRET]


async def test_a_failed_probe_is_recorded_not_raised(app, session, controller):
    """The whole point of this route is that an unreachable controller is an
    ANSWER. A 500 here would make "is it plugged in" unanswerable from the UI."""
    controller["probe"] = ConnectionResult(ok=False, error="connection refused")
    inst = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/test-connection",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["error"] == "connection refused"
    await session.refresh(inst)
    assert inst.status == "offline"
    assert inst.last_error == "connection refused"


async def test_a_later_success_clears_the_recorded_error(app, session, controller):
    """A stale last_error on an instance that is back up reads as a live fault."""
    controller["probe"] = ConnectionResult(ok=False, error="connection refused")
    inst = await _instance(session, TENANT_A)
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/access/instances/{inst.id}/test-connection",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
        controller["probe"] = ConnectionResult(ok=True, detail={})
        await c.post(
            f"{PREFIX}/access/instances/{inst.id}/test-connection",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    await session.refresh(inst)
    assert inst.status == "online"
    assert inst.last_error is None


async def test_another_tenant_cannot_probe_the_controller(app, session, controller):
    inst = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/test-connection",
            headers=auth(tenant_id=TENANT_B, permissions=MANAGE),
        )
    assert r.status_code == 404, r.text
    assert controller["log"] == []


# ── reconcile ────────────────────────────────────────────────────────────────

async def _mirror_uids(session, instance_id, collection):
    rows = (await session.execute(
        select(AccessMirror).where(
            AccessMirror.instance_id == instance_id,
            AccessMirror.collection == collection,
        )
    )).scalars().all()
    return {r.remote_uid for r in rows}


async def test_reconcile_mirrors_what_the_controller_returns(app, session, controller):
    inst = await _instance(session, TENANT_A)
    controller["collections"] = {
        "cardholders": [{"UID": "CH-1", "LastName": "Rao"}, {"UID": "CH-2"}],
        "cards": [{"UID": "CARD-1"}],
    }
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["status"] == "succeeded", job["status"]
    assert job["created_count"] == 3
    assert await _mirror_uids(session, inst.id, "cardholders") == {"CH-1", "CH-2"}
    assert await _mirror_uids(session, inst.id, "cards") == {"CARD-1"}


async def test_reconcile_removes_what_the_controller_no_longer_has(
    app, session, controller
):
    """A cardholder deleted on the controller must stop existing here too — the
    mirror is not an archive, and a stale row is a credential that looks live."""
    inst = await _instance(session, TENANT_A)
    controller["collections"] = {"cardholders": [{"UID": "CH-1"}, {"UID": "CH-2"}]}
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
        assert await _mirror_uids(session, inst.id, "cardholders") == {"CH-1", "CH-2"}

        controller["collections"] = {"cardholders": [{"UID": "CH-1"}]}
        second = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert second.status_code == 200, second.text
    assert second.json()["deleted_count"] == 1
    assert await _mirror_uids(session, inst.id, "cardholders") == {"CH-1"}


async def test_a_collection_that_failed_to_fetch_does_not_empty_the_mirror(
    app, session, controller
):
    """The orphan cleanup works off what the controller returned. A FETCH FAILURE
    is not "the controller returned nothing", and treating it as one would wipe
    every mirrored credential the moment one collection timed out."""
    inst = await _instance(session, TENANT_A)
    controller["collections"] = {"cardholders": [{"UID": "CH-1"}, {"UID": "CH-2"}]}
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
        assert await _mirror_uids(session, inst.id, "cardholders") == {"CH-1", "CH-2"}

        controller["collections"] = {"cardholders": OSError("connection reset")}
        degraded = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert degraded.status_code == 200, degraded.text
    assert degraded.json()["error_count"] >= 1
    assert await _mirror_uids(session, inst.id, "cardholders") == {"CH-1", "CH-2"}


async def test_a_dead_controller_is_a_degraded_job_not_a_500(app, session, controller):
    inst = await _instance(session, TENANT_A)
    controller["collections"] = {
        name: OSError("connection refused")
        for name in ("cardholders", "cards", "scheduled_mags", "scheduled_readers")
    }
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["status"] != "succeeded", job
    assert job["error_count"] >= 1


async def test_the_job_is_visible_afterwards(app, session, controller):
    """`/sync-jobs` is where an operator finds out whether the last run worked."""
    inst = await _instance(session, TENANT_A)
    controller["collections"] = {"cardholders": [{"UID": "CH-1"}]}
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
        listed = await c.get(
            f"{PREFIX}/access/instances/{inst.id}/sync-jobs",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
    assert listed.status_code == 200, listed.text
    assert made.json()["id"] in [j["id"] for j in listed.json()["items"]]


async def test_another_tenant_cannot_trigger_a_reconcile(app, session, controller):
    inst = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{inst.id}/reconcile",
            headers=auth(tenant_id=TENANT_B, permissions=MANAGE),
        )
    assert r.status_code == 404, r.text
    assert controller["log"] == []
