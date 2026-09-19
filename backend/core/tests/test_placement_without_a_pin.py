"""A device may belong to a BUILDING without being pinned to a floor plan.

WHY THIS FILE EXISTS. `device_placements` required `floor_id` AND
`floor_position`, so a placement and a PIN were the same row: nothing could be
recorded as being in a building until somebody had drawn that building's floor
plan and dragged the device onto it at `{x, y, rotation}`. Building Intelligence
asks for the BUILDING — EPI is kWh per square metre of one — and the drawing
answers a rarer question. With one site and almost no floor plans, that made
nearly the whole estate unplaceable, and `points.site_id` is derived from these
rows, so the requirement for a drawing reached all the way to the top of the
pipeline.

Migration 0031 splits the two. What is asserted here is that it splits them
WITHOUT loosening anything:

  * a placement may name a site alone;
  * a floor with no position is refused BY THE DATABASE, not only by pydantic —
    a pin at no coordinates is not a partially-filled pin, and the API is one
    writer among several a database sees over its life;
  * a `zone_id` still needs a floor, because `zones.floor_id` is NOT NULL;
  * the floor-plan editor's own contract is byte-for-byte what it was;
  * `assign` — the device-first surface — never erases a pin it was not told
    about, and always erases one that has become false.

The SQL-NULL test is not decoration. SQLAlchemy's JSON type persists a python
`None` as the JSON scalar `null` by default, which satisfies no `IS NULL` and
would fail the check constraint in Postgres while passing every assertion made
against the ORM object.
"""


import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.sites.device.models import DevicePlacement
from app.sites.floor.models import Floor
from app.sites.site.models import Site
from app.sites.zone.models import Zone
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role, make_user

pytestmark = pytest.mark.asyncio

PREFIX = "/api/v1"
PIN = {"x": 10.0, "y": 20.0, "rotation": 0.0}


async def _tenant(db, slug: str) -> Tenant:
    t = Tenant(name=slug, slug=slug, status="active", features={}, limits={})
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


async def _estate(db, tenant, *, site_id="site-1", floor_id="floor-1", zone_id=None):
    """A site, a floor on it, and optionally a zone — the rows a placement names."""
    db.add(Site(site_id=site_id, tenant_id=tenant.id, name=f"Tower {site_id}",
                site_type="building", is_active=True))
    db.add(Floor(floor_id=floor_id, tenant_id=tenant.id, site_id=site_id,
                 name=f"Level {floor_id}", is_active=True))
    if zone_id:
        db.add(Zone(zone_id=zone_id, tenant_id=tenant.id, site_id=site_id,
                    floor_id=floor_id, name=f"Zone {zone_id}", is_active=True))
    await db.commit()


async def _operator(db, tenant, email, perms=("devices.create", "devices.read")):
    role = await make_role(db, f"Role-{email}", list(perms))
    user = await make_user(db, email, role)
    user.tenant_id = tenant.id
    await db.commit()
    await db.refresh(user, attribute_names=["role"])
    return user


# ── the site, without the drawing ────────────────────────────────────────────


async def test_a_placement_may_name_a_site_and_no_floor(app, db):
    """The whole point. A meter belongs to Aeon Tower whether or not anyone has
    drawn Aeon Tower."""
    t = await _tenant(db, "pin-a")
    await _estate(db, t)
    user = await _operator(db, t, "a@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "meter-1", "device_type": "sensor", "service": "iot",
                  "site_id": "site-1"},
            headers=bearer(user),
        )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["site_id"] == "site-1"
    assert body["floor_id"] is None
    assert body["floor_position"] is None


async def test_a_site_only_placement_is_stored_as_a_SQL_NULL(app, db):
    """Not the JSON scalar `null`, which is what SQLAlchemy's JSON type stores for
    a python None unless told otherwise — and which satisfies no `IS NULL`, so the
    check constraint would reject the row in Postgres."""
    t = await _tenant(db, "pin-null")
    await _estate(db, t)
    user = await _operator(db, t, "null@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "meter-null", "device_type": "sensor",
                  "service": "iot", "site_id": "site-1"},
            headers=bearer(user),
        )
    assert r.status_code == 201, r.text
    nulls = (await db.execute(text(
        "SELECT count(*) FROM device_placements "
        "WHERE device_id = 'meter-null' AND floor_position IS NULL"
    ))).scalar()
    assert nulls == 1


