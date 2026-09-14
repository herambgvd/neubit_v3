"""Two writes on the camera registry whose damage is invisible from the response.

`CameraService` is aggregation, not device control (the recorder owns the camera),
so almost everything it does is a row. These two are the exceptions where a row
change reaches outside:

* **PUT /cameras/{id}/acl** replaces a camera's grants WHOLESALE, which means it
  begins by deleting. The delete is narrowed three ways — to the caller's tenant,
  to `target_type == "camera"`, and to this camera id — and every one of those
  narrowings is load-bearing: `camera_acl` also holds the GROUP grants (a single
  row covering every camera in a group), so a delete that lost its `target_type`
  filter would let a PUT on one camera silently revoke a whole group's access.
  The response is the entries the caller just sent either way. Nothing in it says
  what else was removed.

* **A recorder reassignment** sends a STOP to the recorder the camera just left.
  It must go to the OLD node — the new one has already started, or is about to,
  and a stop sent there kills the recording the move was meant to preserve.
  It is best-effort and swallowed, so a stop aimed at the wrong box logs at INFO
  and looks exactly like a stop that worked.

In-memory SQLite and a fabricated NvrClient, the same discipline as
test_camera_node_assign.py — which owns the "a re-host failure never fails the
write" half of this contract; these are the branches it does not reach.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.cameras.schemas import CameraUpdate
from app.vms.cameras.service import CameraService
from app.vms.groups.schemas import CameraACLEntry
from app.vms.models import Camera, CameraACL, MediaNode

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


def _scope(tenant=TENANT_A) -> Scope:
    return Scope(tenant_id=tenant, is_superadmin=False)


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


async def _camera(db, *, tenant=TENANT_A, name=None, node_id=None,
                  mode="continuous", enabled=True) -> Camera:
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name or f"cam-{uuid.uuid4().hex[:6]}",
        media_node_id=node_id, recording_mode=mode, is_enabled=enabled,
    )
    db.add(cam)
    await db.commit()
    await db.refresh(cam)
    return cam


async def _node(db, *, tenant=TENANT_A, name="rec", api_url="http://rec:8000") -> MediaNode:
    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name, host=name,
        api_url=api_url, status="online",
    )
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def _grant(db, *, tenant, target_type, target_id, subject_id="u1",
                 privileges=("view_live",)) -> CameraACL:
    row = CameraACL(
        tenant_id=tenant, subject_type="user", subject_id=subject_id,
        target_type=target_type, target_id=target_id, privileges=list(privileges),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _entry(subject_id: str, *privileges: str) -> CameraACLEntry:
    return CameraACLEntry(
        subject_type="user", subject_id=subject_id, privileges=list(privileges or ["view_live"])
    )


async def _all_acl(db) -> list[CameraACL]:
    return list((await db.execute(select(CameraACL))).scalars().all())


# ── PUT acl: what the wholesale replace is allowed to delete ─────────────────


async def test_a_put_replaces_the_cameras_own_grants_rather_than_adding_to_them(db):
    cam = await _camera(db)
    svc = CameraService(db, _scope())
    await svc.put_acl(cam.id, [_entry("alice"), _entry("bob")], actor=_Actor())

    out = await svc.put_acl(cam.id, [_entry("carol", "playback")], actor=_Actor())

    assert [e.subject_id for e in out] == ["carol"]
    # Idempotent PUT: revoking is done by sending the set WITHOUT the subject, so
    # a replace that appended would make revocation impossible through this route.
    rows = await svc.get_acl(cam.id)
    assert [r.subject_id for r in rows] == ["carol"]
    assert rows[0].privileges == ["playback"]


async def test_a_put_on_one_camera_leaves_the_group_grants_alone(db):
    # camera_acl holds BOTH kinds of row. A group grant covers every camera in the
    # group at once, so dropping the target_type filter from the delete turns an
    # edit of one camera's list into a revocation nobody asked for and nobody sees.
    cam = await _camera(db)
    group_grant = await _grant(
        db, tenant=TENANT_A, target_type="group", target_id="grp-1", subject_id="ops"
    )

    await CameraService(db, _scope()).put_acl(cam.id, [_entry("alice")], actor=_Actor())

    survivors = await _all_acl(db)
    assert group_grant.id in [r.id for r in survivors]
    assert {(r.target_type, r.subject_id) for r in survivors} == {
        ("group", "ops"), ("camera", "alice"),
    }


async def test_a_put_on_one_camera_leaves_another_cameras_grants_alone(db):
    cam, other = await _camera(db), await _camera(db)
    await _grant(db, tenant=TENANT_A, target_type="camera", target_id=other.id, subject_id="dana")

    await CameraService(db, _scope()).put_acl(cam.id, [_entry("alice")], actor=_Actor())

    assert {(r.target_id, r.subject_id) for r in await _all_acl(db)} == {
        (other.id, "dana"), (cam.id, "alice"),
    }


async def test_a_put_cannot_reach_another_tenants_grants_on_the_same_id(db):
    # Camera ids are unique, but the delete is by id and the scope filter is what
    # keeps that true across tenants. Without it, one tenant's PUT clears another's
    # row for an id they were never able to read.
    cam = await _camera(db)
    theirs = await _grant(
        db, tenant=TENANT_B, target_type="camera", target_id=cam.id, subject_id="intruder"
    )

    await CameraService(db, _scope(TENANT_A)).put_acl(cam.id, [_entry("alice")], actor=_Actor())

    assert theirs.id in [r.id for r in await _all_acl(db)]


async def test_another_tenants_camera_is_not_found_before_anything_is_deleted(db):
    # The ownership gate runs FIRST. If it ran after the delete — or not at all —
    # a caller could clear a camera's ACL in a tenant they cannot even read, and
    # still be told 404.
    cam = await _camera(db, tenant=TENANT_B)
    await _grant(db, tenant=TENANT_B, target_type="camera", target_id=cam.id, subject_id="theirs")

    outsider = CameraService(db, _scope(TENANT_A))
    actor = _Actor()

    with pytest.raises(NotFoundError):
        await outsider.put_acl(cam.id, [], actor=actor)
    with pytest.raises(NotFoundError):
        await outsider.get_acl(cam.id)

    assert len(await _all_acl(db)) == 1


async def test_new_grants_are_stamped_with_the_callers_tenant(db):
    # An unstamped (NULL-tenant) row reads as a platform grant, which is visible to
    # every tenant — the widest possible outcome of a routine edit.
    cam = await _camera(db)
    await CameraService(db, _scope()).put_acl(cam.id, [_entry("alice")], actor=_Actor())
    rows = await _all_acl(db)
    assert [r.tenant_id for r in rows] == [TENANT_A]
    assert rows[0].created_by == str(_Actor.user_id)


async def test_an_empty_put_clears_the_camera_and_reports_nothing_left(db):
    cam = await _camera(db)
    svc = CameraService(db, _scope())
    await svc.put_acl(cam.id, [_entry("alice")], actor=_Actor())

    assert await svc.put_acl(cam.id, [], actor=_Actor()) == []
    assert await svc.get_acl(cam.id) == []


async def test_get_acl_shows_only_this_cameras_own_entries(db):
    cam = await _camera(db)
    await _grant(db, tenant=TENANT_A, target_type="camera", target_id=cam.id, subject_id="alice")
    await _grant(db, tenant=TENANT_A, target_type="group", target_id="grp-1", subject_id="ops")
    await _grant(db, tenant=TENANT_B, target_type="camera", target_id=cam.id, subject_id="theirs")

    rows = await CameraService(db, _scope()).get_acl(cam.id)
    # A group grant that ALSO covers this camera is not a per-camera entry, and
    # showing it here would make the operator delete it by sending the list back.
    assert [r.subject_id for r in rows] == ["alice"]


# ── re-host: which recorder is told to stop ──────────────────────────────────


class _FakeNvr:
    """Records which recorder was addressed and what it was asked to do."""

    calls: list = []

    def __init__(self, *, bearer=None, base_url=None):
        self.base_url = base_url

    async def stop_recording(self, *, camera_id, profile):
        _FakeNvr.calls.append(("stop", self.base_url, camera_id, profile))
        return True

    async def start_recording(self, *, camera_id, profile, **kw):
        _FakeNvr.calls.append(("start", self.base_url, camera_id, profile))
        return True


@pytest.fixture
def nvr(monkeypatch):
    _FakeNvr.calls = []
    import app.vms.common.nvr_client as nvr_client

    monkeypatch.setattr(nvr_client, "NvrClient", _FakeNvr)
    return _FakeNvr


async def test_the_stop_is_sent_to_the_recorder_the_camera_just_left(db, nvr):
    # The camera row already points at the NEW node when this runs, so resolving
    # the base URL from the camera would send the stop to the recorder that is
    # about to start — killing the recording the move exists to keep.
    old = await _node(db, name="old", api_url="http://old-rec:8000")
    new = await _node(db, name="new", api_url="http://new-rec:8000")
    cam = await _camera(db, node_id=old.id, mode="continuous")

    await CameraService(db, _scope()).update(
        cam.id, CameraUpdate(media_node_id=new.id), actor=_Actor()
    )

    assert nvr.calls == [("stop", "http://old-rec:8000", cam.id, "main")]


async def test_the_new_recorder_is_never_told_to_start(db, nvr):
    # The recorder reconciles continuous/schedule modes on its own tick. The VMS
    # driving a start as well meant two things racing to begin one recording.
    old, new = await _node(db, name="old"), await _node(db, name="new", api_url="http://new:8000")
    cam = await _camera(db, node_id=old.id)

    await CameraService(db, _scope()).update(
        cam.id, CameraUpdate(media_node_id=new.id), actor=_Actor()
    )
    assert [c[0] for c in nvr.calls] == ["stop"]


async def test_a_substream_recording_is_stopped_on_the_profile_it_runs_on(db, nvr):
    # A stop for "main" leaves a sub-stream recording running on a recorder that no
    # longer fronts the camera — writing footage nothing will ever route a viewer to.
    old, new = await _node(db, name="old"), await _node(db, name="new", api_url="http://new:8000")
    cam = await _camera(db, node_id=old.id)
    cam.record_substream = True
    await db.commit()

    await CameraService(db, _scope()).update(
        cam.id, CameraUpdate(media_node_id=new.id), actor=_Actor()
    )
    assert nvr.calls[0][3] == "sub"


@pytest.mark.parametrize("mode", ["schedule", "motion"])
async def test_a_scheduled_camera_is_left_to_the_recorders_own_reconcile(db, nvr, mode):
    # Only continuous/manual are driven immediately. A stop against a scheduled
    # recording is a command to a data-plane that did not start one, and on the
    # next tick the old recorder would simply open it again.
    old, new = await _node(db, name="old"), await _node(db, name="new", api_url="http://new:8000")
    cam = await _camera(db, node_id=old.id, mode=mode)

    await CameraService(db, _scope()).update(
        cam.id, CameraUpdate(media_node_id=new.id), actor=_Actor()
    )
    assert nvr.calls == []


async def test_a_disabled_camera_has_nothing_to_stop(db, nvr):
    old, new = await _node(db, name="old"), await _node(db, name="new", api_url="http://new:8000")
    cam = await _camera(db, node_id=old.id, enabled=False)

    await CameraService(db, _scope()).update(
        cam.id, CameraUpdate(media_node_id=new.id), actor=_Actor()
    )
    assert nvr.calls == []


async def test_an_edit_that_does_not_move_the_camera_stops_nothing(db, nvr):
    # A PATCH that carries the SAME media_node_id — which the UI sends on every
    # save — must not interrupt a recording that never moved.
    old = await _node(db, name="old")
    cam = await _camera(db, node_id=old.id)

    await CameraService(db, _scope()).update(
        cam.id, CameraUpdate(media_node_id=old.id, name="renamed"), actor=_Actor()
    )
    assert nvr.calls == []


async def test_a_bulk_reassignment_stops_each_camera_on_its_own_old_recorder(db, nvr):
    # Cameras in one bulk move can come from DIFFERENT recorders, and _nodes_being_changed
    # is what keeps each stop pointed at the box that camera was actually on.
    a = await _node(db, name="a", api_url="http://a:8000")
    b = await _node(db, name="b", api_url="http://b:8000")
    target = await _node(db, name="t", api_url="http://t:8000")
    cam_a = await _camera(db, node_id=a.id)
    cam_b = await _camera(db, node_id=b.id)
    already = await _camera(db, node_id=target.id)

    await CameraService(db, _scope()).bulk(
        [cam_a.id, cam_b.id, already.id], "assign_node",
        group_id=None, retention_days=None, media_node_id=target.id, actor=_Actor(),
    )

    stopped = {(c[1], c[2]) for c in nvr.calls}
    assert stopped == {("http://a:8000", cam_a.id), ("http://b:8000", cam_b.id)}
    # The camera that was already on the target did not move, so nothing about its
    # recording changed.
    assert already.id not in {c[2] for c in nvr.calls}
