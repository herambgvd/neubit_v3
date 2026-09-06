"""The access-group and schedule catalogs, over HTTP.

These eleven routes had never been called by a test. They are local CRUD — no
controller in the path — so there is no reason for them to have been untested
beyond nobody having written it, and a 500 in any of them would have been found
by a customer.

What is asserted, beyond "it works":

  * **the api_key never comes back.** `AccessGroupPublic` returns `has_api_key`
    instead. That is a deliberate choice in the schema and this is what keeps it
    one: a field added to the response model later cannot quietly start echoing
    a stored credential.
  * **a group belongs to an instance, not just to a tenant.** Both catalogs take
    `instance_id` as a required query parameter and every read goes through
    `_assert_instance` first, so naming another instance's id is a 404 before
    ownership of the row is even considered.
  * **the refusals are 404, not 403.** A cross-tenant id must be indistinguishable
    from an id that does not exist, or the error itself enumerates the estate.

WHICH GUARD ACTUALLY ANSWERS
-----------------------------
Measured, not assumed: `scoped()` inside `AccessGroupCatalog._get_owned` was
removed and every HTTP test here still passed. Over the wire the refusal always
comes from `_assert_instance` (the caller does not own the instance) or from the
`instance_id` filter on the row (the group is not in the instance named). That
makes `scoped()` there defence-in-depth against a row whose `tenant_id` and whose
instance's `tenant_id` disagree — a state no route can currently produce, and
therefore one no HTTP test can reach. `test_a_mis_tenanted_row_is_still_refused`
calls the catalog directly so that guard is not the only unproven line in the file.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.access.models import Instance

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()

READ = ["access.read"]
MANAGE = ["access.read", "access.manage"]


async def _instance(session, tenant_id) -> str:
    row = Instance(
        tenant_id=tenant_id, brand="dds", name=f"ctrl-{uuid.uuid4().hex[:8]}",
        base_url="https://controller.example", auth_type="basic", username="svc",
        verify_tls=True, is_active=True, status="unknown",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return str(row.id)


# ── access groups ────────────────────────────────────────────────────────────

async def test_access_group_round_trip(app, session):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        empty = await c.get(
            f"{PREFIX}/access/access-groups?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert empty.status_code == 200, empty.text
        assert empty.json()["items"] == []

        made = await c.post(
            f"{PREFIX}/access/access-groups?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "Night shift", "description": "after 22:00"},
        )
        assert made.status_code == 201, made.text
        gid = made.json()["group_id"]

        got = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert got.status_code == 200, got.text
        assert got.json()["name"] == "Night shift"

        listed = await c.get(
            f"{PREFIX}/access/access-groups?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert [g["group_id"] for g in listed.json()["items"]] == [gid]

        patched = await c.patch(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "Night shift (revised)"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["name"] == "Night shift (revised)"
        # An update naming one field leaves the others alone.
        assert patched.json()["description"] == "after 22:00"

        gone = await c.delete(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
        assert gone.status_code == 204, gone.text

        after = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert after.status_code == 404, after.text


async def test_the_api_key_is_never_returned(app, session):
    """It is a stored credential. `has_api_key` is what a caller gets."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/access-groups?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "Contractors", "api_key": "super-secret-value"},
        )
        assert made.status_code == 201, made.text
        body = made.json()
        assert body["has_api_key"] is True
        assert "api_key" not in body
        assert "super-secret-value" not in made.text

        gid = body["group_id"]
        got = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert "super-secret-value" not in got.text


