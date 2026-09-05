"""Tenant administration — the fifteen routes that create, licence and erase a customer.

This is the most privileged surface core serves and the one where a mistake is
hardest to see: every call here is made by someone who is allowed to do anything,
so nothing in the response distinguishes "did what I meant" from "did it to the
wrong tenant". The refusals are therefore the interesting part, and each one below
is a specific way an operator's slip becomes a customer's incident.

Note what is NOT asserted here: that a tenant cannot reach these routes. That
property belongs to the whole /admin table, not to this module, and is stated once
in ``test_admin_realm_boundary.py``.

Two of these routes carry a tenant check even though the caller is a super-admin —
``/tenants/{tenant_id}/admins/{user_id}`` and its DELETE. They exist because the
url names a tenant, and a url that names a tenant and then ignores it is how a
console with the wrong customer selected deletes the right-looking user out of the
wrong company.
"""

from __future__ import annotations

import datetime as dt
import uuid

import httpx
import pytest
import pytest_asyncio

from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.db.base import get_db
from app.tenancy.models import Tenant
from conftest import make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
ADMIN = f"{PREFIX}/admin"
PASSWORD = "Passw0rd!"


@pytest.fixture
def app(sessionmaker_):
    application = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    application.dependency_overrides[get_db] = _override_db
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def _auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user, sid='test')}"}


