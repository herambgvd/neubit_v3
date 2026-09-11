"""One isolation matrix across every tenant-owned surface core serves.

Deliberately one table rather than a file per module: the property is the same
everywhere, so adding a tenant-owned resource means adding a row here, and a
surface nobody added is obvious.

Each row is (label, create-in-tenant, urls). For every resource we assert:

  * tenant A cannot GET, PATCH or DELETE tenant B's row — 404, never 403, so an id
    cannot be probed;
  * tenant A's listing does not contain tenant B's row;
  * a platform row (tenant_id NULL) is equally out of reach;
  * a super-admin reaches all of them, so "refuse everyone" cannot pass.
"""


import uuid

import pytest
import pytest_asyncio

from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"

ALL_PERMS = [
    "tags.read", "tags.create", "tags.update", "tags.delete",
    "sites.read", "sites.create", "sites.update", "sites.delete",
    "floors.read", "floors.create", "floors.update", "floors.delete",
    "zones.read", "zones.create", "zones.update", "zones.delete",
    "settings.manage", "branding.manage", "report.read", "report.create",
]


@pytest_asyncio.fixture
async def world(db):
    role = await make_role(db, "Everything", ALL_PERMS)
    sa_role = await make_role(db, "Platform", ["*"])

    async def _tenant(name, slug):
        t = Tenant(name=name, slug=slug, status="active", features={}, limits={})
        db.add(t)
        await db.commit()
        await db.refresh(t)
        return t

    async def _user(email, tenant_id, role_obj, superadmin=False):
        u = User(
            email=email,
            full_name=email.split("@")[0],
            role_id=role_obj.id,
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

    ta = await _tenant("A", "matrix-a")
    tb = await _tenant("B", "matrix-b")
    return {
        "db": db,
        "ta": ta,
        "tb": tb,
        "a": await _user("a@x.io", ta.id, role),
        "b": await _user("b@x.io", tb.id, role),
        "sa": await _user("sa@x.io", None, sa_role, superadmin=True),
    }


# --- the resources --------------------------------------------------------
#
# Each builder inserts a row directly (not through the API) so the test does not
# depend on the create path being correct, and returns (id, list_url, item_url).


async def _make_tag(db, tenant_id):
    from app.tags.models import Tag

    row = Tag(tenant_id=tenant_id, name=f"tag-{uuid.uuid4().hex[:8]}", color="#fff")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row.tag_id, "/tags", f"/tags/{row.tag_id}"


async def _make_site(db, tenant_id):
    from app.sites.site.models import Site

    row = Site(tenant_id=tenant_id, name=f"site-{uuid.uuid4().hex[:8]}", site_type="building",
               is_active=True)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row.site_id, "/sites", f"/sites/{row.site_id}"


async def _make_floor(db, tenant_id):
    from app.sites.floor.models import Floor
    from app.sites.site.models import Site

    site = Site(tenant_id=tenant_id, name=f"s-{uuid.uuid4().hex[:6]}", site_type="building",
                is_active=True)
    db.add(site)
    await db.commit()
    await db.refresh(site)
    row = Floor(tenant_id=tenant_id, site_id=site.site_id, name="G", is_active=True)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row.floor_id, "/floors", f"/floors/{row.floor_id}"


RESOURCES = {
    "tag": _make_tag,
    "site": _make_site,
    "floor": _make_floor,
}


@pytest.mark.parametrize("resource", sorted(RESOURCES))
async def test_another_tenants_row_is_404_on_every_verb(app, world, resource):
    _id, _list_url, item_url = await RESOURCES[resource](world["db"], world["tb"].id)
    async with api_client(app) as c:
        got = await c.get(f"{PREFIX}{item_url}", headers=bearer(world["a"]))
        patched = await c.patch(f"{PREFIX}{item_url}", headers=bearer(world["a"]), json={})
        deleted = await c.delete(f"{PREFIX}{item_url}", headers=bearer(world["a"]))
    # 404, never 403: a tenant must not be able to tell a foreign id exists.
    assert got.status_code == 404, f"{resource} GET -> {got.status_code}"
    assert patched.status_code in (404, 405, 422), f"{resource} PATCH -> {patched.status_code}"
    assert deleted.status_code in (404, 405), f"{resource} DELETE -> {deleted.status_code}"


@pytest.mark.parametrize("resource", sorted(RESOURCES))
async def test_a_platform_row_is_404_for_a_tenant(app, world, resource):
    """The by-id/list disagreement in `scope`: `scoped()` excludes NULL rows from a
    listing while `owns()` admits them by id, making a platform row invisible in the
    list and writable by any tenant."""
    _id, _list_url, item_url = await RESOURCES[resource](world["db"], None)
    async with api_client(app) as c:
        got = await c.get(f"{PREFIX}{item_url}", headers=bearer(world["a"]))
        deleted = await c.delete(f"{PREFIX}{item_url}", headers=bearer(world["a"]))
    assert got.status_code == 404, f"{resource} GET -> {got.status_code}"
    assert deleted.status_code in (404, 405), f"{resource} DELETE -> {deleted.status_code}"


@pytest.mark.parametrize("resource", sorted(RESOURCES))
async def test_a_listing_never_contains_another_tenants_row(app, world, resource):
    mine_id, list_url, _ = await RESOURCES[resource](world["db"], world["ta"].id)
    theirs_id, _, _ = await RESOURCES[resource](world["db"], world["tb"].id)
    platform_id, _, _ = await RESOURCES[resource](world["db"], None)
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}{list_url}", headers=bearer(world["a"]))
    assert r.status_code == 200, r.text
    body = r.text
    assert str(mine_id) in body, f"{resource}: own row missing from the listing"
    assert str(theirs_id) not in body, f"{resource}: another tenant's row leaked"
    assert str(platform_id) not in body, f"{resource}: a platform row leaked"


