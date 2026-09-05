"""One assertion over EVERY route core serves under ``/admin``.

The eight routers mounted there — tenants, billing, broadcasts, alerts, infra,
platform defaults, the module catalog and the device-brand catalog — are the
cross-tenant control plane. They are not tenant-scoped and they are not meant to
be: the property that keeps them safe is not isolation but a realm boundary, that
a tenant's own administrator, however privileged inside their tenancy, cannot
reach them at all.

That property is stated ONCE here, against the live route table, rather than
per-router. A per-router test only covers the routes its author remembered; this
one enumerates what the app actually mounts, so a new ``/admin`` route added
without ``require_superadmin`` fails the moment it is included — which is the only
moment anyone would notice, since a missing gate is invisible in every response a
super-admin ever sees.

Two catalogs are deliberately readable by any signed-in user (the console renders
the per-tenant feature toggles and the add-device brand picker from them), so they
are named as exceptions with their reason. Anything else appearing in that
allowlist should be argued for, not added.

Both directions are asserted. A test that only checks the 403 passes against a
route that refuses everyone, which is an outage rather than a boundary — so the
super-admin leg asserts each route is NOT refused, without caring what it returns
against an empty database.
"""

from __future__ import annotations

import re
import uuid

import httpx
import pytest
import pytest_asyncio

# Imported for their side effect: these tables are not in conftest's model list,
# and `Base.metadata.create_all` only creates what has been imported.
import app.alerts.models  # noqa: F401
import app.billing.models  # noqa: F401
import app.broadcasts.models  # noqa: F401
from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.db.base import get_db
from app.tenancy.models import Tenant
from conftest import make_role

# Reused rather than re-derived: this FastAPI version defers `include_router`, so
# `app.routes` holds wrappers and a naive walk sees a fraction of the surface with
# unprefixed paths — the exact mistake that once hid an unauthenticated route. That
# flattening is already written down and explained in the route inventory; a second
# copy here would be a second thing to keep correct.
from test_route_inventory import _walk

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"

# The only /admin routes a non-super-admin may reach, and why.
#
#   GET /admin/modules            — the console renders a tenant's feature toggles
#                                   from the catalog, so every operator reads it.
#   GET /admin/device-brands      — the brand picker on the add-device form.
#   GET /admin/device-brands/{id} — the detail behind that picker.
#
# Both are platform-global read-only catalogs holding no tenant data. Their
# mutations are NOT here and are covered by this file like everything else.
TENANT_READABLE = {
    ("GET", "/api/v1/admin/modules"),
    ("GET", "/api/v1/admin/device-brands"),
    ("GET", "/api/v1/admin/device-brands/{brand_pk}"),
}


@pytest.fixture(autouse=True)
def _ops_agent_is_local(monkeypatch):
    """The infra routes forward to the ops-agent sidecar, which is not running and
    is not reachable at all under `--network none`. Point them at a closed loopback
    port so they fail FAST with 503 instead of stalling on a name lookup — the
    status does not matter to this file, only that it is not a 403."""
    monkeypatch.setenv("OPS_AGENT_URL", "http://127.0.0.1:9")


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


def _admin_routes(app) -> list[tuple[str, str]]:
    """(method, path template) for every mounted route under /api/v1/admin."""
    out: list[tuple[str, str]] = []
    for path, route in _walk(app.routes):
        if not path.startswith(f"{PREFIX}/admin"):
            continue
        for method in sorted(getattr(route, "methods", set()) - {"HEAD", "OPTIONS"}):
            out.append((method, path))
    return sorted(set(out))


def _concrete(path: str) -> str:
    """Fill a path template with syntactically valid values.

    The values are deliberately values that exist nowhere: what is under test is
    whether the request is refused BEFORE the handler looks anything up, so a real
    id would weaken the assertion rather than strengthen it.
    """

    def sub(m: re.Match) -> str:
        name = m.group(1).split(":")[0]
        return str(uuid.uuid4()) if name.endswith(("_id", "_pk")) else "does-not-exist"

    return re.sub(r"{([^}]+)}", sub, path)