@pytest_asyncio.fixture
async def sa(db) -> User:
    role = await make_role(db, "Platform", ["*"])
    u = User(
        email="tenant-ops@x.io", full_name="Ops", role_id=role.id,
        password_hash=hash_password(PASSWORD), is_active=True,
        tenant_id=None, is_superadmin=True,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    await db.refresh(u, attribute_names=["role"])
    return u


async def _create_tenant(c, sa, name, email) -> dict:
    r = await c.post(
        f"{ADMIN}/tenants", headers=_auth(sa),
        json={"name": name, "admin_email": email, "admin_password": PASSWORD},
    )
    assert r.status_code == 201, r.text
    return r.json()


# --- provisioning ------------------------------------------------------------
async def test_creating_a_tenant_provisions_it_with_exactly_one_administrator(app, sa):
    """A tenant with no way in is an outage the operator only discovers when the
    customer calls. Creation is one call for that reason: the tenant and its first
    administrator either both exist or neither does."""
    async with _client(app) as c:
        created = await _create_tenant(c, sa, "Acme Corp", "acme-admin@x.io")
        admins = await c.get(f"{ADMIN}/tenants/{created['id']}/admins", headers=_auth(sa))
        detail = await c.get(f"{ADMIN}/tenants/{created['id']}", headers=_auth(sa))

    assert created["slug"] == "acme-corp"
    assert created["status"] == "active"
    assert created["license_state"] == "active"
    assert [a["email"] for a in admins.json()] == ["acme-admin@x.io"]
    assert detail.json()["users"] == 1


async def test_two_tenants_with_the_same_name_get_different_slugs(app, sa):
    """The slug is unique in the schema and appears in links. A collision would
    make the second creation a 500 on a perfectly reasonable customer name."""
    async with _client(app) as c:
        first = await _create_tenant(c, sa, "Acme", "a1@x.io")
        second = await _create_tenant(c, sa, "Acme", "a2@x.io")
    assert first["slug"] == "acme"
    assert second["slug"] == "acme-2"


async def test_an_email_already_in_use_cannot_seed_a_second_tenant(app, sa):
    """Email is the login identity and is unique platform-wide. Allowing a reuse
    would leave one password opening two customers, or a 500 at the insert."""
    async with _client(app) as c:
        await _create_tenant(c, sa, "Acme", "shared@x.io")
        again = await c.post(
            f"{ADMIN}/tenants", headers=_auth(sa),
            json={"name": "Globex", "admin_email": "shared@x.io", "admin_password": PASSWORD},
        )
        listed = await c.get(f"{ADMIN}/tenants", headers=_auth(sa))
    assert again.status_code == 409, again.text
    # And the refused call left nothing behind.
    assert listed.json()["total"] == 1


async def test_a_provisioning_password_must_survive_the_password_policy(app, sa):
    """The first administrator's password is set by an operator, not by the person
    who will use it, so it is the one credential nobody chooses for themselves. It
    goes through the same policy as every other."""
    async with _client(app) as c:
        r = await c.post(
            f"{ADMIN}/tenants", headers=_auth(sa),
            json={"name": "Weak", "admin_email": "weak@x.io", "admin_password": "abc"},
        )
    assert r.status_code == 422, r.text


# --- the directory -----------------------------------------------------------
async def test_the_tenant_list_can_be_searched_and_filtered_by_status(app, sa):
    async with _client(app) as c:
        acme = await _create_tenant(c, sa, "Acme", "a@x.io")
        await _create_tenant(c, sa, "Globex", "g@x.io")
        await c.post(f"{ADMIN}/tenants/{acme['id']}/suspend", headers=_auth(sa))

        searched = await c.get(f"{ADMIN}/tenants", headers=_auth(sa), params={"q": "glob"})
        suspended = await c.get(
            f"{ADMIN}/tenants", headers=_auth(sa), params={"status": "suspended"}
        )
    assert searched.json()["total"] == 1
    assert [t["name"] for t in searched.json()["items"]] == ["Globex"]
    assert [t["name"] for t in suspended.json()["items"]] == ["Acme"]


async def test_the_user_directory_can_be_narrowed_to_one_tenant(app, sa):
    """The cross-tenant directory is the operator's only view of who exists. Its
    filters are how a support call about one customer stays about that customer."""
    async with _client(app) as c:
        acme = await _create_tenant(c, sa, "Acme", "acme@x.io")
        await _create_tenant(c, sa, "Globex", "globex@x.io")

        everyone = await c.get(f"{ADMIN}/users", headers=_auth(sa))
        just_acme = await c.get(
            f"{ADMIN}/users", headers=_auth(sa), params={"tenant_id": acme["id"]}
        )
        no_platform = await c.get(
            f"{ADMIN}/users", headers=_auth(sa), params={"include_platform": "false"}
        )

    # the two tenant admins plus the super-admin running this test
    assert everyone.json()["total"] == 3
    assert [u["email"] for u in just_acme.json()["items"]] == ["acme@x.io"]
    assert just_acme.json()["items"][0]["tenant_name"] == "Acme"
    assert just_acme.json()["items"][0]["role_name"] == "Administrator"
    assert {u["email"] for u in no_platform.json()["items"]} == {"acme@x.io", "globex@x.io"}


async def test_usage_reports_the_seats_used_against_the_licensed_cap(app, sa):
    """This is what the operator reads before selling more seats, and what the
    quota alert is derived from."""
    async with _client(app) as c:
        acme = await _create_tenant(c, sa, "Acme", "acme@x.io")
        await c.put(
            f"{ADMIN}/tenants/{acme['id']}/license", headers=_auth(sa),
            json={"limits": {"max_users": 2}},
        )
        usage = await c.get(f"{ADMIN}/tenants/{acme['id']}/usage", headers=_auth(sa))
    assert usage.json() == {"users": 1, "limits": {"max_users": 2}}


# --- licence -----------------------------------------------------------------
async def test_the_licence_state_is_derived_from_the_expiry_and_the_grace_window(app, sa):
    """`license_state` is not stored — it is computed from expiry + grace on every
    read, and it is what the console and the request-path guard both act on. A
    tenant one day past expiry with a week of grace is still working, and a tenant
    past both is not; getting that backwards either locks out a paying customer or
    keeps serving one who has stopped paying."""
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "a@x.io")
        yesterday = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat()

        in_grace = await c.put(
            f"{ADMIN}/tenants/{t['id']}/license", headers=_auth(sa),
            json={"license_expires_at": yesterday, "grace_days": 7},
        )
        past_grace = await c.put(
            f"{ADMIN}/tenants/{t['id']}/license", headers=_auth(sa),
            json={"license_expires_at": yesterday, "grace_days": 0},
        )
        perpetual = await c.put(
            f"{ADMIN}/tenants/{t['id']}/license", headers=_auth(sa),
            json={"license_expires_at": None},
        )

    assert in_grace.json()["license_state"] == "grace"
    assert past_grace.json()["license_state"] == "expired"
    assert perpetual.json()["license_state"] == "active"
    assert perpetual.json()["license_expires_at"] is None


async def test_suspending_and_reactivating_moves_the_tenant_between_states(app, sa):
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "a@x.io")
        suspended = await c.post(f"{ADMIN}/tenants/{t['id']}/suspend", headers=_auth(sa))
        back = await c.post(f"{ADMIN}/tenants/{t['id']}/reactivate", headers=_auth(sa))
    assert suspended.json()["status"] == "suspended"
    assert back.json()["status"] == "active"


