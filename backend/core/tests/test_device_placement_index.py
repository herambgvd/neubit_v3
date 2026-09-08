"""GET /device-placements/index — the estate map's join table.

The map answers "how many cameras are at this site, and which of them are
offline" for every site at once. by-floor/by-zone cannot: a campus is one request
per floor, and the caller does not know the floors until it has fetched them.

Two things are worth pinning: the route must not be shadowed by `/{device_id}`
(it would 404 as a missing placement, which reads like an empty estate), and it
is tenant-scoped like everything else in this module.
"""

from __future__ import annotations

import httpx
import pytest

from app.app import create_base_app
from app.auth.security import create_access_token
from app.db.base import get_db
from app.sites.device.models import DevicePlacement
from app.tenancy.models import Tenant
from conftest import make_role, make_user

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


async def _tenant(db, slug: str) -> Tenant:
    t = Tenant(name=slug, slug=slug, status="active", features={}, limits={})
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


def _placement(**over) -> DevicePlacement:
    base = dict(
        device_id="cam-1", device_type="camera", service="vms",
        site_id="site-1", floor_id="floor-1", zone_id=None,
        floor_position={"x": 10, "y": 20, "rotation": 0},
    )
    base.update(over)
    return DevicePlacement(**base)


async def test_the_index_lists_every_placement_in_the_tenant(app, db):
    acme = await _tenant(db, "index-acme")
    db.add_all([
        _placement(device_id="cam-1", tenant_id=acme.id),
        _placement(device_id="cam-2", tenant_id=acme.id, floor_id="floor-2"),
        _placement(device_id="door-1", device_type="door", tenant_id=acme.id, site_id="site-2"),
    ])
    await db.commit()

    role = await make_role(db, "Ops", ["devices.read"])
    user = await make_user(db, "ops@acme.io", role)
    user.tenant_id = acme.id
    await db.commit()

    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/device-placements/index", headers=_auth(user))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert {i["device_id"] for i in items} == {"cam-1", "cam-2", "door-1"}
    # Both halves of the join the map does: type (count cameras) and site.
    by_id = {i["device_id"]: i for i in items}
    assert by_id["door-1"]["device_type"] == "door"
    assert by_id["cam-2"]["site_id"] == "site-1"
    # The floor-plan coordinates mean nothing on a geographic map.
    assert "floor_position" not in by_id["cam-1"]


async def test_index_is_not_shadowed_by_the_device_id_route(app, db):
    """`/{device_id}` is declared in the same router; if it wins, this route 404s
    as a missing placement — which reads on screen as an empty estate."""
    role = await make_role(db, "Ops2", ["devices.read"])
    user = await make_user(db, "ops2@x.io", role)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/device-placements/index", headers=_auth(user))
    assert r.status_code == 200
    assert r.json() == {"items": [], "count": 0}


async def test_another_tenants_placements_are_not_in_the_index(app, db):
    acme = await _tenant(db, "index-acme2")
    other = await _tenant(db, "index-other")
    db.add_all([
        _placement(device_id="mine", tenant_id=acme.id),
        _placement(device_id="theirs", tenant_id=other.id),
    ])
    await db.commit()

    role = await make_role(db, "Ops3", ["devices.read"])
    user = await make_user(db, "ops3@acme.io", role)
    user.tenant_id = acme.id
    await db.commit()

    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/device-placements/index", headers=_auth(user))
    assert [i["device_id"] for i in r.json()["items"]] == ["mine"]


async def test_the_index_needs_devices_read(app, db):
    role = await make_role(db, "NoDevices", ["sites.read"])
    user = await make_user(db, "nope@x.io", role)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/device-placements/index", headers=_auth(user))
    assert r.status_code == 403
