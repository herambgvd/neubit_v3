"""A site / floor / zone id must be one core could have minted.

These three fields name rows in `neubit_control`, and access cannot check that
they EXIST — the platform bans cross-service reads, and that ban is not being
lifted for this. What it can check is SHAPE, and it was not: the fields were
`str(max_length=36)`, so "banana", a half-pasted uuid, or a building's name typed
into an id box were all accepted, stored, filtered on, published on
`tenant.<id>.access.*`, and mirrored by reporting into `access_events.site_id`.

A wrong-but-well-formed id is a different problem and stays out of reach. A
malformed one is in reach and is now refused at the edge.

The filter matters as much as the write. `GET /doors?site_id=banana` used to
return `[]`, which reads as "there are no doors on that site" — a wrong answer
dressed as a valid one. It is a 422 now.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.access.models import Instance

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
MANAGE = ["access.read", "access.manage"]
READ = ["access.read"]

BAD = ["banana", "12345", "not-a-uuid", "0f8fad5b-d9cb-469f-a165", "../../etc/passwd"]


async def _instance(session) -> str:
    row = Instance(
        tenant_id=TENANT, brand="dds", name=f"ctrl-{uuid.uuid4().hex[:8]}",
        base_url="https://controller.example", auth_type="basic", username="svc",
        verify_tls=True, is_active=True, status="unknown",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return str(row.id)


@pytest.mark.parametrize("bad", BAD)
async def test_an_instance_cannot_be_created_with_a_malformed_site_id(app, bad):
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={
                "name": "ctrl", "base_url": "https://controller.example",
                "brand": "dds", "auth_type": "basic", "username": "svc",
                "site_id": bad,
            },
        )
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("field", ["site_id", "floor_id", "zone_id"])
async def test_a_door_cannot_be_created_with_a_malformed_building_id(app, session, field):
    iid = await _instance(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/doors",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"instance_id": iid, "name": "Front", field: "banana"},
        )
    assert r.status_code == 422, r.text
    assert field in r.text


@pytest.mark.parametrize("field", ["site_id", "floor_id", "zone_id"])
async def test_a_door_cannot_be_patched_into_a_malformed_building_id(app, session, field):
    iid = await _instance(session)
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/doors",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"instance_id": iid, "name": "Front"},
        )
        assert made.status_code == 201, made.text
        did = made.json()["id"]
        r = await c.patch(
            f"{PREFIX}/access/doors/{did}",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={field: "banana"},
        )
    assert r.status_code == 422, r.text


async def test_a_well_formed_id_is_accepted_and_canonicalised(app, session):
    """Braces and upper case are how a uuid arrives from a Windows tool. Same id,
    so it must land as the same string or the doors filter stops matching it."""
    iid = await _instance(session)
    site = uuid.uuid4()
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/doors",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"instance_id": iid, "name": "Front", "site_id": "{%s}" % str(site).upper()},
        )
        assert made.status_code == 201, made.text
        assert made.json()["site_id"] == str(site)

        found = await c.get(
            f"{PREFIX}/access/doors?site_id={site}",
            headers=auth(tenant_id=TENANT, permissions=READ),
        )
    assert found.status_code == 200, found.text
    assert [d["name"] for d in found.json()["items"]] == ["Front"]


async def test_an_empty_site_id_still_means_unplaced(app, session):
    """"" is what an empty form field sends. It is absence, not a malformed id."""
    iid = await _instance(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/doors",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"instance_id": iid, "name": "Front", "site_id": ""},
        )
    assert r.status_code == 201, r.text
    assert r.json()["site_id"] is None


@pytest.mark.parametrize("bad", BAD)
async def test_filtering_doors_by_a_malformed_site_id_is_refused(app, session, bad):
    """Not an empty list. An empty list is an answer, and it would be a wrong one."""
    await _instance(session)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/doors?site_id={bad}",
            headers=auth(tenant_id=TENANT, permissions=READ),
        )
    assert r.status_code == 422, r.text


async def test_filtering_by_a_well_formed_but_unknown_site_is_still_empty(app, session):
    """The shape check is not an existence check and must not be read as one."""
    await _instance(session)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/doors?site_id={uuid.uuid4()}",
            headers=auth(tenant_id=TENANT, permissions=READ),
        )
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []
