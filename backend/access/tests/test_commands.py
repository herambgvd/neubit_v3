"""The command surface: what actually goes to the controller, per route.

Fourteen routes that unlock doors, arm and disarm alarm zones, initialise
controllers and start and stop polling — the half of this service that ACTS on a
building. Before this file none of them had been called by a test with a valid
key: `test_route_inventory.py` proves they refuse the wrong caller, and that is a
different question from whether the right caller's request is the one that
arrives.

These are wrong-in-a-way-that-looks-right by nature. `alarm_zone.disarm` sent
where `alarm_zone.arm` was meant returns `{"ok": true}` either way; a `period`
dropped from an activate turns a timed unlock into a permanent one, and the
response is identical. So the assertion is on the action key and the exact body,
not on the status code.

Same seam as the write-through tests — `get_connector` — for the same reason: it
is the only thing between this service and a real DDS box, and monkeypatching it
runs everything else for real.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.access.crypto import encrypt_secret
from app.access.models import Instance

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
COMMAND = ["access.read", "access.command"]
SECRET = "controller-password-1"


class FakeConnector:
    def __init__(self, log: list, secret: str | None) -> None:
        self.log = log
        self.secret = secret

    async def invoke_action(self, action_key, params):
        self.log.append(("action", action_key, params))
        return {"Status": "Accepted"}

    async def list_hardware(self, hardware_set):
        self.log.append(("hardware", hardware_set))
        return [{"UID": f"H-{i}"} for i in range(10)]

    async def list_collection(self, collection):
        self.log.append(("collection", collection))
        return [{"UID": f"S-{i}"} for i in range(10)]

    async def aclose(self):
        pass


@pytest.fixture
def controller(monkeypatch):
    log: list = []
    secrets: list = []

    def _fake(row, secret=None):
        secrets.append(secret)
        return FakeConnector(log, secret)

    monkeypatch.setattr("app.access.commands.get_connector", _fake)
    return {"log": log, "secrets": secrets}


async def _instance(session, tenant_id) -> str:
    row = Instance(
        tenant_id=tenant_id, brand="dds", name=f"ctrl-{uuid.uuid4().hex[:8]}",
        base_url="https://controller.example", auth_type="basic", username="svc",
        secret_enc=encrypt_secret(tenant_id, SECRET),
        verify_tls=True, is_active=True, status="unknown",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return str(row.id)


# ── outputs ──────────────────────────────────────────────────────────────────

async def test_activate_carries_the_period_and_the_others_do_not(app, session, controller):
    """`period` is the difference between a timed unlock and a permanent one. It
    belongs on activate and on nothing else, and both halves matter."""
    iid = await _instance(session, TENANT_A)
    body = {"uids": ["O-1"], "api_keys": ["K-1"], "period": "30"}
    async with _client(app) as c:
        for path in ("activate", "activate_continuous", "deactivate", "return_to_normal"):
            r = await c.post(
                f"{PREFIX}/access/instances/{iid}/commands/outputs/{path}",
                headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
                json=body,
            )
            assert r.status_code == 200, f"{path}: {r.text}"

    sent = {key: params for _, key, params in controller["log"]}
    assert sent["output.activate"] == {"uids": ["O-1"], "apiKeys": ["K-1"], "period": "30"}
    for key in ("output.activate_continuous", "output.deactivate",
                "output.return_to_normal"):
        assert sent[key] == {"uids": ["O-1"], "apiKeys": ["K-1"]}, key


async def test_an_empty_target_list_is_omitted_rather_than_sent_empty(
    app, session, controller
):
    """DDS reads an empty `uids` differently from an absent one."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/deactivate",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
            json={"uids": ["O-1"], "api_keys": []},
        )
    assert r.status_code == 200, r.text
    _, key, params = controller["log"][0]
    assert key == "output.deactivate"
    assert params == {"uids": ["O-1"]}
    assert "apiKeys" not in params


@pytest.mark.parametrize(
    "path,action",
    [("open_all_doors", "output.open_all_doors"),
     ("return_to_normal_all", "output.return_to_normal_all")],
)
async def test_the_estate_wide_outputs_take_no_body(app, session, controller, path, action):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/{path}",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
        )
    assert r.status_code == 200, r.text
    assert controller["log"] == [("action", action, {})]


# ── alarm zones, controllers, sites ──────────────────────────────────────────

