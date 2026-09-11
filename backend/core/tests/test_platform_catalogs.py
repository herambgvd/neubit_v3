"""The two platform catalogs — modules and device brands.

The only routes under ``/admin`` a tenant user may call, and the only pair with a
split gate: the list is readable by anyone signed in (the console renders feature
toggles and the add-device brand picker from them) while every mutation is
super-admin. A split gate gets its own file because it is the shape where "the route
is protected" is half true and a read dependency copy-pasted onto a write is
invisible in review.

Both catalogs are platform-global, with no tenant_id anywhere, so the property is
the opposite of tenant isolation: two tenants must see the same catalog, because a
module key a tenant cannot see is a feature its operator cannot be granted.

Rows go in through the super-admin routes, because the create path is part of what
the console does with these.
"""


import uuid

import pytest
import pytest_asyncio

from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.device_brands.models import DeviceBrand
from app.module_catalog.models import Module
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
MODULES = f"{PREFIX}/admin/modules"
BRANDS = f"{PREFIX}/admin/device-brands"


@pytest_asyncio.fixture
async def world(db):
    """A super-admin and two tenant users in different tenants, one holding no
    permissions at all — "any authenticated user" is a claim about the weakest
    credential."""
    sa_role = await make_role(db, "Platform", ["*"])
    admin_role = await make_role(db, "TenantAdmin", ["*"])
    nobody_role = await make_role(db, "Viewer", [])

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

    ta = await _tenant("Acme", "cat-acme")
    tb = await _tenant("Globex", "cat-globex")
    return {
        "db": db,
        "sa": await _user("cat-sa@x.io", None, sa_role, superadmin=True),
        "admin_a": await _user("cat-a@x.io", ta.id, admin_role),
        "viewer_b": await _user("cat-b@x.io", tb.id, nobody_role),
    }


# --- the split gate, both directions -----------------------------------------
async def test_any_signed_in_user_can_read_both_catalogs(app, world):
    """The read side, asserted with a role holding no permissions: the console cannot
    render feature toggles without the module keys, nor the add-device form without
    the brands, so a permission gate here breaks the UI for non-administrators."""
    world["db"].add(Module(key="vms", name="Video", description="", category="Video"))
    world["db"].add(DeviceBrand(brand_id="hikvision", name="Hikvision", sdk_type="hikvision"))
    await world["db"].commit()

    async with api_client(app) as c:
        modules = await c.get(MODULES, headers=bearer(world["viewer_b"]))
        brands = await c.get(BRANDS, headers=bearer(world["viewer_b"]))

    assert modules.status_code == 200, modules.text
    assert [m["key"] for m in modules.json()] == ["vms"]
    assert brands.status_code == 200, brands.text
    assert [b["brand_id"] for b in brands.json()] == ["hikvision"]


@pytest.mark.parametrize(
    "verb,url,body",
    [
        ("POST", MODULES, {"key": "sneaky", "name": "Sneaky"}),
        ("PATCH", MODULES + "/{id}", {"name": "renamed"}),
        ("DELETE", MODULES + "/{id}", None),
        ("POST", BRANDS, {"brand_id": "sneaky", "name": "Sneaky"}),
        ("PATCH", BRANDS + "/{id}", {"name": "renamed"}),
        ("DELETE", BRANDS + "/{id}", None),
    ],
)
async def test_a_tenant_admin_may_read_the_catalogs_but_never_write_them(app, world, verb, url, body):
    """The write side. A tenant administrator holds the wildcard in their own tenancy
    and may read these rows, so the surface already answers this caller and a missing
    write gate is easy to miss.

    The keys here become the feature flags every tenant's licence is written against,
    so a tenant that could add one could grant itself a capability nobody sold it.
    """
    async with api_client(app) as c:
        r = await c.request(
            verb, url.replace("{id}", str(uuid.uuid4())),
            headers=bearer(world["admin_a"]), json=body,
        )
    assert r.status_code == 403, r.text


async def test_the_same_catalog_is_served_to_every_tenant(app, world):
    """The inverse of tenant isolation, and deliberate: these tables have no
    tenant_id, and a per-tenant view would hide module keys operators must grant."""
    async with api_client(app) as c:
        await c.post(MODULES, headers=bearer(world["sa"]), json={"key": "anpr", "name": "ANPR"})
        for_a = await c.get(MODULES, headers=bearer(world["admin_a"]))
        for_b = await c.get(MODULES, headers=bearer(world["viewer_b"]))
    assert for_a.json() == for_b.json()
    assert [m["key"] for m in for_a.json()] == ["anpr"]


# --- the module catalog ------------------------------------------------------
async def test_a_module_added_by_an_operator_is_never_a_system_module(app, world):
    """`is_system` protects the modules the platform ships from being deleted, so the
    create route must not honour a client-supplied flag — that would let anyone mint
    an undeletable row."""
    async with api_client(app) as c:
        r = await c.post(
            MODULES, headers=bearer(world["sa"]),
            json={"key": "anpr", "name": "ANPR", "category": "Video", "is_system": True},
        )
    assert r.status_code == 201, r.text
    assert r.json()["is_system"] is False


async def test_a_system_module_cannot_be_deleted(app, world):
    """The seeded modules are the keys every tenant's features dict is written
    against, so deleting one orphans that flag on every tenant at once."""
    seeded = Module(key="vms", name="Video", description="", category="Video", is_system=True)
    custom = Module(key="anpr", name="ANPR", description="", category="Video", is_system=False)
    world["db"].add_all([seeded, custom])
    await world["db"].commit()
    await world["db"].refresh(seeded)
    await world["db"].refresh(custom)

    async with api_client(app) as c:
        protected = await c.delete(f"{MODULES}/{seeded.id}", headers=bearer(world["sa"]))
        removable = await c.delete(f"{MODULES}/{custom.id}", headers=bearer(world["sa"]))
        left = await c.get(MODULES, headers=bearer(world["sa"]))

    assert protected.status_code == 422, protected.text
    # Not a dead route: the same call on a non-system module works.
    assert removable.status_code == 204, removable.text
    assert [m["key"] for m in left.json()] == ["vms"]