async def test_a_status_outside_the_vocabulary_is_refused(app, sa):
    """`status` gates login and the whole request path. A free-text value would be
    neither active nor suspended, and the guard reads it as "not suspended" — a
    typo would quietly un-suspend a tenant."""
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "a@x.io")
        r = await c.patch(
            f"{ADMIN}/tenants/{t['id']}", headers=_auth(sa), json={"status": "paused"}
        )
    assert r.status_code == 422, r.text


# --- per-tenant users --------------------------------------------------------
async def test_a_user_cannot_be_deleted_through_another_tenants_url(app, sa):
    """The isolation guard inside a surface that has no isolation. The caller is
    allowed to delete either user; what they are not allowed to do is delete
    Globex's user by asking for it under Acme's tenant id — which is exactly what
    a console with a stale tenant selected sends. 404, not 403, keeps the two
    indistinguishable from outside."""
    async with _client(app) as c:
        acme = await _create_tenant(c, sa, "Acme", "acme@x.io")
        globex = await _create_tenant(c, sa, "Globex", "globex@x.io")
        extra = await c.post(
            f"{ADMIN}/tenants/{globex['id']}/admins", headers=_auth(sa),
            json={"email": "globex2@x.io", "password": PASSWORD},
        )
        assert extra.status_code == 201, extra.text

        wrong_url = await c.delete(
            f"{ADMIN}/tenants/{acme['id']}/admins/{extra.json()['id']}", headers=_auth(sa)
        )
        right_url = await c.delete(
            f"{ADMIN}/tenants/{globex['id']}/admins/{extra.json()['id']}", headers=_auth(sa)
        )
    assert wrong_url.status_code == 404, wrong_url.text
    assert right_url.status_code == 204, right_url.text


async def test_a_tenants_last_user_cannot_be_removed(app, sa):
    """Same failure as a tenant provisioned with no administrator, reached from the
    other direction: the customer is locked out of their own account and only a
    super-admin can undo it."""
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "acme@x.io")
        admins = await c.get(f"{ADMIN}/tenants/{t['id']}/admins", headers=_auth(sa))
        only = admins.json()[0]["id"]
        r = await c.delete(f"{ADMIN}/tenants/{t['id']}/admins/{only}", headers=_auth(sa))
    assert r.status_code == 409, r.text


async def test_provisioning_a_user_respects_the_tenants_seat_cap(app, sa):
    """max_users is a commercial limit. Enforcing it only in the console leaves the
    API selling seats nobody paid for."""
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "acme@x.io")
        await c.put(
            f"{ADMIN}/tenants/{t['id']}/license", headers=_auth(sa),
            json={"limits": {"max_users": 1}},
        )
        r = await c.post(
            f"{ADMIN}/tenants/{t['id']}/admins", headers=_auth(sa),
            json={"email": "second@x.io", "password": PASSWORD},
        )
    assert r.status_code == 409, r.text


async def test_admins_of_a_tenant_that_does_not_exist_is_a_404_not_an_empty_list(app, sa):
    """An empty list would read as "this customer has no users", which is a
    different and much more alarming fact than "there is no such customer"."""
    async with _client(app) as c:
        r = await c.get(f"{ADMIN}/tenants/{uuid.uuid4()}/admins", headers=_auth(sa))
    assert r.status_code == 404


# --- impersonation -----------------------------------------------------------
async def test_impersonation_hands_back_a_token_for_that_tenants_own_administrator(app, sa):
    """Support's "view as customer". The token must BE the customer — carrying
    their tenant and their entitlements — so what the operator sees is what the
    customer sees, and so every action taken with it is attributed to that
    identity rather than to the platform."""
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "acme@x.io")
        minted = await c.post(f"{ADMIN}/tenants/{t['id']}/impersonate", headers=_auth(sa))
        assert minted.status_code == 200, minted.text
        me = await c.get(
            f"{PREFIX}/auth/me",
            headers={"Authorization": f"Bearer {minted.json()['access_token']}"},
        )
    assert minted.json()["user_email"] == "acme@x.io"
    assert minted.json()["tenant_id"] == t["id"]
    assert me.status_code == 200, me.text
    assert me.json()["email"] == "acme@x.io"


