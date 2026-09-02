"""PTZ operator-control service tests (G1) — no network, in-memory SQLite.

Exercises the tenant-scoped PTZ control plane with the brand driver STUBBED (records the
PtzCommands issued) and the patrol cycler's sleep patched:

  * preset CRUD: create → driver ``set_preset`` called + a PtzPreset row persisted with the
    returned on-device token; goto → driver ``goto_preset`` with that token; delete → driver
    ``delete_preset`` + row gone.
  * patrol create + start → the cycler goto-presets each stop in ORDER (sleep patched);
    stop cancels it.
  * move / stop / zoom / focus dispatch the right PtzCommand (action + pan/tilt/zoom/speed).
  * tenant isolation: a foreign camera / preset / patrol → NotFound (→ 404).
  * a non-PTZ camera is rejected (ValidationError → 400).
  * graceful when the driver is unsupported / raises (DriverError bubbles for router → 502).

pytest-asyncio auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from kernel.auth import Scope
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.db import Base
from app.vms.drivers import DriverError, PtzCommand
from app.vms.models import Camera, PtzPatrol, PtzPreset
import app.vms.ptz.service as ptz_service_mod
import app.vms.ptz.cycler as cycler_mod
from app.vms.ptz.schemas import (
    PatrolCreate,
    PatrolStop,
    PatrolUpdate,
    PresetCreate,
)
from app.vms.ptz.service import PtzService

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


ACTOR = _Actor()


# ── driver stub ─────────────────────────────────────────────────────────
class _StubDriver:
    """Records every PtzCommand. ``set_preset`` returns a canned token."""

    def __init__(self, *, set_token="dev-1", raise_on=None):
        self.calls: list[PtzCommand] = []
        self._set_token = set_token
        self._raise_on = raise_on or set()
        self.aclosed = False

    async def ptz(self, host, creds, cmd: PtzCommand):
        self.calls.append(cmd)
        if cmd.action in self._raise_on:
            raise DriverError(f"stub: {cmd.action} unsupported")
        if cmd.action == "set_preset":
            return self._set_token
        if cmd.action == "get_presets":
            return []
        return None

    async def aclose(self):
        self.aclosed = True


@pytest.fixture
def driver(monkeypatch):
    d = _StubDriver()
    monkeypatch.setattr(ptz_service_mod, "get_driver", lambda brand: d)
    return d


# ── fixtures ─────────────────────────────────────────────────────────────
@pytest_asyncio.fixture
async def engine():
    # A FILE-based SQLite DB (not :memory:) so the background patrol-cycler task — which
    # opens its OWN sessions from the sessionmaker in a separate task/connection — sees the
    # SAME tables as the fixtures (an :memory: DB is per-connection).
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    eng = create_async_engine(f"sqlite+aiosqlite:///{path}", poolclass=StaticPool)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()
    try:
        os.unlink(path)
    except OSError:
        pass


@pytest_asyncio.fixture
async def sessionmaker(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def db(sessionmaker):
    async with sessionmaker() as s:
        yield s


@pytest.fixture
def scope():
    return Scope(tenant_id=TENANT, is_superadmin=False)


@pytest.fixture
def svc(db, scope):
    return PtzService(db, scope)


async def _make_camera(db, *, tenant=TENANT, ptz=True, name=None) -> Camera:
    cam = Camera(
        tenant_id=tenant,
        name=name or f"cam-{uuid.uuid4().hex[:8]}",
        status="online",
        brand="onvif",
        onvif_host="10.0.0.5",
        onvif_port=80,
        onvif_user="admin",
        ptz_capable=ptz,
    )
    db.add(cam)
    await db.commit()
    await db.refresh(cam)
    return cam


# ── preset CRUD ──────────────────────────────────────────────────────────
async def test_create_preset_calls_driver_and_persists_row(svc, db, driver):
    cam = await _make_camera(db)
    preset = await svc.create_preset(cam.id, PresetCreate(name="Gate"), actor=ACTOR)

    # driver.set_preset was called
    set_calls = [c for c in driver.calls if c.action == "set_preset"]
    assert len(set_calls) == 1
    assert set_calls[0].preset_name == "Gate"
    # row persisted with the driver-returned token
    assert preset.name == "Gate"
    assert preset.preset_token == "dev-1"
    row = await db.get(PtzPreset, preset.id)
    assert row is not None and row.camera_id == cam.id


async def test_create_preset_duplicate_name_conflicts(svc, db, driver):
    cam = await _make_camera(db)
    await svc.create_preset(cam.id, PresetCreate(name="Gate"), actor=ACTOR)
    with pytest.raises(ConflictError):
        await svc.create_preset(cam.id, PresetCreate(name="Gate"), actor=ACTOR)


async def test_goto_preset_calls_driver_with_token(svc, db, driver):
    cam = await _make_camera(db)
    preset = await svc.create_preset(cam.id, PresetCreate(name="Gate"), actor=ACTOR)
    driver.calls.clear()
    await svc.goto_preset(cam.id, preset.id)
    goto = [c for c in driver.calls if c.action == "goto_preset"]
    assert len(goto) == 1
    assert goto[0].preset_token == "dev-1"


async def test_delete_preset_removes_device_and_row(svc, db, driver):
    cam = await _make_camera(db)
    preset = await svc.create_preset(cam.id, PresetCreate(name="Gate"), actor=ACTOR)
    driver.calls.clear()
    await svc.delete_preset(cam.id, preset.id)
    assert any(c.action == "delete_preset" and c.preset_token == "dev-1" for c in driver.calls)
    assert await db.get(PtzPreset, preset.id) is None


async def test_list_presets_scoped_to_camera(svc, db, driver):
    cam = await _make_camera(db)
    await svc.create_preset(cam.id, PresetCreate(name="A"), actor=ACTOR)
    await svc.create_preset(cam.id, PresetCreate(name="B"), actor=ACTOR)
    items = await svc.list_presets(cam.id)
    assert {p.name for p in items} == {"A", "B"}


# ── move / zoom / focus / stop ────────────────────────────────────────────
async def test_move_dispatches_continuous(svc, db, driver):
    cam = await _make_camera(db)
    await svc.move(cam.id, mode="continuous", pan=0.5, tilt=-0.2, zoom=0.0, speed=0.7)
    cmd = driver.calls[-1]
    assert cmd.action == "continuous" and cmd.pan == 0.5 and cmd.tilt == -0.2 and cmd.speed == 0.7


async def test_stop_dispatches_stop(svc, db, driver):
    cam = await _make_camera(db)
    await svc.stop(cam.id)
    assert driver.calls[-1].action == "stop"


async def test_zoom_direction_sign(svc, db, driver):
    cam = await _make_camera(db)
    await svc.zoom(cam.id, direction="in", speed=0.6)
    assert driver.calls[-1].action == "zoom" and driver.calls[-1].zoom == 0.6
    await svc.zoom(cam.id, direction="out", speed=0.4)
    assert driver.calls[-1].zoom == -0.4


async def test_focus_direction_sign(svc, db, driver):
    cam = await _make_camera(db)
    await svc.focus(cam.id, direction="far", speed=0.5)
    assert driver.calls[-1].action == "focus" and driver.calls[-1].zoom == -0.5


# ── non-ptz + tenant isolation + driver errors ─────────────────────────────
async def test_non_ptz_camera_rejected(svc, db, driver):
    cam = await _make_camera(db, ptz=False)
    with pytest.raises(ValidationError):
        await svc.move(cam.id, mode="continuous", pan=0.5, tilt=0, zoom=0, speed=0.5)
    with pytest.raises(ValidationError):
        await svc.create_preset(cam.id, PresetCreate(name="X"), actor=ACTOR)


async def test_foreign_camera_not_found(svc, db, driver):
    cam = await _make_camera(db, tenant=OTHER_TENANT)
    with pytest.raises(NotFoundError):
        await svc.move(cam.id, mode="continuous", pan=0.5, tilt=0, zoom=0, speed=0.5)
    with pytest.raises(NotFoundError):
        await svc.list_presets(cam.id)


async def test_driver_error_bubbles(monkeypatch, db, scope):
    d = _StubDriver(raise_on={"continuous"})
    monkeypatch.setattr(ptz_service_mod, "get_driver", lambda brand: d)
    svc = PtzService(db, scope)
    cam = await _make_camera(db)
    with pytest.raises(DriverError):
        await svc.move(cam.id, mode="continuous", pan=1.0, tilt=0, zoom=0, speed=0.5)


# ── patrols ────────────────────────────────────────────────────────────────
async def test_patrol_create_validates_stops(svc, db, driver):
    cam = await _make_camera(db)
    p1 = await svc.create_preset(cam.id, PresetCreate(name="P1"), actor=ACTOR)
    p2 = await svc.create_preset(cam.id, PresetCreate(name="P2"), actor=ACTOR)
    patrol = await svc.create_patrol(
        cam.id,
        PatrolCreate(
            name="Tour",
            stops=[
                PatrolStop(preset_id=p1.id, dwell_seconds=1),
                PatrolStop(preset_id=p2.id, dwell_seconds=1),
            ],
        ),
        actor=ACTOR,
    )
    assert len(patrol.stops) == 2
    # a stop referencing a non-existent preset is rejected
    with pytest.raises(ValidationError):
        await svc.create_patrol(
            cam.id,
            PatrolCreate(name="Bad", stops=[PatrolStop(preset_id="nope", dwell_seconds=1)]),
            actor=ACTOR,
        )


async def test_patrol_start_gotos_presets_in_order(monkeypatch, sessionmaker):
    """start_patrol arms the cycler; the cycler goto-presets each stop in order (sleep patched)."""
    # Build a camera + 3 presets + a patrol directly against a session.
    async with sessionmaker() as setup_db:
        scope = Scope(tenant_id=TENANT, is_superadmin=False)
        setup_driver = _StubDriver()
        monkeypatch.setattr(ptz_service_mod, "get_driver", lambda brand: setup_driver)
        svc = PtzService(setup_db, scope)
        cam = await _make_camera(setup_db)
        presets = []
        for i, n in enumerate(("A", "B", "C")):
            # give each a distinct on-device token
            setup_driver._set_token = f"dev-{i}"
            presets.append(await svc.create_preset(cam.id, PresetCreate(name=n), actor=ACTOR))
        patrol = await svc.create_patrol(
            cam.id,
            PatrolCreate(
                name="Tour",
                stops=[PatrolStop(preset_id=p.id, dwell_seconds=1) for p in presets],
            ),
            actor=ACTOR,
        )
        patrol_id = patrol.id

    # Patch the cycler's driver + sleep. Record goto tokens in order; stop the loop after
    # one full pass so the test terminates.
    cyc_driver = _StubDriver()
    gotos: list[str] = []
    done = asyncio.Event()

    async def _rec_ptz(host, creds, cmd: PtzCommand):
        if cmd.action == "goto_preset":
            gotos.append(cmd.preset_token)
        return None

    cyc_driver.ptz = _rec_ptz  # type: ignore[method-assign]
    monkeypatch.setattr(cycler_mod, "get_driver", lambda brand: cyc_driver)

    real_sleep = asyncio.sleep

    async def _fast_sleep(secs):
        # After the 3rd stop's dwell, signal done + stop looping (fast).
        if len(gotos) >= 3 and not done.is_set():
            done.set()
        await real_sleep(0)

    monkeypatch.setattr(cycler_mod.asyncio, "sleep", _fast_sleep)

    cycler = cycler_mod.PatrolCycler(sessionmaker)
    # override the module singleton so the service uses THIS cycler
    monkeypatch.setattr(cycler_mod, "_CYCLER", cycler)

    # start via the service (flips is_running + arms the cycler)
    async with sessionmaker() as db2:
        svc2 = PtzService(db2, Scope(tenant_id=TENANT, is_superadmin=False))
        await svc2.start_patrol(cam.id, patrol_id)

    # wait for one full pass (bounded)
    try:
        await asyncio.wait_for(done.wait(), timeout=3.0)
    finally:
        await cycler.stop(patrol_id)

    assert gotos[:3] == ["dev-0", "dev-1", "dev-2"]

    # is_running persisted true on start
    async with sessionmaker() as db3:
        row = await db3.get(PtzPatrol, patrol_id)
        assert row.is_running is True


async def test_patrol_stop_flips_flag_and_cancels(monkeypatch, sessionmaker):
    async with sessionmaker() as setup_db:
        scope = Scope(tenant_id=TENANT, is_superadmin=False)
        d = _StubDriver()
        monkeypatch.setattr(ptz_service_mod, "get_driver", lambda brand: d)
        svc = PtzService(setup_db, scope)
        cam = await _make_camera(setup_db)
        p = await svc.create_preset(cam.id, PresetCreate(name="A"), actor=ACTOR)
        patrol = await svc.create_patrol(
            cam.id,
            PatrolCreate(name="T", stops=[PatrolStop(preset_id=p.id, dwell_seconds=1)]),
            actor=ACTOR,
        )
        patrol_id = patrol.id

    cycler = cycler_mod.PatrolCycler(sessionmaker)
    monkeypatch.setattr(cycler_mod, "_CYCLER", cycler)
    monkeypatch.setattr(cycler_mod, "get_driver", lambda brand: _StubDriver())

    async with sessionmaker() as db2:
        svc2 = PtzService(db2, Scope(tenant_id=TENANT, is_superadmin=False))
        await svc2.start_patrol(cam.id, patrol_id)
        assert cycler.is_running(patrol_id) is True
        await svc2.stop_patrol(cam.id, patrol_id)

    assert cycler.is_running(patrol_id) is False
    async with sessionmaker() as db3:
        row = await db3.get(PtzPatrol, patrol_id)
        assert row.is_running is False


async def test_patrol_update_and_delete(svc, db, driver):
    cam = await _make_camera(db)
    p = await svc.create_preset(cam.id, PresetCreate(name="A"), actor=ACTOR)
    patrol = await svc.create_patrol(
        cam.id, PatrolCreate(name="T", stops=[PatrolStop(preset_id=p.id, dwell_seconds=2)]), actor=ACTOR
    )
    updated = await svc.update_patrol(cam.id, patrol.id, PatrolUpdate(name="T2", speed=0.9))
    assert updated.name == "T2" and updated.speed == 0.9
    await svc.delete_patrol(cam.id, patrol.id)
    assert await db.get(PtzPatrol, patrol.id) is None


async def test_patrol_foreign_camera_not_found(svc, db, driver):
    cam = await _make_camera(db, tenant=OTHER_TENANT)
    with pytest.raises(NotFoundError):
        await svc.list_patrols(cam.id)
