"""The platform-default rows, and the cross-tenant audit view.

``tenant_id NULL`` means two different things in this schema, and the whole
isolation model turns on telling them apart. For sites, tags, users and report
jobs a NULL row is the PLATFORM's own row and belongs to nobody else — reachable
by a tenant is a privilege escalation, which is what ``owns()`` was fixed for. For
settings and branding a NULL row is a SHARED DEFAULT that every tenant reads
through until it sets its own.

These five routes are the only way to edit that second kind on purpose. They are
therefore the place where the two meanings meet, and the failure to catch is the
one that would look like nothing: a super-admin editing "the platform default" and
silently writing into whichever tenant they happen to be standing in, or a tenant
editing its own theme and overwriting the default under everybody else. The tests
below assert the inheritance in one direction and its absence in the other.

The audit view is here for the same reason — it is the cross-tenant read of a
table whose per-tenant read is filtered, so the two must disagree deliberately.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
import pytest_asyncio

from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.core.audit import AuditLog
from app.db.base import get_db
from app.tenancy.models import Tenant
from conftest import make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
PLATFORM = f"{PREFIX}/admin/platform"


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
    sa_role = await make_role(db, "Platform", ["*"])
    t_role = await make_role(db, "TenantAdmin", ["*"])

    async def _tenant(name, slug):
        t = Tenant(name=name, slug=slug, status="active", features={}, limits={})
        db.add(t)
        await db.commit()
        await db.refresh(t)
        return t

    async def _user(email, tenant_id, role, superadmin=False):
        u = User(
            email=email, full_name=email.split("@")[0], role_id=role.id,
            password_hash=hash_password("Passw0rd!"), is_active=True,
            tenant_id=tenant_id, is_superadmin=superadmin,
        )
        db.add(u)
        await db.commit()
        await db.refresh(u)
        await db.refresh(u, attribute_names=["role"])
        return u

    ta = await _tenant("Acme", "pd-acme")
    tb = await _tenant("Globex", "pd-globex")
    return {
        "db": db,
        "ta": ta,
        "tb": tb,
        "a": await _user("pd-a@x.io", ta.id, t_role),
        "b": await _user("pd-b@x.io", tb.id, t_role),
        "sa": await _user("pd-sa@x.io", None, sa_role, superadmin=True),
    }


# --- settings ----------------------------------------------------------------
async def test_a_platform_setting_is_inherited_until_a_tenant_overrides_it(app, world):
    """The point of the shared default: change it once, and every tenant that has
    not expressed an opinion follows. A tenant that HAS is left where it is —
    otherwise a platform-wide edit would silently reset customer configuration."""
    async with _client(app) as c:
        await c.put(
            f"{PREFIX}/settings", headers=_auth(world["b"]),
            json={"values": {"google_maps_default_zoom": 15}},
        )
        patched = await c.patch(
            f"{PLATFORM}/settings", headers=_auth(world["sa"]),
            json={"values": {"google_maps_default_zoom": 4}},
        )
        inheriting = await c.get(f"{PREFIX}/settings", headers=_auth(world["a"]))
        overriding = await c.get(f"{PREFIX}/settings", headers=_auth(world["b"]))

    assert patched.status_code == 200, patched.text
    assert patched.json()["values"]["google_maps_default_zoom"] == 4
    assert inheriting.json()["values"]["google_maps_default_zoom"] == 4
    assert overriding.json()["values"]["google_maps_default_zoom"] == 15


async def test_a_tenants_own_setting_never_lands_on_the_platform_default(app, world):
    """The escalation this pair of routes exists to prevent. One tenant's write
    reaching the NULL row would reconfigure every other tenant on the platform,
    and nothing in that tenant's response would say so."""
    async with _client(app) as c:
        await c.patch(
            f"{PLATFORM}/settings", headers=_auth(world["sa"]),
            json={"values": {"google_maps_default_zoom": 4}},
        )
        await c.put(
            f"{PREFIX}/settings", headers=_auth(world["a"]),
            json={"values": {"google_maps_default_zoom": 19}},
        )
        default_now = await c.get(f"{PLATFORM}/settings", headers=_auth(world["sa"]))
        other_tenant = await c.get(f"{PREFIX}/settings", headers=_auth(world["b"]))

    assert default_now.json()["values"]["google_maps_default_zoom"] == 4
    assert other_tenant.json()["values"]["google_maps_default_zoom"] == 4


async def test_the_platform_settings_response_carries_the_catalog_it_is_edited_against(app, world):
    """The console renders the editor from `catalog`, not from the values. An empty
    catalog would give a super-admin a settings page with nothing on it, which
    reads as "there is nothing to configure" rather than as a bug."""
    async with _client(app) as c:
        r = await c.get(f"{PLATFORM}/settings", headers=_auth(world["sa"]))
    assert r.status_code == 200
    assert r.json()["catalog"], "the settings catalog came back empty"


