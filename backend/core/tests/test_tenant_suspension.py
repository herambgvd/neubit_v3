"""A suspended tenant's token must stop working, not keep working until it expires.

Suspension is enforced at login, so without a check on the request path a token
minted a minute earlier keeps working for the rest of its TTL — and suspension is a
commercial control, so that window is the control.

Two things make `require_tenant_active` hold rather than being one more router
someone remembers:

  * `app/app.py` inverts the default — every base router is guarded unless named in
    `_tenant_active_exempt()`, with a reason;
  * the dependency resolves a person or a service key. Resolving it through
    `get_current_user` would 401 every api-key token, which is why it could only
    live on one router before.
"""


import pytest
import pytest_asyncio

from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"


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
    headers = bearer(world["user"])
    async with api_client(app) as c:
        before = await c.get(f"{PREFIX}{path}", headers=headers)
        assert before.status_code == 200, f"{path} was not reachable to begin with: {before.text}"

        world["tenant"].status = "suspended"
        await db.commit()

        after = await c.get(f"{PREFIX}{path}", headers=headers)
    assert after.status_code == 403, f"{path} -> {after.status_code}"
    assert after.json()["error"]["code"] == "TENANT_SUSPENDED", after.text


@pytest.mark.parametrize("path", EXEMPT)
async def test_the_user_can_still_be_told_they_are_suspended(app, world, db, path):
    """Guarding /features and /auth/me too would leave the console with a 403 and
    nothing to render the message from, and the user unable to log out."""
    world["tenant"].status = "suspended"
    await db.commit()
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}{path}", headers=bearer(world["user"]))
    assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text}"


async def test_an_expired_licence_is_refused_and_grace_is_not(app, world, db):
    """`expired` blocks and `grace` passes, because grace warns rather than stops
    work. Both directions, so the guard cannot just refuse everyone."""
    import datetime as dt

    tenant = world["tenant"]
    headers = bearer(world["user"])
    async with api_client(app) as c:
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
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}/sites", headers=bearer(sa))
    assert r.status_code == 200, r.text


async def test_a_service_key_of_a_suspended_tenant_is_refused(app, world, db):
    """The guard resolves either kind of caller. Resolving a user would 401 every
    api-key token, which is why it could not be applied widely before."""
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
    async with api_client(app) as c:
        exchanged = await c.post(f"{PREFIX}/auth/token", json={"api_key": raw})
    assert exchanged.status_code == 200, exchanged.text
    headers = {"Authorization": f"Bearer {exchanged.json()['access_token']}"}
    # /audit, not /sites: sites resolves its scope through `get_current_user`, which
    # refuses a service credential outright. /audit is a surface keys actually use.
    async with api_client(app) as c:
        before = await c.get(f"{PREFIX}/audit", headers=headers)
        assert before.status_code == 200, before.text
        world["tenant"].status = "suspended"
        await db.commit()
        after = await c.get(f"{PREFIX}/audit", headers=headers)
    assert after.status_code == 403, after.text
