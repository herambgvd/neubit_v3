"""A suspended tenant's token must stop working, not keep working until it expires.

`require_tenant_active` existed, its docstring described exactly this window, and it
was applied to ONE router (dashforge). Core refuses a suspended tenant at LOGIN and
then nothing on the request path looks again — so a token minted a minute before the
suspension kept working across users, sites, settings, messaging and reports for the
rest of its TTL. Where suspension is a commercial control, that window is the
control.

Two things make the fix hold rather than being one more router someone remembers:

  * the default is inverted in `app/app.py` — every base router is guarded unless it
    is named in `_tenant_active_exempt()`, with the reason;
  * the dependency resolves a PERSON OR A SERVICE KEY. It used to go through
    `get_scope` → `get_current_user`, which refuses api-key tokens by design, so
    attaching it to any router a key needs 401ed that key. That is why it could only
    ever live on one router, and suspension applies to a tenant's machine
    credentials at least as much as to its people.
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


@pytest_asyncio.fixture
async def world(db):
    role = await make_role(
        db, "TenantOps", ["sites.read", "settings.manage", "user.read", "audit.read"]
    )
    tenant = Tenant(name="Acme", slug="acme-susp", status="active", features={}, limits={})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)
    user = User(
        email="ops@acme.io",
        full_name="Ops",
        role_id=role.id,
        password_hash=hash_password("Passw0rd!"),
        is_active=True,
        tenant_id=tenant.id,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await db.refresh(user, attribute_names=["role"])
    return {"tenant": tenant, "user": user}


GUARDED = ["/sites", "/settings", "/auth/users"]
EXEMPT = ["/features", "/auth/me"]


@pytest.mark.parametrize("path", GUARDED)
async def test_a_suspended_tenants_token_stops_working(app, world, db, path):
    headers = _auth(world["user"])
    async with _client(app) as c:
        before = await c.get(f"{PREFIX}{path}", headers=headers)
        assert before.status_code == 200, f"{path} was not reachable to begin with: {before.text}"

        world["tenant"].status = "suspended"
        await db.commit()

        after = await c.get(f"{PREFIX}{path}", headers=headers)
    assert after.status_code == 403, f"{path} -> {after.status_code}"
    assert after.json()["error"]["code"] == "TENANT_SUSPENDED", after.text


@pytest.mark.parametrize("path", EXEMPT)
async def test_the_user_can_still_be_told_they_are_suspended(app, world, db, path):
    """If /features and /auth/me were guarded too, the console would get a 403 and
    have nothing to render the message from, and the user could not log out."""
    world["tenant"].status = "suspended"
    await db.commit()
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}{path}", headers=_auth(world["user"]))
    assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text}"


async def test_an_expired_licence_is_refused_and_grace_is_not(app, world, db):
    """`expired` blocks; `grace` passes, because grace exists to warn rather than to
    stop work. Asserting both ways is what stops the guard being "refuse everyone"."""
    import datetime as dt

    tenant = world["tenant"]
    headers = _auth(world["user"])
    async with _client(app) as c:
        tenant.license_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=365)
        await db.commit()
        expired = await c.get(f"{PREFIX}/sites", headers=headers)
        assert expired.status_code == 403, expired.text
        assert expired.json()["error"]["code"] == "LICENSE_EXPIRED"

        # Back inside the window.
        tenant.license_expires_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=30)
        await db.commit()
        ok = await c.get(f"{PREFIX}/sites", headers=headers)
    assert ok.status_code == 200, ok.text


async def test_a_super_admin_is_not_locked_out_of_a_suspended_tenant(app, world, db):
    """Someone has to be able to un-suspend."""
    role = await make_role(db, "Platform", ["*"])
    sa = User(
        email="sa-susp@x.io",
        full_name="SA",
        role_id=role.id,
        password_hash=hash_password("Passw0rd!"),
        is_active=True,
        tenant_id=None,
        is_superadmin=True,
    )
    db.add(sa)
    await db.commit()
    await db.refresh(sa)
    await db.refresh(sa, attribute_names=["role"])
    world["tenant"].status = "suspended"
    await db.commit()
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/sites", headers=_auth(sa))
    assert r.status_code == 200, r.text


async def test_a_service_key_of_a_suspended_tenant_is_refused(app, world, db):
    """The reason the guard could not be applied widely before: it resolved a USER,
    and api-key tokens are refused on that path by design — so attaching it to any
    router a key needs 401ed the key. It now resolves either kind."""
    from app.auth.schemas import ApiKeyCreateIn
    from app.auth.service import AuthService
    from app.tenancy.scope import scope_of

    _key, raw = await AuthService(db).create_api_key(
        ApiKeyCreateIn(name="reader", scopes=["audit.read"]),
        scope=scope_of(world["user"]),
        actor=world["user"],
    )
    # The raw key is not a bearer token: it is exchanged at /auth/token for a JWT
    # carrying `act: "apikey"`. That token is what the guard has to understand.
    async with _client(app) as c:
        exchanged = await c.post(f"{PREFIX}/auth/token", json={"api_key": raw})
    assert exchanged.status_code == 200, exchanged.text
    headers = {"Authorization": f"Bearer {exchanged.json()['access_token']}"}
    # /audit, not /sites: the sites routes resolve their scope through
    # `get_current_user`, which refuses a service credential outright, so a key
    # cannot reach them at all. /audit is a surface keys genuinely use.
    async with _client(app) as c:
        before = await c.get(f"{PREFIX}/audit", headers=headers)
        assert before.status_code == 200, before.text
        world["tenant"].status = "suspended"
        await db.commit()
        after = await c.get(f"{PREFIX}/audit", headers=headers)
    assert after.status_code == 403, after.text