@pytest_asyncio.fixture
async def actors(db):
    """A tenant administrator holding the WILDCARD inside an active tenant, and a
    platform super-admin. The wildcard matters: it is the strongest credential a
    tenant can ever hold, so a 403 for it is a 403 for every tenant user."""
    tenant_role = await make_role(db, "TenantAdmin", ["*"])
    platform_role = await make_role(db, "Platform", ["*"])
    tenant = Tenant(name="Acme", slug="realm-acme", status="active", features={}, limits={})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    async def _user(email, tenant_id, role, superadmin):
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

    return {
        "tenant": tenant,
        "tenant_admin": await _user("ta@x.io", tenant.id, tenant_role, False),
        "superadmin": await _user("sa@x.io", None, platform_role, True),
    }


async def _call(c, method: str, path: str, headers: dict) -> httpx.Response:
    kwargs = {"headers": headers}
    if method in ("POST", "PUT", "PATCH"):
        kwargs["json"] = {}
    return await c.request(method, path, **kwargs)


async def test_the_admin_surface_is_the_size_this_file_thinks_it_is(app):
    """A guard on the guard. Every assertion below is a loop over the route table,
    so if the table ever came back empty — a renamed prefix, a router dropped from
    `base_routers()` — the loop would pass by iterating over nothing."""
    routes = _admin_routes(app)
    # 58 at the time of writing, across the eight routers mounted under /admin.
    assert len(routes) >= 55, f"only {len(routes)} /admin routes found: {routes}"


async def test_a_tenant_admin_is_refused_by_every_admin_route(app, actors):
    """The realm boundary. A tenant-scoped credential — even one holding the
    wildcard permission, which grants everything inside its own tenancy — must not
    reach the cross-tenant control plane at all.

    Catches a new /admin route that hangs off `get_current_user` or a permission
    check instead of `require_superadmin`: that route would hand every tenant
    administrator on the platform another tenant's billing, licences or containers.
    """
    reached = []
    async with _client(app) as c:
        for method, path in _admin_routes(app):
            if (method, path) in TENANT_READABLE:
                continue
            r = await _call(c, method, _concrete(path), _auth(actors["tenant_admin"]))
            if r.status_code != 403:
                reached.append(f"{method} {path} -> {r.status_code}")
    assert not reached, "a tenant admin was not refused by:\n  " + "\n  ".join(reached)


async def test_a_super_admin_is_refused_by_no_admin_route(app, actors):
    """The other half. Without this, the test above would pass against a build that
    403s everyone, which is not a boundary — it is the admin console being down.

    The status is not asserted (against an empty database most of these are 404 or
    422, and the infra routes are 503 with no sidecar); only that the caller got
    past the gate.
    """
    refused = []
    async with _client(app) as c:
        for method, path in _admin_routes(app):
            r = await _call(c, method, _concrete(path), _auth(actors["superadmin"]))
            if r.status_code in (401, 403):
                refused.append(f"{method} {path} -> {r.status_code} {r.text[:120]}")
    assert not refused, "a super-admin was refused by:\n  " + "\n  ".join(refused)


async def test_an_unauthenticated_caller_is_refused_by_every_admin_route(app):
    """No /admin route may be reachable without a credential — including the two
    catalogs a tenant user may read, which still require a signed-in user."""
    reached = []
    async with _client(app) as c:
        for method, path in _admin_routes(app):
            r = await _call(c, method, _concrete(path), {})
            if r.status_code not in (401, 403):
                reached.append(f"{method} {path} -> {r.status_code}")
    assert not reached, "an anonymous caller was not refused by:\n  " + "\n  ".join(reached)


async def test_an_impersonation_token_cannot_re_enter_the_admin_api(app, actors, db):
    """Impersonation mints a token FOR the tenant's own administrator so a
    super-admin can see what the customer sees. That token is a tenant-realm
    credential and must not walk back into the cross-tenant console — otherwise
    "view as customer" would be a way to keep platform powers while wearing a
    tenant's identity, and every audit entry written from it would name the wrong
    person.
    """
    tenant_id = actors["tenant"].id
    async with _client(app) as c:
        minted = await c.post(
            f"{PREFIX}/admin/tenants/{tenant_id}/impersonate",
            headers=_auth(actors["superadmin"]),
        )
        assert minted.status_code == 200, minted.text
        token = minted.json()["access_token"]
        back_in = await c.get(
            f"{PREFIX}/admin/tenants", headers={"Authorization": f"Bearer {token}"}
        )
    assert back_in.status_code == 403, back_in.text