async def test_another_tenant_cannot_reach_the_group(app, session):
    """Two tenants, one group. B is told it does not exist — the same answer an
    invented id gets, so the refusal enumerates nothing."""
    iid_a = await _instance(session, TENANT_A)
    iid_b = await _instance(session, TENANT_B)
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/access-groups?instance_id={iid_a}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "A's group"},
        )
        gid = made.json()["group_id"]

        # B naming A's instance: refused at the instance, before the row.
        via_a = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid_a}",
            headers=auth(tenant_id=TENANT_B, permissions=READ),
        )
        assert via_a.status_code == 404, via_a.text

        # B naming its OWN instance and A's group id: the instance check passes
        # this time, and the `instance_id` filter on the row is what refuses it.
        via_b = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid_b}",
            headers=auth(tenant_id=TENANT_B, permissions=READ),
        )
        assert via_b.status_code == 404, via_b.text

        # And it is still there for A.
        still = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid_a}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert still.status_code == 200, still.text


async def test_a_group_cannot_be_deleted_through_another_instance(app, session):
    iid_a = await _instance(session, TENANT_A)
    iid_b = await _instance(session, TENANT_B)
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/access-groups?instance_id={iid_a}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "A's group"},
        )
        gid = made.json()["group_id"]
        refused = await c.delete(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid_b}",
            headers=auth(tenant_id=TENANT_B, permissions=MANAGE),
        )
        assert refused.status_code == 404, refused.text
        still = await c.get(
            f"{PREFIX}/access/access-groups/{gid}?instance_id={iid_a}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert still.status_code == 200, still.text


# ── schedules ────────────────────────────────────────────────────────────────

async def test_schedule_round_trip(app, session):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/schedules?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "Weekdays", "timezone": "Asia/Kolkata"},
        )
        assert made.status_code == 201, made.text
        sid = made.json()["schedule_id"]

        listed = await c.get(
            f"{PREFIX}/access/schedules?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert [s["schedule_id"] for s in listed.json()["items"]] == [sid]

        patched = await c.patch(
            f"{PREFIX}/access/schedules/{sid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "Weekdays only"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["name"] == "Weekdays only"
        assert patched.json()["timezone"] == "Asia/Kolkata"

        gone = await c.delete(
            f"{PREFIX}/access/schedules/{sid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
        )
        assert gone.status_code == 204, gone.text

        after = await c.get(
            f"{PREFIX}/access/schedules/{sid}?instance_id={iid}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert after.status_code == 404, after.text


async def test_another_tenant_cannot_reach_the_schedule(app, session):
    iid_a = await _instance(session, TENANT_A)
    iid_b = await _instance(session, TENANT_B)
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/schedules?instance_id={iid_a}",
            headers=auth(tenant_id=TENANT_A, permissions=MANAGE),
            json={"name": "A's schedule"},
        )
        sid = made.json()["schedule_id"]
        for iid in (iid_a, iid_b):
            r = await c.get(
                f"{PREFIX}/access/schedules/{sid}?instance_id={iid}",
                headers=auth(tenant_id=TENANT_B, permissions=READ),
            )
            assert r.status_code == 404, r.text


async def test_instance_id_is_required(app, session):
    """It is the scope. A catalog call without one is a request for every
    instance's groups, and must not be answered as one."""
    await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/access-groups",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert r.status_code == 422, r.text


# ── the guard the HTTP paths cannot reach ────────────────────────────────────

async def test_a_mis_tenanted_row_is_still_refused(app, session):
    """A group row whose tenant disagrees with its instance's tenant.

    No route produces this — `create` copies the tenant off the instance — so it
    is either corruption or a future bug. `scoped()` in `_get_owned` is the line
    that catches it, and removing that line breaks this test and nothing else.
    """
    from kernel.auth import Scope

    from app.access.catalog import AccessGroupCatalog
    from app.access.models import AccessGroup

    iid_a = await _instance(session, TENANT_A)
    stray = AccessGroup(
        tenant_id=TENANT_B,          # the disagreement
        instance_id=iid_a,
        name="stray",
        access_group_type="Door",
    )
    session.add(stray)
    await session.commit()
    await session.refresh(stray)

    svc = AccessGroupCatalog(session, Scope(tenant_id=TENANT_A, is_superadmin=False))
    assert await svc.get(iid_a, str(stray.id)) is None