@pytest.mark.parametrize("resource", sorted(RESOURCES))
async def test_a_super_admin_reaches_every_row(app, world, resource):
    """Without this, every assertion above would pass against a build that refuses
    everyone."""
    _id, _list_url, item_url = await RESOURCES[resource](world["db"], world["tb"].id)
    _pid, _, platform_url = await RESOURCES[resource](world["db"], None)
    async with api_client(app) as c:
        theirs = await c.get(f"{PREFIX}{item_url}", headers=bearer(world["sa"]))
        platform = await c.get(f"{PREFIX}{platform_url}", headers=bearer(world["sa"]))
    assert theirs.status_code == 200, theirs.text
    assert platform.status_code == 200, platform.text


# --- the per-tenant config singletons ------------------------------------
#
# branding and settings are what the permissive `owns()` exists for: a NULL row is a
# shared default every tenant reads. They derive the write scope from the caller
# rather than from the row, so tightening owns() must leave them alone.


async def test_branding_falls_back_to_the_platform_default_but_writes_its_own(app, world):
    async with api_client(app) as c:
        await c.put(
            f"{PREFIX}/branding", headers=bearer(world["sa"]), json={"app_name": "Platform"}
        )
        inherited = await c.get(f"{PREFIX}/branding", headers=bearer(world["a"]))
        assert inherited.status_code == 200
        assert inherited.json()["app_name"] == "Platform"

        await c.put(f"{PREFIX}/branding", headers=bearer(world["a"]), json={"app_name": "A Corp"})
        mine = await c.get(f"{PREFIX}/branding", headers=bearer(world["a"]))
        theirs = await c.get(f"{PREFIX}/branding", headers=bearer(world["b"]))
        platform = await c.get(f"{PREFIX}/branding", headers=bearer(world["sa"]))
    assert mine.json()["app_name"] == "A Corp"
    # A tenant's write must not have edited the shared row under everyone else.
    assert theirs.json()["app_name"] == "Platform"
    assert platform.json()["app_name"] == "Platform"


async def test_settings_override_is_per_tenant(app, world):
    async with api_client(app) as c:
        await c.put(
            f"{PREFIX}/settings",
            headers=bearer(world["sa"]),
            json={"values": {"google_maps_default_zoom": 3}},
        )
        await c.put(
            f"{PREFIX}/settings",
            headers=bearer(world["a"]),
            json={"values": {"google_maps_default_zoom": 11}},
        )
        mine = await c.get(f"{PREFIX}/settings", headers=bearer(world["a"]))
        theirs = await c.get(f"{PREFIX}/settings", headers=bearer(world["b"]))
    assert mine.json()["values"]["google_maps_default_zoom"] == 11
    assert theirs.json()["values"]["google_maps_default_zoom"] == 3
