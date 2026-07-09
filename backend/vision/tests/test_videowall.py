"""Video-wall service tests (VW-A) — no network, in-memory SQLite.

Exercises the tenant-scoped video-wall control plane against an in-memory SQLite DB with
the NATS emit (``emit_wall_state``) monkeypatched to capture the broadcast:

  * wall + monitor CRUD;
  * push-camera-to-cell mutates the single JSON ``state`` blob + broadcasts the new full
    state on ``tenant.<id>.vms.wall.<wall_id>.state``;
  * clear cell / clear whole monitor;
  * save preset (snapshot current state) + apply preset (replace live state) + broadcast;
  * tour create + start (applies first preset) / stop;
  * tenant isolation: a foreign wall / monitor / preset yields a clean NotFound (→ 404),
    never a cross-tenant read/write.

Mirrors the events-service test discipline: ``pytest-asyncio`` auto mode runs the
``async def test_*`` coroutines; every NATS boundary is a fabricated capture.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.models import Camera, VideoWall
import app.vms.videowall.service as wall_svc_mod
from app.vms.videowall.schemas import (
    MonitorCreate,
    PresetCreate,
    PushCellBody,
    TourCreate,
    WallCreate,
    WallUpdate,
)
from app.vms.videowall.service import VideoWallService

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


ACTOR = _Actor()


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine):
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s


@pytest.fixture
def scope():
    return Scope(tenant_id=TENANT, is_superadmin=False)


@pytest.fixture
def svc(db, scope):
    return VideoWallService(db, scope)


@pytest.fixture
def capture(monkeypatch):
    """Capture every ``emit_wall_state`` broadcast (tenant, wall_id, payload)."""
    published: list[tuple] = []

    async def _emit(tenant_id, wall_id, payload, **kw):
        published.append((tenant_id, wall_id, payload))
        return f"tenant.{tenant_id or 'platform'}.vms.wall.{wall_id}.state"

    monkeypatch.setattr(wall_svc_mod, "emit_wall_state", _emit)
    return published


@pytest_asyncio.fixture
async def camera(db):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        brand="onvif",
        connection_type="onvif",
    )
    db.add(cam)
    await db.commit()
    return cam


# ── wall + monitor CRUD ────────────────────────────────────────────────────


async def test_wall_crud(svc):
    wall = await svc.create_wall(WallCreate(name="Control Room", rows=2, cols=3), actor=ACTOR)
    assert wall.name == "Control Room"
    assert wall.rows == 2 and wall.cols == 3
    assert wall.state == {}

    got = await svc.get_wall(wall.id)
    assert got.id == wall.id

    listed = await svc.list_walls()
    assert listed.total == 1

    upd = await svc.update_wall(wall.id, WallUpdate(name="CR-1", cols=4), actor=ACTOR)
    assert upd.name == "CR-1" and upd.cols == 4

    await svc.delete_wall(wall.id, actor=ACTOR)
    assert (await svc.list_walls()).total == 0


async def test_monitor_crud(svc):
    wall = await svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await svc.create_monitor(
        wall.id, MonitorCreate(name="Screen 1", position=0, kind="browser", layout=4), actor=ACTOR
    )
    assert mon.wall_id == wall.id and mon.layout == 4 and mon.kind == "browser"

    mons = await svc.list_monitors(wall.id)
    assert mons.total == 1

    await svc.delete_monitor(wall.id, mon.id, actor=ACTOR)
    assert (await svc.list_monitors(wall.id)).total == 0


# ── live state push / clear + broadcast ────────────────────────────────────


async def test_push_cell_updates_state_and_broadcasts(svc, camera, capture):
    wall = await svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await svc.create_monitor(wall.id, MonitorCreate(name="S1", layout=4), actor=ACTOR)

    res = await svc.push_cell(wall.id, mon.id, 2, camera.id, actor=ACTOR)
    assert res.state == {mon.id: {"2": camera.id}}

    # Persisted on the wall row.
    fresh = await svc.get_wall(wall.id)
    assert fresh.state == {mon.id: {"2": camera.id}}

    # Broadcast one frame on the per-wall subject with the new full state.
    assert len(capture) == 1
    tid, wid, payload = capture[0]
    assert tid == TENANT and wid == wall.id
    assert payload["state"] == {mon.id: {"2": camera.id}}
    assert payload["action"] == "push"


async def test_clear_cell_and_monitor(svc, camera, capture):
    wall = await svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await svc.create_monitor(wall.id, MonitorCreate(name="S1", layout=4), actor=ACTOR)
    await svc.push_cell(wall.id, mon.id, 0, camera.id, actor=ACTOR)
    await svc.push_cell(wall.id, mon.id, 1, camera.id, actor=ACTOR)

    # Clear one cell.
    res = await svc.clear_cell(wall.id, mon.id, 0, actor=ACTOR)
    assert res.state == {mon.id: {"1": camera.id}}

    # Clear the whole monitor (cell_index None).
    res = await svc.clear_cell(wall.id, mon.id, None, actor=ACTOR)
    assert res.state == {}
    # push(2) + clear(2) = 4 broadcasts.
    assert len(capture) == 4


# ── presets: save (snapshot) + apply (replace) ─────────────────────────────


async def test_save_and_apply_preset(svc, camera, capture):
    wall = await svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await svc.create_monitor(wall.id, MonitorCreate(name="S1", layout=4), actor=ACTOR)
    await svc.push_cell(wall.id, mon.id, 0, camera.id, actor=ACTOR)

    # Save current live state as a preset.
    preset = await svc.save_preset(wall.id, PresetCreate(name="Layout A", is_default=True), actor=ACTOR)
    assert preset.state == {mon.id: {"0": camera.id}}
    assert preset.is_default is True

    # Clear the wall, then re-apply the preset → live state restored + broadcast.
    await svc.clear_cell(wall.id, mon.id, None, actor=ACTOR)
    assert (await svc.get_state(wall.id)).state == {}

    applied = await svc.apply_preset(wall.id, preset.id, actor=ACTOR)
    assert applied.state == {mon.id: {"0": camera.id}}
    assert capture[-1][2]["action"] == "apply_preset"
    assert capture[-1][2]["preset_id"] == preset.id

    presets = await svc.list_presets(wall.id)
    assert presets.total == 1


# ── tours: create + start (applies first preset) / stop ────────────────────


async def test_tour_create_start_stop(svc, camera, capture):
    wall = await svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await svc.create_monitor(wall.id, MonitorCreate(name="S1", layout=4), actor=ACTOR)
    await svc.push_cell(wall.id, mon.id, 0, camera.id, actor=ACTOR)
    p1 = await svc.save_preset(wall.id, PresetCreate(name="P1"), actor=ACTOR)

    tour = await svc.create_tour(
        wall.id, TourCreate(name="Rounds", preset_ids=[p1.id], dwell_seconds=15), actor=ACTOR
    )
    assert tour.preset_ids == [p1.id] and tour.dwell_seconds == 15
    assert tour.is_running is False

    started = await svc.set_tour_running(wall.id, tour.id, True, actor=ACTOR)
    assert started.is_running is True
    # Starting applied the first preset → an apply_preset broadcast happened.
    assert any(pl["action"] == "apply_preset" for _, _, pl in capture)

    stopped = await svc.set_tour_running(wall.id, tour.id, False, actor=ACTOR)
    assert stopped.is_running is False

    assert (await svc.list_tours(wall.id)).total == 1


# ── tenant isolation ───────────────────────────────────────────────────────


async def test_tenant_isolation(db, camera):
    mine = VideoWallService(db, Scope(tenant_id=TENANT, is_superadmin=False))
    other = VideoWallService(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))

    wall = await mine.create_wall(WallCreate(name="Mine"), actor=ACTOR)
    mon = await mine.create_monitor(wall.id, MonitorCreate(name="S1"), actor=ACTOR)

    # The other tenant can't see it in the list…
    assert (await other.list_walls()).total == 0
    # …nor read it by id…
    with pytest.raises(NotFoundError):
        await other.get_wall(wall.id)
    # …nor push to it…
    with pytest.raises(NotFoundError):
        await other.push_cell(wall.id, mon.id, 0, camera.id, actor=ACTOR)
    # …nor delete it.
    with pytest.raises(NotFoundError):
        await other.delete_wall(wall.id, actor=ACTOR)

    # The owner still sees exactly one.
    assert (await mine.list_walls()).total == 1


async def test_broadcast_subject_shape(svc, camera, capture):
    """The mutation must target ``tenant.<id>.vms.wall.<wall_id>.state``."""
    wall = await svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await svc.create_monitor(wall.id, MonitorCreate(name="S1"), actor=ACTOR)
    await svc.push_cell(wall.id, mon.id, 0, camera.id, actor=ACTOR)
    tid, wid, _ = capture[-1]
    subj = f"tenant.{tid}.vms.wall.{wid}.state"
    assert subj == f"tenant.{TENANT}.vms.wall.{wall.id}.state"
