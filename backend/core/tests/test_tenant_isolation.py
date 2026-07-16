"""Phase 4 — cross-tenant isolation matrix.

Proves the scope.py enforcement is airtight on the user surface (the most
leak-prone one, per the isolation audit): a tenant-A admin can never LIST or
FETCH another tenant's users (``scoped()`` on the list, ``assert_owned()`` on the
by-id fetch → 404, not 403, so existence can't be probed), while a super-admin
bypasses and sees everyone.

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
    """The ⌘K global search must not leak another tenant's users (regression for the
    one cross-tenant leak the Phase-4 audit found in search/router.py)."""
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
    """A tenant-admin passing another tenant's id is IGNORED — the new user lands
    in the admin's own tenant (never cross-tenant provisioning)."""
    from sqlalchemy import select

    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/auth/users",
            headers=_auth(world["a_admin"]),
            json={
                "email": "planted@x.io",
                "password": "Passw0rd!",
                "role_id": str(world["role"].id),
                "tenant_id": str(world["tb"].id),  # attempt to plant into tenant B
            },
        )
    assert r.status_code == 201, r.text
    created = (await db.execute(select(User).where(User.email == "planted@x.io"))).scalar_one()
    assert created.tenant_id == world["ta"].id  # forced into A, not B
