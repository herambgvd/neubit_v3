"""A device has ONE location: the floor plan may not take it off another one
without saying so (SCRUM-309).

The floor-plan editor's `POST /device-placements/register` used to upsert by
device id. A camera pinned on Tower A, dropped on Tower B's drawing, silently left
Tower A — the operator who placed it there never found out. Industry practice is
one location per device (Milestone's smart map keeps one position; even its
multi-level cameras stay inside one building), so a move is a decision, and the
API now asks for it: 409 PLACEMENT_ELSEWHERE naming where the device is, unless
the request carries `move: true`.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.core.audit import AuditLog
from app.sites.device.models import DevicePlacement
from app.sites.floor.models import Floor
from app.sites.site.models import Site
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role, make_user

pytestmark = pytest.mark.asyncio

PREFIX = "/api/v1"
PIN = {"x": 10.0, "y": 20.0, "rotation": 0.0}


async def _estate(db, slug: str):
    """Two towers; Tower A has two floors, Tower B one. Returns an operator."""
    t = Tenant(name=slug, slug=slug, status="active", features={}, limits={})
    db.add(t)
    await db.commit()
    await db.refresh(t)
    for site_id, name in (("site-a", "Tower A"), ("site-b", "Tower B")):
        db.add(Site(site_id=site_id, tenant_id=t.id, name=name,
                    site_type="building", is_active=True))
    for floor_id, site_id, name in (
        ("a-1", "site-a", "Level 1"),
        ("a-2", "site-a", "Level 2"),
        ("b-1", "site-b", "Ground"),
    ):
        db.add(Floor(floor_id=floor_id, tenant_id=t.id, site_id=site_id,
                     name=name, is_active=True))
    await db.commit()
    role = await make_role(db, f"Role-{slug}", ["devices.create", "devices.read"])
    user = await make_user(db, f"{slug}@x.io", role)
    user.tenant_id = t.id
    await db.commit()
    await db.refresh(user, attribute_names=["role"])
    return user


def _cam(site_id: str, floor_id: str | None, **extra) -> dict:
    body = {"device_id": "cam-177", "device_type": "camera", "service": "vms",
            "site_id": site_id, "floor_id": floor_id}
    if floor_id:
        body["floor_position"] = PIN
    return {**body, **extra}


async def _register(c, user, body):
    return await c.post(f"{PREFIX}/device-placements/register", json=body,
                        headers=bearer(user))


async def _row(db) -> DevicePlacement:
    db.expire_all()
    return (await db.execute(
        select(DevicePlacement).where(DevicePlacement.device_id == "cam-177")
    )).scalars().one()


async def test_dropping_it_on_another_sites_floor_is_refused_naming_where_it_is(app, db):
    user = await _estate(db, "one-loc-site")
    async with api_client(app) as c:
        assert (await _register(c, user, _cam("site-a", "a-1"))).status_code == 201
        r = await _register(c, user, _cam("site-b", "b-1"))

    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "PLACEMENT_ELSEWHERE"
    assert err["details"]["site_name"] == "Tower A"
    assert err["details"]["floor_name"] == "Level 1"
    assert "Tower A › Level 1" in err["message"]
    # Refused means NOTHING moved.
    row = await _row(db)
    assert (row.site_id, row.floor_id) == ("site-a", "a-1")


async def test_another_floor_of_the_same_site_is_a_move_too(app, db):
    user = await _estate(db, "one-loc-floor")
    async with api_client(app) as c:
        await _register(c, user, _cam("site-a", "a-1"))
        r = await _register(c, user, _cam("site-a", "a-2"))
    assert r.status_code == 409, r.text
    assert r.json()["error"]["details"]["floor_id"] == "a-1"


async def test_a_confirmed_move_moves_it_and_the_audit_row_says_from_where(app, db):
    user = await _estate(db, "one-loc-move")
    async with api_client(app) as c:
        await _register(c, user, _cam("site-a", "a-1"))
        r = await _register(c, user, _cam("site-b", "b-1", move=True))
    assert r.status_code == 201, r.text
    row = await _row(db)
    assert (row.site_id, row.floor_id) == ("site-b", "b-1")

    audit = (await db.execute(
        select(AuditLog).where(AuditLog.action == "device_placement.placement_updated")
    )).scalars().all()
    moved = [a for a in audit if (a.meta or {}).get("moved_from")]
    assert moved, "a confirmed move must record where the device came from"
    assert moved[-1].meta["moved_from"]["site_name"] == "Tower A"


async def test_re_pinning_on_the_same_floor_is_not_a_move(app, db):
    user = await _estate(db, "one-loc-repin")
    async with api_client(app) as c:
        await _register(c, user, _cam("site-a", "a-1"))
        r = await _register(c, user, {**_cam("site-a", "a-1"),
                                      "floor_position": {"x": 50, "y": 60, "rotation": 90}})
    assert r.status_code == 201, r.text
    assert r.json()["floor_position"]["x"] == 50


async def test_pinning_a_site_only_device_on_a_floor_of_that_site_is_not_a_move(app, db):
    """The device-first surface said "it is in Tower A"; the floor plan now says
    where in Tower A. That refines the fact — nothing is taken off anywhere."""
    user = await _estate(db, "one-loc-refine")
    async with api_client(app) as c:
        await _register(c, user, _cam("site-a", None))
        r = await _register(c, user, _cam("site-a", "a-2"))
    assert r.status_code == 201, r.text
    assert (await _row(db)).floor_id == "a-2"


async def test_a_site_only_device_of_another_site_is_still_a_move(app, db):
    user = await _estate(db, "one-loc-siteonly")
    async with api_client(app) as c:
        await _register(c, user, _cam("site-a", None))
        r = await _register(c, user, _cam("site-b", "b-1"))
    assert r.status_code == 409, r.text
    details = r.json()["error"]["details"]
    assert details["floor_id"] is None
    assert "Tower A" in r.json()["error"]["message"]


async def test_the_estate_index_names_the_site_and_floor(app, db):
    """The editor lists a device placed elsewhere as "Tower A › Level 1"; the
    names come with the index so it does not need a floors call per site."""
    user = await _estate(db, "one-loc-index")
    async with api_client(app) as c:
        await _register(c, user, _cam("site-a", "a-1"))
        r = await c.get(f"{PREFIX}/device-placements/index", headers=bearer(user))
    assert r.status_code == 200, r.text
    (row,) = r.json()["items"]
    assert row["site_name"] == "Tower A"
    assert row["floor_name"] == "Level 1"
