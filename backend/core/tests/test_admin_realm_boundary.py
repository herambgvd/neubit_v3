"""One assertion over every route core serves under ``/admin``.

The eight routers mounted there are the cross-tenant control plane. They are not
tenant-scoped and are not meant to be; what keeps them safe is a realm boundary — a
tenant's own administrator, however privileged inside their tenancy, cannot reach
them at all.

Stated once here against the live route table rather than per-router, because a
per-router test only covers the routes its author remembered. A new ``/admin`` route
without ``require_superadmin`` fails the moment it is included, which is the only
moment anyone would notice — a missing gate is invisible in every response a
super-admin sees.

Two catalogs are deliberately readable by any signed-in user and are named as
exceptions with their reason; argue for anything else before adding it.

Both directions are asserted: a 403-only test passes against a build that refuses
everyone, which is an outage rather than a boundary.
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

# Reused rather than re-derived: this FastAPI version defers `include_router`, so a
# naive walk of `app.routes` sees a fraction of the surface with unprefixed paths.
# The flattening is explained in the route inventory; do not write a second copy.
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
# mutations are not exempt and are covered like everything else.
TENANT_READABLE = {
    ("GET", "/api/v1/admin/modules"),
    ("GET", "/api/v1/admin/device-brands"),
    ("GET", "/api/v1/admin/device-brands/{brand_pk}"),
}


@pytest.fixture(autouse=True)
def _ops_agent_is_local(monkeypatch):
    """The infra routes forward to the ops-agent sidecar, which is unreachable under
    `--network none`. A closed loopback port makes them fail fast with 503 instead of
    stalling on a name lookup; only "not a 403" matters here."""
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

    Deliberately values that exist nowhere: what is under test is refusal before the
    handler looks anything up, so a real id would weaken the assertion.
    """

    def sub(m: re.Match) -> str:
        name = m.group(1).split(":")[0]
        return str(uuid.uuid4()) if name.endswith(("_id", "_pk")) else "does-not-exist"

    return re.sub(r"{([^}]+)}", sub, path)


@pytest_asyncio.fixture
async def actors(db):
    """A tenant administrator holding the wildcard inside an active tenant, and a
    platform super-admin. The wildcard is the strongest credential a tenant can hold,
    so a 403 for it is a 403 for every tenant user."""
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
    """A guard on the guard: every assertion below loops over the route table, so an
    empty table would pass by iterating over nothing."""
    routes = _admin_routes(app)
    # 58 at the time of writing, across the eight routers mounted under /admin.
    assert len(routes) >= 55, f"only {len(routes)} /admin routes found: {routes}"


async def test_a_tenant_admin_is_refused_by_every_admin_route(app, actors):
    """The realm boundary: a tenant-scoped credential, even a wildcard one, must not
    reach the cross-tenant control plane at all.

    Catches a new /admin route hung off `get_current_user` or a permission check
    instead of `require_superadmin`, which would hand every tenant administrator
    another tenant's billing, licences or containers.
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
    """The other half: without it, the test above passes against a build that 403s
    everyone, which is the admin console being down.

    Only "got past the gate" is asserted — against an empty database most of these
    are 404 or 422, and the infra routes are 503 with no sidecar.
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
    """Impersonation mints a tenant-realm token, which must not walk back into the
    cross-tenant console: that would keep platform powers while wearing a tenant's
    identity, and every audit entry written from it would name the wrong person.
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