# --- branding ----------------------------------------------------------------
async def test_platform_branding_is_the_theme_a_tenant_falls_back_to(app, world):
    """A tenant that has never set its own theme renders the platform's. If this
    route wrote anywhere else, editing the platform's own branding would appear to
    do nothing at all.

    Deliberately asserted through a TENANT's read rather than an anonymous one.
    `GET /branding` documents itself as public — "the login page must always be
    able to theme itself" — but it currently answers 401 without a bearer token,
    because `create_base_app` guards every base router with `require_tenant_active`
    and the branding router is not in `_tenant_active_exempt()`. That is a defect in
    the app wiring, not in this route, and pinning it here would freeze it.
    """
    async with _client(app) as c:
        patched = await c.patch(
            f"{PLATFORM}/branding", headers=_auth(world["sa"]),
            json={"app_name": "Neubit Platform", "primary_color": "#101010"},
        )
        as_tenant = await c.get(f"{PREFIX}/branding", headers=_auth(world["a"]))

    assert patched.status_code == 200, patched.text
    assert patched.json()["app_name"] == "Neubit Platform"
    assert patched.json()["primary_color"] == "#101010"
    assert as_tenant.json()["app_name"] == "Neubit Platform"


async def test_a_tenants_branding_is_its_own_and_the_default_survives_it(app, world):
    """Whitelabelling. One customer's logo and colours appearing on the login page,
    or in another customer's console, is the most visible failure this platform
    has available to it."""
    async with _client(app) as c:
        await c.patch(
            f"{PLATFORM}/branding", headers=_auth(world["sa"]), json={"app_name": "Platform"}
        )
        await c.put(f"{PREFIX}/branding", headers=_auth(world["a"]), json={"app_name": "Acme"})

        mine = await c.get(f"{PREFIX}/branding", headers=_auth(world["a"]))
        neighbour = await c.get(f"{PREFIX}/branding", headers=_auth(world["b"]))
        default = await c.get(f"{PLATFORM}/branding", headers=_auth(world["sa"]))

    assert mine.json()["app_name"] == "Acme"
    assert neighbour.json()["app_name"] == "Platform"
    assert default.json()["app_name"] == "Platform"
    # Different rows, not one row read twice.
    assert mine.json()["id"] != default.json()["id"]


# --- the cross-tenant audit view ---------------------------------------------
async def _entry(db, tenant_id, action: str) -> AuditLog:
    row = AuditLog(
        actor_id=None, actor_email="someone@x.io", actor_name=None, actor_type="user",
        tenant_id=tenant_id, action=action, target_type=None, target_id=None, meta={},
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def test_the_admin_audit_view_spans_every_tenant_and_the_platform(app, world):
    """The normal /audit is filtered to the caller's tenant. This one is
    deliberately not — an investigation that has to be run tenant by tenant is one
    where a cross-tenant pattern is invisible by construction."""
    await _entry(world["db"], world["ta"].id, "acme.thing")
    await _entry(world["db"], world["tb"].id, "globex.thing")
    await _entry(world["db"], None, "platform.thing")

    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/admin/audit", headers=_auth(world["sa"]))

    assert r.status_code == 200, r.text
    actions = {e["action"] for e in r.json()["items"]}
    assert {"acme.thing", "globex.thing", "platform.thing"} <= actions


async def test_the_admin_audit_view_narrows_to_one_tenant_when_asked(app, world):
    """The filter is how a support investigation stays about one customer. A filter
    that narrows the page but not the count reports a total the operator cannot
    reconcile with what is on screen — the two are separate statements here."""
    await _entry(world["db"], world["ta"].id, "acme.one")
    await _entry(world["db"], world["ta"].id, "acme.two")
    await _entry(world["db"], world["tb"].id, "globex.one")
    await _entry(world["db"], None, "platform.one")

    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/admin/audit", headers=_auth(world["sa"]),
            params={"tenant_id": str(world["ta"].id)},
        )

    body = r.json()
    assert body["total"] == 2, body
    assert {e["action"] for e in body["items"]} == {"acme.one", "acme.two"}


async def test_filtering_the_audit_view_to_a_tenant_that_does_not_exist_is_empty(app, world):
    """Not an error: a super-admin filtering by an id that has been offboarded
    should see that there is nothing, rather than a 404 that reads as a broken
    page."""
    await _entry(world["db"], world["ta"].id, "acme.one")
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/admin/audit", headers=_auth(world["sa"]),
            params={"tenant_id": str(uuid.uuid4())},
        )
    assert r.status_code == 200
    assert r.json()["items"] == []
    assert r.json()["total"] == 0