async def test_a_site_that_does_not_exist_is_refused(app, db):
    """With no floor to prove the site, the site itself is what is checked. A
    placement naming a site nobody created would publish a site name of None to a
    read-model that may not look one up."""
    t = await _tenant(db, "pin-nosite")
    await _estate(db, t)
    user = await _operator(db, t, "nosite@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "meter-x", "device_type": "sensor", "service": "iot",
                  "site_id": "no-such-site"},
            headers=bearer(user),
        )
    assert r.status_code == 404, r.text


async def test_another_tenants_site_cannot_be_named(app, db):
    t = await _tenant(db, "pin-mine")
    other = await _tenant(db, "pin-theirs")
    await _estate(db, other, site_id="their-site", floor_id="their-floor")
    user = await _operator(db, t, "mine@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "meter-2", "device_type": "sensor", "service": "iot",
                  "site_id": "their-site"},
            headers=bearer(user),
        )
    assert r.status_code == 404, r.text


# ── the meaningless shapes, refused twice ────────────────────────────────────
#
# A floor with no position USED to be refused here too. It no longer is: "this
# meter is on Level 4" is a true floor-wise statement, and demanding coordinates
# for it made an operator invent a pin or stay silent. What is still refused is
# what no reader could use — coordinates, or a zone, with no storey under them.


@pytest.mark.parametrize(
    "body, why",
    [
        ({"floor_position": PIN}, "a position with no floor is a position on nothing"),
        ({"zone_id": "zone-1"}, "a zone with no floor is a room in no storey"),
    ],
)
async def test_the_api_refuses_a_half_pin(app, db, body, why):
    t = await _tenant(db, f"pin-half-{len(body)}-{sorted(body)[0]}")
    await _estate(db, t, zone_id="zone-1")
    user = await _operator(db, t, f"half-{sorted(body)[0]}@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "meter-3", "device_type": "sensor", "service": "iot",
                  "site_id": "site-1", **body},
            headers=bearer(user),
        )
    assert r.status_code == 422, why


@pytest.mark.parametrize(
    "over",
    [
        {"floor_id": None, "floor_position": PIN},
        {"floor_id": None, "floor_position": None, "zone_id": "zone-1"},
    ],
)
async def test_the_database_refuses_a_half_pin(db, over):
    """The constraint, not the validator. `service.py` is one writer; psql, a
    migration and a future importer are others, and the invariant has to hold for
    all of them."""
    row = DevicePlacement(
        device_id="direct-1", device_type="sensor", service="iot", site_id="site-1",
        **over,
    )
    db.add(row)
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_the_database_accepts_a_floor_with_no_position(db):
    """The constraint is one-directional. If it were still `together or not at
    all`, this commit is the row it would refuse."""
    db.add(DevicePlacement(
        device_id="direct-floor", device_type="sensor", service="iot",
        site_id="site-1", floor_id="floor-1", floor_position=None,
    ))
    await db.commit()
    row = (await db.execute(text(
        "SELECT floor_id FROM device_placements WHERE device_id = 'direct-floor'"
    ))).scalar()
    assert row == "floor-1"


async def test_a_floor_only_placement_is_accepted_and_stores_a_SQL_NULL(app, db):
    """The API accepts the shape, and the position lands as SQL NULL — not the JSON
    scalar `null`, which satisfies no `IS NULL` and would make the floor-only row
    fail the very constraint that now permits it."""
    t = await _tenant(db, "pin-floor-only")
    await _estate(db, t)
    user = await _operator(db, t, "flooronly@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "meter-l4", "device_type": "sensor", "service": "iot",
                  "site_id": "site-1", "floor_id": "floor-1"},
            headers=bearer(user),
        )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["floor_id"] == "floor-1"
    assert body["floor_position"] is None
    nulls = (await db.execute(text(
        "SELECT count(*) FROM device_placements "
        "WHERE device_id = 'meter-l4' AND floor_id = 'floor-1' "
        "AND floor_position IS NULL"
    ))).scalar()
    assert nulls == 1