async def test_a_module_key_cannot_be_taken_twice(app, world):
    """The key is the feature flag, so two rows claiming one make "is this module
    enabled" ambiguous for every tenant."""
    async with api_client(app) as c:
        await c.post(MODULES, headers=bearer(world["sa"]), json={"key": "anpr", "name": "ANPR"})
        dup = await c.post(
            MODULES, headers=bearer(world["sa"]), json={"key": "anpr", "name": "ANPR Again"}
        )
        blank = await c.post(MODULES, headers=bearer(world["sa"]), json={"key": "  ", "name": "x"})
    assert dup.status_code == 409, dup.text
    assert blank.status_code == 422, blank.text


async def test_editing_a_module_changes_only_the_fields_that_were_sent(app, world):
    """PATCH semantics: an edit that nulled untouched fields would erase a module's
    description and category on every rename."""
    async with api_client(app) as c:
        created = await c.post(
            MODULES, headers=bearer(world["sa"]),
            json={"key": "anpr", "name": "ANPR", "description": "plates",
                  "category": "Video", "default_enabled": True},
        )
        edited = await c.patch(
            f"{MODULES}/{created.json()['id']}", headers=bearer(world["sa"]),
            json={"name": "Plate Recognition"},
        )
    assert edited.json()["name"] == "Plate Recognition"
    assert edited.json()["description"] == "plates"
    assert edited.json()["category"] == "Video"
    assert edited.json()["default_enabled"] is True
    assert edited.json()["key"] == "anpr"


async def test_a_module_that_does_not_exist_is_a_404_on_edit_and_on_delete(app, world):
    async with api_client(app) as c:
        missing = uuid.uuid4()
        patched = await c.patch(
            f"{MODULES}/{missing}", headers=bearer(world["sa"]), json={"name": "x"}
        )
        deleted = await c.delete(f"{MODULES}/{missing}", headers=bearer(world["sa"]))
    assert patched.status_code == 404
    assert deleted.status_code == 404


# --- the device-brand catalog ------------------------------------------------
async def test_a_device_brand_round_trips_its_protocol_and_capability_lists(app, world):
    """These lists drive what the add-device form offers — which protocol to speak,
    which capabilities to show — so dropping or flattening them misconfigures a real
    camera."""
    async with api_client(app) as c:
        created = await c.post(
            BRANDS, headers=bearer(world["sa"]),
            json={"brand_id": "hikvision", "name": "Hikvision", "sdk_type": "hikvision",
                  "protocols": ["onvif", "rtsp", "isapi"],
                  "capabilities": ["ptz", "events"], "onvif": True, "is_installed": False},
        )
        fetched = await c.get(
            f"{BRANDS}/{created.json()['id']}", headers=bearer(world["viewer_b"])
        )
    assert created.status_code == 201, created.text
    assert fetched.status_code == 200
    assert fetched.json()["protocols"] == ["onvif", "rtsp", "isapi"]
    assert fetched.json()["capabilities"] == ["ptz", "events"]
    assert fetched.json()["onvif"] is True


async def test_a_brand_id_cannot_be_taken_twice(app, world):
    """brand_id selects the driver, so two rows claiming one is a coin flip over
    which SDK a camera is talked to with."""
    async with api_client(app) as c:
        await c.post(BRANDS, headers=bearer(world["sa"]),
                     json={"brand_id": "dahua", "name": "Dahua"})
        dup = await c.post(BRANDS, headers=bearer(world["sa"]),
                           json={"brand_id": "dahua", "name": "Dahua Again"})
        blank = await c.post(BRANDS, headers=bearer(world["sa"]),
                             json={"brand_id": " ", "name": "x"})
    assert dup.status_code == 409, dup.text
    assert blank.status_code == 422, blank.text


async def test_marking_a_brands_driver_installed_is_a_partial_edit(app, world):
    """`is_installed` says this deployment has the SDK and is the field an operator
    toggles; flipping it must not disturb the protocol lists the form is built
    from."""
    async with api_client(app) as c:
        created = await c.post(
            BRANDS, headers=bearer(world["sa"]),
            json={"brand_id": "dahua", "name": "Dahua", "protocols": ["onvif", "rtsp"],
                  "capabilities": ["ptz"], "onvif": True},
        )
        edited = await c.patch(
            f"{BRANDS}/{created.json()['id']}", headers=bearer(world["sa"]),
            json={"is_installed": True},
        )
    assert edited.json()["is_installed"] is True
    assert edited.json()["protocols"] == ["onvif", "rtsp"]
    assert edited.json()["capabilities"] == ["ptz"]
    assert edited.json()["name"] == "Dahua"


async def test_a_device_brand_that_does_not_exist_is_a_404_on_every_verb(app, world):
    """Including the read, which any signed-in user may call — the one 404 here an
    unprivileged caller can observe."""
    missing = uuid.uuid4()
    async with api_client(app) as c:
        got = await c.get(f"{BRANDS}/{missing}", headers=bearer(world["viewer_b"]))
        patched = await c.patch(f"{BRANDS}/{missing}", headers=bearer(world["sa"]), json={})
        deleted = await c.delete(f"{BRANDS}/{missing}", headers=bearer(world["sa"]))
    assert got.status_code == 404
    assert patched.status_code == 404
    assert deleted.status_code == 404
