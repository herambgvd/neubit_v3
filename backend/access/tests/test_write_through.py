"""Cardholders and cards — the credential surface, through a fake controller.

These routes write to the controller FIRST and mirror the result locally, so they
were untestable without a DDS box and were therefore untested. `get_connector` is
the seam: one monkeypatch and the whole path runs — permission gate, instance
ownership, credential decrypt, DDS body mapping, mirror upsert, response mapping.

TWO THINGS ARE ASSERTED THAT ARE NOT ABOUT CARDHOLDERS
------------------------------------------------------
**The decrypted secret is what reaches the connector.** `_connector` calls
`decrypt_secret(row.tenant_id, row.secret_enc)`, and every one of these routes
goes through it. That call site has been wrong before — it was left passing one
argument to a two-argument function after the per-tenant key change, which no test
noticed because no test reached a decrypt. This one does, and asserts the
plaintext arrives rather than merely that nothing raised.

**Another tenant's instance is refused before the connector is built.** Not just
"the response is 404": the fake records every construction, and the count must
still be zero. A 404 returned after a request has already gone out to somebody
else's controller is not a refusal.
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
CREDENTIAL = ["access.read", "access.credential"]
SECRET = "controller-password-1"


class FakeConnector:
    """Records what the service asked the controller to do, and answers in DDS shape."""

    def __init__(self, log: list, secret: str | None) -> None:
        self.log = log
        self.secret = secret
        self.closed = False

    async def create_entity(self, collection, body):
        self.log.append(("create", collection, body))
        return {"UID": "DDS-1", **body}

    async def update_entity(self, collection, uid, body):
        self.log.append(("update", collection, uid, body))
        return {"UID": uid, "FirstName": "Asha", "LastName": "Rao", **body}

    async def delete_entity(self, collection, uid):
        self.log.append(("delete", collection, uid))

    async def patch_entity_set(self, entity_set, uid, body):
        self.log.append(("patch_set", entity_set, uid, body))
        return {"UID": uid, **body}

    async def aclose(self):
        self.closed = True


@pytest.fixture
def controller(monkeypatch):
    """Replaces the real connector. Returns the call log and the secrets seen."""
    log: list = []
    secrets: list = []

    def _fake(row, secret=None):
        secrets.append(secret)
        return FakeConnector(log, secret)

    monkeypatch.setattr("app.access.writethrough.get_connector", _fake)
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


# ── the two assertions that are not about cardholders ────────────────────────

async def test_the_connector_is_given_the_decrypted_secret(app, session, controller):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
            json={"first_name": "Asha", "last_name": "Rao"},
        )
    assert r.status_code == 201, r.text
    assert controller["secrets"] == [SECRET], controller["secrets"]


async def test_another_tenant_never_reaches_the_controller(app, session, controller):
    """The refusal has to happen before a request goes out to somebody else's box."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT_B, permissions=CREDENTIAL),
            json={"first_name": "Mallory"},
        )
    assert r.status_code == 404, r.text
    assert controller["log"] == []
    assert controller["secrets"] == []


# ── cardholders ──────────────────────────────────────────────────────────────

async def test_creating_a_cardholder_writes_through_and_maps_back(app, session, controller):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
            json={"first_name": "Asha", "last_name": "Rao", "email": "asha@example.com"},
        )
    assert r.status_code == 201, r.text
    action, collection, body = controller["log"][0]
    assert (action, collection) == ("create", "cardholders")
    # snake_case in, DDS PascalCase out.
    assert body["FirstName"] == "Asha" and body["LastName"] == "Rao"
    assert body["Email"] == "asha@example.com"
    # and DDS PascalCase back to snake_case for the caller.
    got = r.json()
    assert got["cardholder_id"] == "DDS-1"
    assert got["name"] == "Asha Rao"
    assert got["status"] == "active"


async def test_a_cardholder_with_no_name_is_refused_before_the_controller(
    app, session, controller
):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
            json={"email": "nobody@example.com"},
        )
    assert r.status_code == 422, r.text
    assert controller["log"] == []


@pytest.mark.parametrize(
    "action,dds_status,expected",
    [("suspend", "Invalidated", "suspended"), ("reinstate", "Validated", "active")],
)
async def test_suspend_and_reinstate_set_the_dds_status(
    app, session, controller, action, dds_status, expected
):
    """The whole of revoking someone's access is this one field."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders/CH-9/{action}",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
        )
    assert r.status_code == 200, r.text
    verb, collection, uid, body = controller["log"][0]
    assert (verb, collection, uid) == ("update", "cardholders", "CH-9")
    assert body == {"Status": dds_status}
    assert r.json()["status"] == expected


async def test_deleting_a_cardholder_writes_through(app, session, controller):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.delete(
            f"{PREFIX}/access/instances/{iid}/cardholders/CH-9",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
        )
    assert r.status_code == 204, r.text
    assert ("delete", "cardholders", "CH-9") in controller["log"]


async def test_an_empty_patch_is_refused_before_the_controller(app, session, controller):
    """A PATCH with nothing in it would otherwise be a write to the controller
    that changes nothing and still counts as a credential change."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.patch(
            f"{PREFIX}/access/instances/{iid}/cardholders/CH-9",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
            json={},
        )
    assert r.status_code == 422, r.text
    assert controller["log"] == []


# ── cards ────────────────────────────────────────────────────────────────────

async def test_attaching_and_detaching_a_card_patches_the_card_not_the_holder(
    app, session, controller
):
    """DDS models the link on the CARD. Attaching writes CardholderUID onto the
    card; detaching writes null to the same field. Getting this backwards would
    look like it worked and leave the credential live."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        attached = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders/CH-9/cards",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
            json={"card_id": "CARD-3"},
        )
        detached = await c.delete(
            f"{PREFIX}/access/instances/{iid}/cardholders/CH-9/cards/CARD-3",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
        )
    assert attached.status_code == 200, attached.text
    assert detached.status_code == 200, detached.text
    patches = [e for e in controller["log"] if e[0] == "patch_set"]
    assert patches[0] == ("patch_set", "API_Cards", "CARD-3", {"CardholderUID": "CH-9"})
    assert patches[1] == ("patch_set", "API_Cards", "CARD-3", {"CardholderUID": None})


async def test_a_controller_failure_is_not_an_internal_error(app, session, controller,
                                                             monkeypatch):
    """The controller refusing is an UPSTREAM condition. It must not surface as a
    500, and it must not surface as success."""
    from app.connectors.dds import DDSHTTPError

    iid = await _instance(session, TENANT_A)

    class Refusing(FakeConnector):
        async def create_entity(self, collection, body):
            raise DDSHTTPError(409, "cardholder already exists")

    monkeypatch.setattr(
        "app.access.writethrough.get_connector",
        lambda row, secret=None: Refusing(controller["log"], secret),
    )
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT_A, permissions=CREDENTIAL),
            json={"first_name": "Asha", "last_name": "Rao"},
        )
    assert r.status_code != 500, r.text
    assert 400 <= r.status_code < 600, r.text


async def test_credential_rights_are_required(app, session, controller):
    """access.manage configures the system; it does not issue credentials."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT_A, permissions=["access.read", "access.manage"]),
            json={"first_name": "Asha", "last_name": "Rao"},
        )
    assert r.status_code == 403, r.text
    assert controller["log"] == []