# ── the floor plan, unchanged ────────────────────────────────────────────────


async def test_pinning_a_device_on_a_floor_plan_still_works(app, db):
    """The editor's contract. Everything above is additive or it is a regression."""
    t = await _tenant(db, "pin-editor")
    await _estate(db, t, zone_id="zone-1")
    user = await _operator(db, t, "editor@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "cam-1", "device_type": "camera", "service": "vms",
                  "site_id": "site-1", "floor_id": "floor-1", "zone_id": "zone-1",
                  "floor_position": PIN},
            headers=bearer(user),
        )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["floor_id"] == "floor-1"
    assert body["zone_id"] == "zone-1"
    assert body["floor_position"] == PIN


async def test_a_floor_of_another_site_is_still_a_conflict(app, db):
    t = await _tenant(db, "pin-mismatch")
    await _estate(db, t)
    db.add(Site(site_id="site-2", tenant_id=t.id, name="Other", site_type="building",
                is_active=True))
    await db.commit()
    user = await _operator(db, t, "mismatch@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "cam-2", "device_type": "camera", "service": "vms",
                  "site_id": "site-2", "floor_id": "floor-1", "floor_position": PIN},
            headers=bearer(user),
        )
    assert r.status_code == 409, r.text


# ── the device-first surface ─────────────────────────────────────────────────