# --- account state -----------------------------------------------------------
async def test_a_platform_super_admin_cannot_be_disabled_from_the_user_directory(app, sa, db):
    """The directory lists super-admins alongside everyone else, so the disable
    switch sits next to them. Disabling the last one locks every operator out of
    the platform with no route back in — there is no super-admin left to re-enable
    anybody."""
    async with _client(app) as c:
        refused = await c.post(
            f"{ADMIN}/users/{sa.id}/set-active", headers=_auth(sa), json={"is_active": False}
        )
        t = await _create_tenant(c, sa, "Acme", "acme@x.io")
        admins = await c.get(f"{ADMIN}/tenants/{t['id']}/admins", headers=_auth(sa))
        allowed = await c.post(
            f"{ADMIN}/users/{admins.json()[0]['id']}/set-active",
            headers=_auth(sa), json={"is_active": False},
        )
    assert refused.status_code == 422, refused.text
    # The same switch on a tenant user works — this is a targeted refusal, not a
    # dead route.
    assert allowed.status_code == 200 and allowed.json()["is_active"] is False


async def test_a_disabled_user_can_no_longer_sign_in(app, sa):
    """`is_active` is only worth anything if the session path reads it. Otherwise
    disabling an account is a label in the directory and the account keeps working.
    """
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "acme@x.io")
        admins = await c.get(f"{ADMIN}/tenants/{t['id']}/admins", headers=_auth(sa))
        before = await c.post(
            f"{PREFIX}/auth/login", json={"email": "acme@x.io", "password": PASSWORD}
        )
        await c.post(
            f"{ADMIN}/users/{admins.json()[0]['id']}/set-active",
            headers=_auth(sa), json={"is_active": False},
        )
        after = await c.post(
            f"{PREFIX}/auth/login", json={"email": "acme@x.io", "password": PASSWORD}
        )
    assert before.status_code == 200, before.text
    assert after.status_code in (401, 403), after.text


# --- offboarding -------------------------------------------------------------
async def test_deleting_a_tenant_removes_it_once_and_leaves_its_neighbour_alone(app, sa):
    """Offboarding is the right-to-erase path, and the property that matters about a
    destructive route is that it destroys exactly what was named.

    The tenant's own tables are covered by ``tests/test_tenant_erasure.py``, which
    checks each table's declared disposition; the cascade-backed ones cannot be
    observed through this harness (SQLite does not enforce a foreign key unless the
    connection asks it to), which is precisely why that file asserts the constraint
    exists rather than watching it fire.
    """
    async with _client(app) as c:
        t = await _create_tenant(c, sa, "Acme", "acme@x.io")
        await _create_tenant(c, sa, "Globex", "globex@x.io")

        removed = await c.delete(f"{ADMIN}/tenants/{t['id']}", headers=_auth(sa))
        gone = await c.get(f"{ADMIN}/tenants/{t['id']}", headers=_auth(sa))
        again = await c.delete(f"{ADMIN}/tenants/{t['id']}", headers=_auth(sa))
        left = await c.get(f"{ADMIN}/tenants", headers=_auth(sa))

    assert removed.status_code == 204, removed.text
    assert gone.status_code == 404
    assert again.status_code == 404
    assert [x["name"] for x in left.json()["items"]] == ["Globex"]


async def test_offboarding_scrubs_the_tenant_out_of_a_broadcasts_target_list(app, sa, db):
    """A broadcast is a platform record and survives its audience, but its
    ``target_tenant_ids`` is a JSON array — no constraint reaches inside it and no
    tenant_id sweep can see it. Left behind, the id keeps naming a customer that no
    longer exists, and a re-issued uuid would address the message to whoever
    inherits it.

    This is one of the erasures that is done in Python rather than by the database,
    which is why it is observable from the API at all.
    """
    from app.broadcasts.models import Broadcast

    async with _client(app) as c:
        doomed = await _create_tenant(c, sa, "Acme", "acme@x.io")
        staying = await _create_tenant(c, sa, "Globex", "globex@x.io")

        row = Broadcast(
            title="Scheduled downtime", body="", severity="info", target_type="tenants",
            target_tenant_ids=[doomed["id"], staying["id"]], is_active=True,
        )
        db.add(row)
        await db.commit()

        await c.delete(f"{ADMIN}/tenants/{doomed['id']}", headers=_auth(sa))
        after = await c.get(f"{PREFIX}/admin/broadcasts", headers=_auth(sa))

    (bc,) = after.json()
    assert bc["target_tenant_ids"] == [staying["id"]]
