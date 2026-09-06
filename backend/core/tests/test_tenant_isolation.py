"""Phase 4 — cross-tenant isolation matrix, on the user surface.

A tenant-A admin can never list or fetch another tenant's users: ``scoped()`` on
the list, ``assert_owned()`` on the by-id fetch, and 404 rather than 403 so an id
cannot be probed. A super-admin sees everyone.

Runs the full base app against in-memory SQLite with get_db overridden — no
Docker/Postgres — the same harness as test_security_endpoints.py.
"""

from __future__ import annotations

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


async def _tenant(db, name: str, slug: str) -> Tenant:
    t = Tenant(name=name, slug=slug, status="active", features={}, limits={})
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


async def _user(db, email: str, role, tenant_id, *, superadmin: bool = False) -> User:
    u = User(
        email=email,
        full_name=email.split("@")[0],
        role_id=role.id,
        password_hash=hash_password("Passw0rd!"),
        is_active=True,
        tenant_id=tenant_id,
        is_superadmin=superadmin,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    await db.refresh(u, attribute_names=["role"])
    return u


@pytest_asyncio.fixture
async def world(db):
    """Two tenants (A, B) + an admin each, a plain B user, and a super-admin."""
    role = await make_role(db, "TAdmin", ["user.read", "user.manage"])
    ta = await _tenant(db, "Tenant A", "tenant-a")
    tb = await _tenant(db, "Tenant B", "tenant-b")
    return {
        "role": role,
        "ta": ta,
        "tb": tb,
        "a_admin": await _user(db, "a-admin@x.io", role, ta.id),
        "b_admin": await _user(db, "b-admin@x.io", role, tb.id),
        "b_user": await _user(db, "b-user@x.io", role, tb.id),
        "sa": await _user(db, "sa@x.io", role, None, superadmin=True),
        # tenant_id NULL and is_superadmin False — what create_user mints when a
        # super-admin POSTs /auth/users with no tenant_id, and the shape hand-rolled
        # user filters fall through.
        "rootless": await _user(db, "rootless@x.io", role, None),
    }


async def test_list_users_is_tenant_scoped(app, world):
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/auth/users", headers=_auth(world["a_admin"]))
    assert r.status_code == 200
    emails = {u["email"] for u in r.json()["items"]}
    assert "a-admin@x.io" in emails
    # Tenant B's users must NOT appear in tenant A's list.
    assert "b-admin@x.io" not in emails
    assert "b-user@x.io" not in emails


async def test_get_cross_tenant_user_is_404(app, world):
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/auth/users/{world['b_user'].id}", headers=_auth(world["a_admin"]))
    # NOT 403 — a tenant-admin must not be able to tell a foreign id even exists.
    assert r.status_code == 404


async def test_superadmin_sees_every_tenant(app, world):
    async with _client(app) as c:
        one = await c.get(f"{PREFIX}/auth/users/{world['b_user'].id}", headers=_auth(world["sa"]))
        listing = await c.get(f"{PREFIX}/auth/users", headers=_auth(world["sa"]))
    assert one.status_code == 200
    emails = {u["email"] for u in listing.json()["items"]}
    assert {"a-admin@x.io", "b-admin@x.io", "b-user@x.io"} <= emails


async def test_global_search_is_tenant_scoped(app, world):
    """The ⌘K global search must not leak another tenant's users."""
    async with _client(app) as c:
        # A-admin searching for tenant-B's user gets nothing.
        r = await c.get(f"{PREFIX}/search?q=b-user", headers=_auth(world["a_admin"]))
        assert r.status_code == 200
        leaked = {x["sublabel"] for x in r.json()["results"] if x["type"] == "user"}
        assert "b-user@x.io" not in leaked
        # Own-tenant search still returns own users.
        r2 = await c.get(f"{PREFIX}/search?q=a-admin", headers=_auth(world["a_admin"]))
        own = {x["sublabel"] for x in r2.json()["results"] if x["type"] == "user"}
        assert "a-admin@x.io" in own
        # Super-admin search sees every tenant.
        r3 = await c.get(f"{PREFIX}/search?q=b-user", headers=_auth(world["sa"]))
        seen = {x["sublabel"] for x in r3.json()["results"] if x["type"] == "user"}
        assert "b-user@x.io" in seen


async def test_admin_api_requires_admin_realm(app, world):
    """The /admin API demands the admin audience — a tenant-realm token is rejected
    even for a genuine super-admin (Phase 8 realm isolation)."""
    import datetime as dt

    import jwt as _jwt

    from app.core.config import get_settings

    sa = world["sa"]
    async with _client(app) as c:
        # Correct realm (create_access_token stamps aud=neubit-admin for a super-admin).
        ok = await c.get(f"{PREFIX}/admin/tenants", headers=_auth(sa))
        assert ok.status_code == 200
        # Same super-admin id, but a tenant-realm token → 403.
        now = dt.datetime.now(dt.timezone.utc)
        wrong = _jwt.encode(
            {
                "sub": str(sa.id),
                "type": "access",
                "aud": "neubit-tenant",
                "iat": now,
                "exp": now + dt.timedelta(hours=1),
            },
            get_settings().jwt_secret,
            algorithm="HS256",
        )
        bad = await c.get(
            f"{PREFIX}/admin/tenants", headers={"Authorization": f"Bearer {wrong}"}
        )
        assert bad.status_code == 403


async def test_user_create_is_forced_into_actor_tenant(app, world, db):
    """A tenant-admin passing another tenant's id is ignored — the new user lands in
    the admin's own tenant.

    ``full_name`` is mandatory on create_user; leave it out and the POST is a 422 at
    the router's guard, so the assertion below never runs and the test goes red for
    a reason that has nothing to do with tenant isolation.
    """
    from sqlalchemy import select

    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/auth/users",
            headers=_auth(world["a_admin"]),
            json={
                "email": "planted@x.io",
                "full_name": "Planted User",
                "password": "Passw0rd!",
                "role_id": str(world["role"].id),
                "tenant_id": str(world["tb"].id),  # attempt to plant into tenant B
            },
        )
    assert r.status_code == 201, r.text
    created = (await db.execute(select(User).where(User.email == "planted@x.io"))).scalar_one()
    assert created.tenant_id == world["ta"].id  # forced into A, not B