async def test_arm_defaults_to_constant_and_stringifies_is_minute(
    app, session, controller
):
    """`isMinute` goes on the wire as the strings "true"/"false", not as a bool."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        defaulted = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/alarm-zones/Z-1/arm",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
            json={},
        )
        explicit = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/alarm-zones/Z-2/arm",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
            json={"arm_type": "ArmForDuration", "period": "15", "is_minute": True},
        )
    assert defaulted.status_code == 200, defaulted.text
    assert explicit.status_code == 200, explicit.text
    assert controller["log"][0] == (
        "action", "alarm_zone.arm", {"uid": "Z-1", "armType": "ArmConstant"},
    )
    assert controller["log"][1] == (
        "action", "alarm_zone.arm",
        {"uid": "Z-2", "armType": "ArmForDuration", "period": "15", "isMinute": "true"},
    )


async def test_disarm_is_its_own_action_and_its_own_default(app, session, controller):
    """Arming and disarming differ by one string. Both return {"ok": true}."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/alarm-zones/Z-1/disarm",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
            json={},
        )
    assert r.status_code == 200, r.text
    assert controller["log"] == [
        ("action", "alarm_zone.disarm", {"uid": "Z-1", "disarmType": "DisarmConstant"}),
    ]


@pytest.mark.parametrize(
    "path,action",
    [
        ("alarm-zones/Z-1/return-to-schedule", "alarm_zone.return_to_schedule"),
        ("controllers/C-1/initialize", "controller.initialize"),
        ("sites/S-1/polling/start", "site.start_polling"),
        ("sites/S-1/polling/stop", "site.stop_polling"),
    ],
)
async def test_the_uid_only_commands_send_the_uid_they_were_given(
    app, session, controller, path, action
):
    iid = await _instance(session, TENANT_A)
    uid = path.split("/")[1]
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/{path}",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
        )
    assert r.status_code == 200, r.text
    assert controller["log"] == [("action", action, {"uid": uid})]


# ── the proxies ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "segment,name,expected_call",
    [
        ("hardware", "alarm-zones", ("hardware", "alarm_zones")),
        ("scheduled", "scheduled-mags", ("collection", "scheduled_mags")),
    ],
)
async def test_the_proxies_normalise_the_set_name_and_window_the_result(
    app, session, controller, segment, name, expected_call
):
    """The controller returns the whole collection; the paging is done here. A
    `limit` that is accepted and not applied is how one screen fetches ten
    thousand rows."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/instances/{iid}/{segment}/{name}?skip=2&limit=3",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
        )
    assert r.status_code == 200, r.text
    # The dashed spelling reaches the connector underscored.
    assert controller["log"] == [expected_call]
    body = r.json()
    assert body["count"] == 3
    assert [i["dds_uid"] if "dds_uid" in i else i["UID"] for i in body["items"]] == [
        f"{'H' if segment == 'hardware' else 'S'}-{i}" for i in (2, 3, 4)
    ]


# ── the guards ───────────────────────────────────────────────────────────────

async def test_another_tenant_never_reaches_the_controller(app, session, controller):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/open_all_doors",
            headers=auth(tenant_id=TENANT_B, permissions=COMMAND),
        )
    assert r.status_code == 404, r.text
    assert controller["log"] == []
    assert controller["secrets"] == []


async def test_the_connector_is_given_the_decrypted_secret(app, session, controller):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/open_all_doors",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
        )
    assert controller["secrets"] == [SECRET], controller["secrets"]


async def test_config_rights_cannot_open_every_door(app, session, controller):
    """`output.open_all_doors` is the reason the permission split exists."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/open_all_doors",
            headers=auth(tenant_id=TENANT_A, permissions=["access.read", "access.manage"]),
        )
    assert r.status_code == 403, r.text
    assert controller["log"] == []


async def test_a_dead_controller_is_502_and_never_500(app, session, monkeypatch):
    """`_invoke` catches bare Exception on purpose — a controller that is off must
    not be an internal error. That catch is load-bearing and is asserted here."""
    iid = await _instance(session, TENANT_A)

    class Dead:
        async def invoke_action(self, action_key, params):
            raise OSError("connection refused")

        async def aclose(self):
            pass

    monkeypatch.setattr("app.access.commands.get_connector", lambda row, secret=None: Dead())
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/open_all_doors",
            headers=auth(tenant_id=TENANT_A, permissions=COMMAND),
        )
    assert r.status_code == 502, r.text
    assert r.json()["error"]["code"] == "UPSTREAM_ERROR", r.text
