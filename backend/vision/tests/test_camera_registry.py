"""THE CAMERA REGISTRY — who may see a camera, and what the estate is told.

`CameraService` is the VMS's aggregation of the estate: which cameras exist, what
they are called, which site and recorder they belong to. It touches no device
(the recorder owns that), so everything left is tenancy, site scope, and the
lifecycle events the rest of the platform builds its own state from.

Three failures live here and none of them raises:

* **Site scope.** A token carrying `site_ids` confines its holder to those sites.
  The confinement is applied in TWO places — `_row` for a single camera and
  `list_` for a page — and a caller who slips past either one reads a building
  they have no access to. Nothing in the response says which site a row came
  from, so it looks exactly like a correct answer.

* **NOT_FOUND, never FORBIDDEN.** A camera outside the caller's scope has to be
  indistinguishable from one that does not exist. A 403 confirms the id is real,
  which is itself information about the estate next door.

* **The lifecycle events.** `device.camera.registered` / `.updated` /
  `.deregistered` are what core, Sites and the Events Map keep their own copies
  in step with. A missing emit leaves a camera on the map forever, or a new one
  invisible to it, with nothing failing anywhere.

The bus is stubbed — a published event is recorded, not sent — and the store is
in-memory SQLite (the same discipline as `test_camera_acl.py` and
`test_camera_node_assign.py`). No recorder, no NATS, no device.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.db import Base
from app.vms.cameras import service as cameras_service
from app.vms.cameras.schemas import CameraCreate, CameraUpdate
from app.vms.cameras.service import CameraService
from app.vms.common.crypto import decrypt_secret
from app.vms.models import Camera, CameraGroup

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
SITE_1, SITE_2 = str(uuid.uuid4()), str(uuid.uuid4())


class _Actor:
    user_id = uuid.uuid4()


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


@pytest.fixture
def bus(monkeypatch):
    """Record what the estate is told, instead of publishing it.

    Recording rather than silencing: the assertions here are about which events
    were emitted and what was in them, and a no-op stub could not tell a missing
    emit from a present one.
    """
    events: list[tuple] = []

    async def lifecycle(tenant_id, event, payload):
        events.append(("lifecycle", tenant_id, event, payload))
        return "id"

    async def status(tenant_id, payload):
        events.append(("status", tenant_id, None, payload))
        return "id"

    monkeypatch.setattr(cameras_service, "emit_camera_lifecycle", lifecycle)
    monkeypatch.setattr(cameras_service, "emit_camera_status", status)
    return events


def svc(db, *, tenant=TENANT_A, site_ids=None, superadmin=False) -> CameraService:
    return CameraService(
        db, Scope(tenant_id=tenant, is_superadmin=superadmin), site_ids=site_ids
    )


def body(name: str, **over) -> CameraCreate:
    return CameraCreate.model_validate({"name": name, **over})


async def mk(db, *, tenant=TENANT_A, name="cam", site_id=None, order=0, **over) -> Camera:
    """A camera row inserted directly — the create path has its own tests."""
    fields = {"is_enabled": True, "status": "online", **over}
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name, site_id=site_id,
        display_order=order, **fields,
    )
    db.add(cam)
    await db.commit()
    await db.refresh(cam)
    return cam


# ── create ───────────────────────────────────────────────────────────────────


class TestCreate:
    async def test_a_new_camera_is_stamped_with_the_callers_tenant(self, db, bus):
        """Not with a tenant from the payload. There is no field for one — and a
        row landing under the wrong tenant is visible to the wrong estate."""
        pub = await svc(db).create(body("Lobby"), actor=_Actor())
        row = await db.get(Camera, pub.id)
        assert row.tenant_id == TENANT_A

    async def test_a_duplicate_name_within_the_tenant_is_refused(self, db, bus):
        """Operators identify a camera by its name on every screen. Two "Lobby"s
        make every one of those screens ambiguous."""
        await svc(db).create(body("Lobby"), actor=_Actor())
        s, again, actor = svc(db), body("Lobby"), _Actor()
        with pytest.raises(ConflictError):
            await s.create(again, actor=actor)

    async def test_the_same_name_in_another_tenant_is_not_a_duplicate(self, db, bus):
        """The uniqueness check has to be tenant-SCOPED. Global, one customer
        naming a camera "Lobby" stops every other customer from doing so — and
        leaks that the name is taken."""
        await svc(db).create(body("Lobby"), actor=_Actor())
        pub = await svc(db, tenant=TENANT_B).create(body("Lobby"), actor=_Actor())
        assert pub.name == "Lobby"

    async def test_an_onvif_password_is_stored_encrypted_and_never_in_the_clear(self, db, bus):
        """This is a camera credential in a database the console reads. Stored
        plain, it is readable by anything that can SELECT the row."""
        pub = await svc(db).create(
            body("Lobby", onvif={"host": "10.0.0.5", "user": "admin", "password": "s3cret"}),
            actor=_Actor(),
        )
        row = await db.get(Camera, pub.id)
        assert row.onvif_enc_pass, "no secret was stored at all"
        assert "s3cret" not in row.onvif_enc_pass
        assert decrypt_secret(row.onvif_enc_pass) == "s3cret"

    async def test_an_onvif_block_with_no_password_stores_no_secret(self, db, bus):
        """Encrypting the empty string would leave a credential-shaped value that
        decrypts to nothing, and every later check for "has a password" would say
        yes."""
        pub = await svc(db).create(
            body("Lobby", onvif={"host": "10.0.0.5", "user": "admin"}), actor=_Actor()
        )
        row = await db.get(Camera, pub.id)
        assert row.onvif_enc_pass is None
        assert row.onvif_host == "10.0.0.5"

    async def test_a_new_camera_starts_connecting_rather_than_online(self, db, bus):
        """Nothing has heard from it yet. Starting at `online` would show a green
        tile for a camera that may never come up."""
        pub = await svc(db).create(body("Lobby"), actor=_Actor())
        assert pub.status == "connecting"

    async def test_operator_supplied_media_profiles_are_persisted_with_the_camera(self, db, bus):
        """There is no probe on create — the recorder owns the device — so an
        explicitly supplied profile is the ONLY stream information the VMS has."""
        pub = await svc(db).create(
            body("Lobby", media_profiles=[{"name": "main", "codec": "H264",
                                           "rtsp_path": "/Streaming/101"}]),
            actor=_Actor(),
        )
        assert [p.name for p in pub.media_profiles] == ["main"]

    async def test_the_estate_is_told_the_camera_was_registered_and_what_its_status_is(
        self, db, bus
    ):
        """Two events, and they carry different things. Core and Sites place the
        camera from the lifecycle payload; the realtime console colours the tile
        from the status one. Emitting only one leaves half the platform blind."""
        pub = await svc(db).create(body("Lobby", placement={"site_id": SITE_1}), actor=_Actor())
        kinds = [(e[0], e[2]) for e in bus]
        assert ("lifecycle", "registered") in kinds
        assert ("status", None) in kinds
        payload = next(e[3] for e in bus if e[0] == "lifecycle")
        assert payload["camera_id"] == pub.id
        assert payload["site_id"] == SITE_1
        assert payload["name"] == "Lobby"


# ── reading one camera ───────────────────────────────────────────────────────


class TestSingleCameraAccess:
    async def test_another_tenants_camera_is_not_found(self, db, bus):
        cam = await mk(db, tenant=TENANT_B)
        s = svc(db)
        with pytest.raises(NotFoundError):
            await s.get(cam.id)

    async def test_a_camera_outside_the_callers_sites_is_not_found_rather_than_forbidden(
        self, db, bus
    ):
        """FORBIDDEN would confirm the camera exists, which is information about
        a site this caller has no access to."""
        cam = await mk(db, site_id=SITE_2)
        s = svc(db, site_ids=[SITE_1])
        with pytest.raises(NotFoundError):
            await s.get(cam.id)

    async def test_a_camera_inside_the_callers_sites_is_readable(self, db, bus):
        """The negative case. A scope check that refused everything would be
        perfectly secure and completely useless."""
        cam = await mk(db, site_id=SITE_1)
        assert (await svc(db, site_ids=[SITE_1]).get(cam.id)).id == cam.id

    async def test_a_camera_with_no_site_is_outside_every_restricted_scope(self, db, bus):
        """An unplaced camera belongs to no site, so it cannot be inside one. The
        alternative — treating "no site" as "every site" — hands every
        site-scoped operator every camera nobody has placed yet."""
        cam = await mk(db, site_id=None)
        s = svc(db, site_ids=[SITE_1])
        with pytest.raises(NotFoundError):
            await s.get(cam.id)
        # …and an UNRESTRICTED caller still sees it.
        assert (await svc(db).get(cam.id)).id == cam.id


# ── listing ──────────────────────────────────────────────────────────────────


class TestList:
    async def test_a_listing_shows_only_the_callers_own_tenant(self, db, bus):
        await mk(db, name="mine")
        await mk(db, tenant=TENANT_B, name="theirs")
        out = await svc(db).list_()
        assert [c.name for c in out.items] == ["mine"]
        assert out.total == 1

    async def test_a_site_scoped_caller_sees_only_their_sites_cameras(self, db, bus):
        """The second place the confinement is applied. Enforced on `_row` alone,
        a site-scoped operator is refused a camera they can nonetheless see the
        whole record of in the list."""
        await mk(db, name="theirs", site_id=SITE_2)
        await mk(db, name="ours", site_id=SITE_1)
        out = await svc(db, site_ids=[SITE_1]).list_()
        assert [c.name for c in out.items] == ["ours"]

    async def test_the_total_counts_what_the_filters_matched_not_the_whole_table(self, db, bus):
        """The total drives the pager. Counted unfiltered, page two of a filtered
        list is empty and the operator concludes rows are missing."""
        await mk(db, name="on", status="online")
        await mk(db, name="off", status="offline")
        out = await svc(db).list_(status="offline")
        assert [c.name for c in out.items] == ["off"]
        assert out.total == 1

    async def test_the_search_term_matches_the_name_or_the_onvif_host(self, db, bus):
        """An operator hunting a camera has one of the two to hand — the label on
        the wall or the address in the commissioning sheet."""
        await mk(db, name="Loading Bay", onvif_host="10.0.0.9")
        await mk(db, name="Lobby", onvif_host="10.0.0.5")
        by_name = await svc(db).list_(q="Lobb")
        by_host = await svc(db).list_(q="0.0.9")
        assert [c.name for c in by_name.items] == ["Lobby"]
        assert [c.name for c in by_host.items] == ["Loading Bay"]

    async def test_a_group_filter_narrows_to_the_groups_own_members(self, db, bus):
        one = await mk(db, name="one")
        await mk(db, name="two")
        grp = CameraGroup(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="g",
                          camera_ids=[one.id])
        db.add(grp)
        await db.commit()
        out = await svc(db).list_(group_id=grp.id)
        assert [c.name for c in out.items] == ["one"]

    async def test_an_empty_group_lists_nothing_rather_than_everything(self, db, bus):
        """An `IN ()` that collapses to no predicate returns the whole estate —
        the opposite of what an empty group means, and it looks like a working
        filter."""
        grp = CameraGroup(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="g", camera_ids=[])
        db.add(grp)
        await mk(db, name="one")
        await db.commit()
        out = await svc(db).list_(group_id=grp.id)
        assert out.items == []

    async def test_another_tenants_group_is_not_found(self, db, bus):
        grp = CameraGroup(id=str(uuid.uuid4()), tenant_id=TENANT_B, name="g", camera_ids=[])
        db.add(grp)
        await db.commit()
        s = svc(db)
        with pytest.raises(NotFoundError):
            await s.list_(group_id=grp.id)

    async def test_cameras_come_back_in_the_operators_own_order(self, db, bus):
        """`display_order` is a wall layout somebody arranged deliberately. A
        listing that ignored it would reshuffle the video wall."""
        await mk(db, name="third", order=3)
        await mk(db, name="first", order=1)
        await mk(db, name="second", order=2)
        out = await svc(db).list_()
        assert [c.name for c in out.items] == ["first", "second", "third"]

    async def test_a_page_carries_the_skip_and_limit_it_was_asked_for(self, db, bus):
        for i in range(5):
            await mk(db, name=f"c{i}", order=i)
        out = await svc(db).list_(skip=2, limit=2)
        assert [c.name for c in out.items] == ["c2", "c3"]
        assert (out.skip, out.limit, out.total) == (2, 2, 5)


# ── update ───────────────────────────────────────────────────────────────────


class TestUpdate:
    async def test_only_the_fields_the_payload_carried_are_changed(self, db, bus):
        """A PATCH is partial. Applying the model's defaults for absent fields
        would silently reset everything the caller did not mention."""
        cam = await mk(db, name="Lobby", brand="hikvision")
        pub = await svc(db).update(cam.id, CameraUpdate(name="Lobby North"), actor=_Actor())
        assert pub.name == "Lobby North"
        assert pub.brand == "hikvision"

    async def test_an_onvif_edit_that_omits_the_password_leaves_the_stored_one_alone(
        self, db, bus
    ):
        """An operator correcting a port must not blank the credential. Without
        this, every partial ONVIF edit silently breaks the connection."""
        cam = await mk(db)
        await svc(db).update(
            cam.id,
            CameraUpdate(onvif={"host": "10.0.0.5", "user": "admin", "password": "s3cret"}),
            actor=_Actor(),
        )
        await svc(db).update(cam.id, CameraUpdate(onvif={"port": 8899}), actor=_Actor())
        row = await db.get(Camera, cam.id)
        assert row.onvif_port == 8899
        assert decrypt_secret(row.onvif_enc_pass) == "s3cret"

    async def test_an_explicitly_empty_password_clears_the_stored_one(self, db, bus):
        """The one way to remove a credential. Treated as "absent" it could never
        be taken back."""
        cam = await mk(db)
        await svc(db).update(
            cam.id, CameraUpdate(onvif={"password": "s3cret"}), actor=_Actor()
        )
        await svc(db).update(cam.id, CameraUpdate(onvif={"password": ""}), actor=_Actor())
        assert (await db.get(Camera, cam.id)).onvif_enc_pass is None

    async def test_an_update_announces_the_change_to_the_estate(self, db, bus):
        """Sites and the Events Map hold their own copy of a camera's placement.
        No event, and a camera renamed or moved here stays where it was there."""
        cam = await mk(db, name="Lobby")
        bus.clear()
        await svc(db).update(cam.id, CameraUpdate(name="Lobby North"), actor=_Actor())
        updated = [e for e in bus if e[0] == "lifecycle" and e[2] == "updated"]
        assert len(updated) == 1
        assert updated[0][3]["name"] == "Lobby North"

    async def test_a_status_that_did_not_change_does_not_raise_a_status_event(self, db, bus):
        """The realtime stream is per-tenant and shared. An edit to a name
        emitting a status change is a wakeup for every console watching."""
        cam = await mk(db, name="Lobby")
        bus.clear()
        await svc(db).update(cam.id, CameraUpdate(name="Lobby North"), actor=_Actor())
        assert [e for e in bus if e[0] == "status"] == []

    async def test_another_tenants_camera_cannot_be_updated(self, db, bus):
        cam = await mk(db, tenant=TENANT_B)
        s, patch, actor = svc(db), CameraUpdate(name="x"), _Actor()
        with pytest.raises(NotFoundError):
            await s.update(cam.id, patch, actor=actor)


# ── delete ───────────────────────────────────────────────────────────────────


class TestDelete:
    async def test_a_deleted_camera_is_announced_with_the_row_it_used_to_be(self, db, bus):
        """The payload has to be built BEFORE the delete. Read after, the row is
        gone and the event carries nulls — so the map has nothing to match on and
        the camera stays on it forever."""
        cam = await mk(db, name="Lobby", site_id=SITE_1)
        bus.clear()
        await svc(db).delete(cam.id, actor=_Actor())
        (_, tenant, event, payload) = bus[0]
        assert event == "deregistered"
        assert tenant == TENANT_A
        assert payload["camera_id"] == cam.id
        assert payload["name"] == "Lobby"
        assert payload["site_id"] == SITE_1
        assert await db.get(Camera, cam.id) is None

    async def test_another_tenants_camera_cannot_be_deleted(self, db, bus):
        cam = await mk(db, tenant=TENANT_B)
        s, actor = svc(db), _Actor()
        with pytest.raises(NotFoundError):
            await s.delete(cam.id, actor=actor)
        assert await db.get(Camera, cam.id) is not None


# ── bulk ─────────────────────────────────────────────────────────────────────


def _bulk(s, ids, action, **kw):
    args = {"group_id": None, "retention_days": None, "media_node_id": None, "actor": _Actor()}
    args.update(kw)
    return s.bulk(ids, action, **args)


class TestBulk:
    async def test_a_bulk_action_touches_only_rows_the_caller_owns(self, db, bus):
        """The id list comes from the client. Applied without the tenant filter,
        one customer could disable another's cameras by guessing ids."""
        mine = await mk(db, name="mine")
        theirs = await mk(db, tenant=TENANT_B, name="theirs")
        out = await _bulk(svc(db), [mine.id, theirs.id], "disable")
        assert out["affected"] == 1
        assert (await db.get(Camera, mine.id)).is_enabled is False
        assert (await db.get(Camera, theirs.id)).is_enabled is True

    async def test_enable_and_disable_move_the_flag_both_ways(self, db, bus):
        cam = await mk(db)
        await _bulk(svc(db), [cam.id], "disable")
        assert (await db.get(Camera, cam.id)).is_enabled is False
        await _bulk(svc(db), [cam.id], "enable")
        assert (await db.get(Camera, cam.id)).is_enabled is True

    async def test_a_retention_change_with_no_value_is_refused_rather_than_applied_as_null(
        self, db, bus
    ):
        """A null retention is not "keep forever" to the recorder — it is a
        missing setting, and the footage policy for those cameras becomes
        whatever the default is. The operator asked for a number."""
        cam = await mk(db, retention_days=30)
        s = svc(db)
        with pytest.raises(ValidationError, match="retention_days"):
            await _bulk(s, [cam.id], "retention")
        assert (await db.get(Camera, cam.id)).retention_days == 30

    async def test_a_retention_change_with_a_value_is_applied(self, db, bus):
        cam = await mk(db, retention_days=30)
        await _bulk(svc(db), [cam.id], "retention", retention_days=90)
        assert (await db.get(Camera, cam.id)).retention_days == 90

    async def test_a_bulk_delete_announces_every_camera_it_removed(self, db, bus):
        """One event per camera. A single summary event would leave the map
        unable to say which tiles to drop."""
        a = await mk(db, name="a")
        b = await mk(db, name="b")
        bus.clear()
        out = await _bulk(svc(db), [a.id, b.id], "delete")
        assert out["affected"] == 2
        names = sorted(e[3]["name"] for e in bus if e[2] == "deregistered")
        assert names == ["a", "b"]
        assert await db.get(Camera, a.id) is None

    async def test_adding_to_a_group_keeps_the_members_it_already_had(self, db, bus):
        """A bulk "add to group" that replaced the membership would silently
        remove every camera already in it."""
        existing = await mk(db, name="existing")
        added = await mk(db, name="added")
        grp = CameraGroup(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="g",
                          camera_ids=[existing.id])
        db.add(grp)
        await db.commit()
        await _bulk(svc(db), [added.id], "group", group_id=grp.id)
        await db.refresh(grp)
        assert sorted(grp.camera_ids) == sorted([existing.id, added.id])

    async def test_a_camera_already_in_the_group_is_not_added_twice(self, db, bus):
        """A duplicated id makes the group's own count wrong on every screen
        that reads it."""
        cam = await mk(db)
        grp = CameraGroup(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="g",
                          camera_ids=[cam.id])
        db.add(grp)
        await db.commit()
        await _bulk(svc(db), [cam.id], "group", group_id=grp.id)
        await db.refresh(grp)
        assert grp.camera_ids == [cam.id]

    async def test_a_group_action_with_no_group_is_refused(self, db, bus):
        cam = await mk(db)
        s = svc(db)
        with pytest.raises(ValidationError, match="group_id"):
            await _bulk(s, [cam.id], "group")


# ── reorder ──────────────────────────────────────────────────────────────────


class _Item:
    def __init__(self, id_, order):
        self.id = id_
        self.display_order = order


class TestReorder:
    async def test_the_order_is_applied_and_the_count_is_what_was_applied(self, db, bus):
        a = await mk(db, name="a", order=1)
        b = await mk(db, name="b", order=2)
        out = await svc(db).reorder([_Item(a.id, 2), _Item(b.id, 1)])
        assert out["reordered"] == 2
        assert (await db.get(Camera, a.id)).display_order == 2

    async def test_an_id_the_caller_does_not_own_is_skipped_and_not_counted(self, db, bus):
        """The count is what the console prints back. Counting rows it did not
        write would report a reorder that did not happen — and silently writing
        them would let one tenant rearrange another's video wall."""
        mine = await mk(db, name="mine", order=1)
        theirs = await mk(db, tenant=TENANT_B, name="theirs", order=1)
        out = await svc(db).reorder([_Item(mine.id, 5), _Item(theirs.id, 5)])
        assert out["reordered"] == 1
        assert (await db.get(Camera, theirs.id)).display_order == 1