# ---------------------------------------------------------------------------
# A NULL tenant_id is a tenancy, not a wildcard.
#
# Reading NULL as "shared platform default" in scope.owns() is wrong on the users
# table, where NULL means the platform super-admin: it lets any tenant-admin with
# user.read fetch that row and, with user.manage, reset its password and revoke its
# sessions.
# ---------------------------------------------------------------------------


async def test_tenant_admin_cannot_fetch_the_platform_superadmin(app, world):
    """404, and for the same reason a foreign tenant's user is 404: a tenant-admin
    must not learn the super-admin's id exists, let alone read its row."""
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/auth/users/{world['sa'].id}", headers=_auth(world["a_admin"]))
    assert r.status_code == 404, r.text


async def test_tenant_admin_cannot_reset_the_platform_superadmin_password(app, world, db):
    """The escalation this buys: PATCH with a password goes through the same
    ownership gate as the read, then revokes the victim's sessions.

    The hash is re-read because a 404 alone would not prove the write did not land
    before the guard.
    """
    from sqlalchemy import select

    sa_id = world["sa"].id  # read before expire_all: a lazy re-load inside an async
    # session raises rather than blocking, which would look like a bug in the code
    # under test.
    original_hash = (
        await db.execute(select(User).where(User.id == sa_id))
    ).scalar_one().password_hash
    async with _client(app) as c:
        r = await c.patch(
            f"{PREFIX}/auth/users/{sa_id}",
            headers=_auth(world["a_admin"]),
            json={"password": "Attacker1!"},
        )
    assert r.status_code == 404, r.text
    db.expire_all()
    after = (await db.execute(select(User).where(User.id == sa_id))).scalar_one()
    assert after.password_hash == original_hash


async def test_tenant_admin_cannot_delete_or_lock_the_platform_superadmin(app, world):
    """The other admin actions share _admin_target, so they share the guard.

    A misspelt path also answers 404, so the positive control runs the same urls as
    a super-admin first — if those are not 200, the urls are wrong.
    """
    sa_id = world["sa"].id
    async with _client(app) as c:
        # Positive control: same url template, a target the super-admin may act on.
        # Not the super-admin itself — lock_user 422s on the caller's own account,
        # which would fail this control for an unrelated reason.
        for tmpl in ("lock", "reset-mfa"):
            ok = await c.post(
                f"{PREFIX}/auth/users/{world['b_user'].id}/{tmpl}", headers=_auth(world["sa"])
            )
            assert ok.status_code == 200, f"{tmpl} url is wrong: {ok.status_code} {ok.text}"
        lock = await c.post(f"{PREFIX}/auth/users/{sa_id}/lock", headers=_auth(world["a_admin"]))
        mfa = await c.post(
            f"{PREFIX}/auth/users/{sa_id}/reset-mfa", headers=_auth(world["a_admin"])
        )
    assert lock.status_code == 404, lock.text
    assert mfa.status_code == 404, mfa.text


async def test_superadmin_still_reaches_platform_rows(app, world):
    """The guard must not be a blanket ban on NULL rows: a super-admin still owns
    them, and tightening owns() to `== scope.tenant_id` would lock everyone out
    while passing every test above."""
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/auth/users/{world['sa'].id}", headers=_auth(world["sa"]))
    assert r.status_code == 200
    assert r.json()["email"] == "sa@x.io"


async def test_a_tenantless_non_superadmin_is_not_a_super_admin(app, world):
    """tenant_id NULL with is_superadmin False falls through hand-rolled filters of
    the form `if tenant_id is not None`, showing this principal the whole platform
    directory on nothing but user.read."""
    async with _client(app) as c:
        listing = await c.get(f"{PREFIX}/auth/users", headers=_auth(world["rootless"]))
        export = await c.get(f"{PREFIX}/auth/users/export", headers=_auth(world["rootless"]))
    assert listing.status_code == 200
    emails = {u["email"] for u in listing.json()["items"]}
    assert "a-admin@x.io" not in emails
    assert "b-user@x.io" not in emails
    # It is a tenancy, so it sees its own: itself and the super-admin share NULL.
    assert "rootless@x.io" in emails
    assert export.status_code == 200
    assert "a-admin@x.io" not in export.text
    assert "b-user@x.io" not in export.text


async def test_export_is_tenant_scoped(app, world):
    """The export must match the list it claims to mirror; both go through scoped()."""
    async with _client(app) as c:
        mine = await c.get(f"{PREFIX}/auth/users/export", headers=_auth(world["a_admin"]))
        every = await c.get(f"{PREFIX}/auth/users/export", headers=_auth(world["sa"]))
    assert mine.status_code == 200
    assert "a-admin@x.io" in mine.text
    assert "b-admin@x.io" not in mine.text
    assert "sa@x.io" not in mine.text
    # Super-admin exports the platform, which is what the endpoint is for.
    assert "b-admin@x.io" in every.text