async def test_assign_places_named_devices_on_a_site(app, db):
    """The reverse direction: start from the devices, name the building."""
    t = await _tenant(db, "as-basic")
    await _estate(db, t)
    user = await _operator(db, t, "as1@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-1"}, {"device_id": "m-2"},
                              {"device_id": "m-3"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["assigned"] == 3
    assert body["site_name"] == "Tower site-1"
    assert all(i["created"] and i["floor_id"] is None for i in body["items"])

    rows = (await db.execute(text(
        "SELECT device_id, site_id, device_type, service FROM device_placements "
        "ORDER BY device_id"
    ))).all()
    assert [r_[0] for r_ in rows] == ["m-1", "m-2", "m-3"]
    assert {r_[1] for r_ in rows} == {"site-1"}
    assert {(r_[2], r_[3]) for r_ in rows} == {("sensor", "iot")}


async def test_assign_leaves_an_existing_pin_alone_when_the_site_is_unchanged(app, db):
    """An operator re-stating the building has said nothing about the drawing, so
    the drawing is not theirs to erase."""
    t = await _tenant(db, "as-keep")
    await _estate(db, t)
    db.add(DevicePlacement(device_id="cam-3", tenant_id=t.id, device_type="camera",
                           service="vms", site_id="site-1", floor_id="floor-1",
                           floor_position=PIN))
    await db.commit()
    user = await _operator(db, t, "keep@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1",
                  "devices": [{"device_id": "cam-3"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    item = r.json()["items"][0]
    assert item["created"] is False
    assert item["pin_cleared"] is False
    assert item["floor_id"] == "floor-1"


async def test_assign_drops_a_pin_that_moving_site_has_made_false(app, db):
    """An `{x, y}` on a floor of a building the device is no longer in is not a
    stale pin, it is a false one — and the caller is TOLD, not left to notice."""
    t = await _tenant(db, "as-move")
    await _estate(db, t)
    db.add(Site(site_id="site-2", tenant_id=t.id, name="Annexe",
                site_type="building", is_active=True))
    db.add(DevicePlacement(device_id="cam-4", tenant_id=t.id, device_type="camera",
                           service="vms", site_id="site-1", floor_id="floor-1",
                           floor_position=PIN))
    await db.commit()
    user = await _operator(db, t, "move@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-2", "devices": [{"device_id": "cam-4"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    item = r.json()["items"][0]
    assert item["pin_cleared"] is True
    assert item["floor_id"] is None
    assert item["site_id"] == "site-2"


async def test_assign_can_carry_a_pin_per_device(app, db):
    """`floor_position` is per ITEM and never per request: one coordinate shared
    by a list would stack every device on the same spot of the same drawing."""
    t = await _tenant(db, "as-pin")
    await _estate(db, t)
    user = await _operator(db, t, "aspin@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "camera", "service": "vms",
                  "devices": [
                      {"device_id": "cam-5", "floor_id": "floor-1",
                       "floor_position": PIN},
                      {"device_id": "cam-6"},
                  ]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    by_id = {i["device_id"]: i for i in r.json()["items"]}
    assert by_id["cam-5"]["floor_id"] == "floor-1"
    assert by_id["cam-6"]["floor_id"] is None


async def test_assign_refuses_the_same_device_twice(app, db):
    """Two entries for one device are two statements about it, and the last one
    winning silently is how an operator gets a placement they did not choose."""
    t = await _tenant(db, "as-dupe")
    await _estate(db, t)
    user = await _operator(db, t, "dupe@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-9"}, {"device_id": "m-9"}]},
            headers=bearer(user),
        )
    assert r.status_code == 422, r.text


async def test_assign_refuses_a_new_device_with_no_kind(app, db):
    """`device_type` and `service` are columns on the row and are not derivable
    from an id, a tag or the other items in the list."""
    t = await _tenant(db, "as-kind")
    await _estate(db, t)
    user = await _operator(db, t, "kind@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1",
                  "devices": [
                      {"device_id": "m-10", "device_type": "sensor",
                       "service": "iot"},
                      # Second in the list, and nothing before it may be written.
                      {"device_id": "m-11"},
                  ]},
            headers=bearer(user),
        )
    assert r.status_code == 409, r.text
    assert (await db.execute(text(
        "SELECT count(*) FROM device_placements"
    ))).scalar() == 0


async def test_assign_refuses_a_position_with_no_floor_on_an_item(app, db):
    t = await _tenant(db, "as-half")
    await _estate(db, t)
    user = await _operator(db, t, "ashalf@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-11", "floor_position": PIN}]},
            headers=bearer(user),
        )
    assert r.status_code == 422, r.text


async def test_assign_can_put_a_device_on_a_floor_without_pinning_it(app, db):
    """The bulk path an operator actually uses: 'these meters are on Level 4',
    with no drawing in hand."""
    t = await _tenant(db, "as-floor")
    await _estate(db, t)
    user = await _operator(db, t, "asfloor@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-12", "floor_id": "floor-1"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    item = r.json()["items"][0]
    assert item["floor_id"] == "floor-1"


async def test_assign_validates_every_floor_before_it_writes_anything(app, db):
    """A bulk action that half-applies leaves the operator with no way to know
    which half, and re-running it is not a repair if the first half moved a pin."""
    t = await _tenant(db, "as-atomic")
    await _estate(db, t)
    db.add(Site(site_id="site-2", tenant_id=t.id, name="Annexe",
                site_type="building", is_active=True))
    await db.commit()
    user = await _operator(db, t, "atomic@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-2", "device_type": "sensor", "service": "iot",
                  "devices": [
                      {"device_id": "ok-1"},
                      # floor-1 belongs to site-1, not site-2.
                      {"device_id": "bad-1", "floor_id": "floor-1",
                       "floor_position": PIN},
                  ]},
            headers=bearer(user),
        )
    assert r.status_code == 409, r.text
    assert (await db.execute(text(
        "SELECT count(*) FROM device_placements"
    ))).scalar() == 0


async def test_assign_never_touches_another_tenants_placement(app, db):
    """The same `device_id` in two tenants is two devices. Assigning one must
    neither move nor read the other."""
    mine = await _tenant(db, "as-mine")
    theirs = await _tenant(db, "as-theirs")
    await _estate(db, mine)
    await _estate(db, theirs, site_id="their-site", floor_id="their-floor")
    db.add(DevicePlacement(device_id="shared-id", tenant_id=theirs.id,
                           device_type="camera", service="vms",
                           site_id="their-site", floor_id="their-floor",
                           floor_position=PIN))
    await db.commit()
    user = await _operator(db, mine, "asmine@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "shared-id"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["created"] is True

    rows = (await db.execute(text(
        "SELECT tenant_id, site_id, floor_id FROM device_placements "
        "WHERE device_id = 'shared-id' ORDER BY site_id"
    ))).all()
    assert len(rows) == 2, "the other tenant's placement was overwritten, not left alone"
    assert {r_[1] for r_ in rows} == {"site-1", "their-site"}
    theirs_row = [r_ for r_ in rows if r_[1] == "their-site"][0]
    assert theirs_row[2] == "their-floor", "their pin was cleared by our assignment"


async def test_assign_needs_devices_create(app, db):
    t = await _tenant(db, "as-perm")
    await _estate(db, t)
    user = await _operator(db, t, "perm@x.io", perms=("devices.read",))

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-12"}]},
            headers=bearer(user),
        )
    assert r.status_code == 403, r.text


# ── what the read-model is told ──────────────────────────────────────────────


async def test_each_assigned_device_gets_its_own_event_naming_the_surface(
    app, db, monkeypatch
):
    """The mirror places devices ONE AT A TIME, so a batched event would make it
    guess which devices a partial failure had covered. `source` is what lands in
    `device_locations.source` — the surface the placement was typed on."""
    from app.sites.device import service as svc_mod

    seen = []

    async def _capture(tenant_id, entity, event, payload):
        seen.append((entity, event, payload))

    monkeypatch.setattr(svc_mod, "emit", _capture)

    t = await _tenant(db, "as-events")
    await _estate(db, t)
    user = await _operator(db, t, "ev@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-20"}, {"device_id": "m-21"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    assert [s[1] for s in seen] == ["placed", "placed"]
    assert {s[2]["device_id"] for s in seen} == {"m-20", "m-21"}
    for _, _, payload in seen:
        assert payload["site_id"] == "site-1"
        assert payload["site_name"] == "Tower site-1"
        assert payload["floor_id"] is None
        assert payload["floor_name"] is None
        # More than one device named in one call is the bulk surface.
        assert payload["source"] == "bulk_assignment"


async def test_a_single_device_assignment_says_so_and_a_pin_says_floor_plan(
    app, db, monkeypatch
):
    from app.sites.device import service as svc_mod

    seen = []

    async def _capture(tenant_id, entity, event, payload):
        seen.append(payload)

    monkeypatch.setattr(svc_mod, "emit", _capture)

    t = await _tenant(db, "as-source")
    await _estate(db, t)
    user = await _operator(db, t, "src@x.io")

    async with api_client(app) as c:
        await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-30"}]},
            headers=bearer(user),
        )
        await c.post(
            f"{PREFIX}/device-placements/register",
            json={"device_id": "cam-30", "device_type": "camera", "service": "vms",
                  "site_id": "site-1", "floor_id": "floor-1", "floor_position": PIN},
            headers=bearer(user),
        )
    assert [p["source"] for p in seen] == ["device_assignment", "floor_plan"]


async def test_a_bulk_assignment_is_one_audit_row_naming_every_device(app, db):
    """One operator action is one entry. A row per device would turn one decision
    into five hundred and lose the only thing worth knowing: what was selected."""
    t = await _tenant(db, "as-audit")
    await _estate(db, t)
    user = await _operator(db, t, "audit@x.io")

    async with api_client(app) as c:
        r = await c.post(
            f"{PREFIX}/device-placements/assign",
            json={"site_id": "site-1", "device_type": "sensor", "service": "iot",
                  "devices": [{"device_id": "m-40"}, {"device_id": "m-41"}]},
            headers=bearer(user),
        )
    assert r.status_code == 200, r.text
    rows = (await db.execute(text(
        "SELECT action, target_id, meta FROM audit_log "
        "WHERE action LIKE 'device_placement%'"
    ))).all()
    assert len(rows) == 1, rows
    assert rows[0][0] == "device_placement.assigned"
    assert rows[0][1] == "site-1"
    meta = rows[0][2]
    if isinstance(meta, str):
        import json as _json
        meta = _json.loads(meta)
    assert sorted(meta["device_ids"]) == ["m-40", "m-41"]
    assert meta["count"] == 2
