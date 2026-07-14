"""VW-C — alarm-driven auto-display (``wall_display`` linkage action) tests.

Exercises the ``action_wall_display`` executor against a real ``VideoWallService`` backed
by an in-memory SQLite DB (NATS ``emit_wall_state`` monkeypatched to a capture). Covers:

  * event fires → the resolved (event) camera is pushed onto the target monitor cell +
    wall state written;
  * the scheduled revert RESTORES the cell's prior value (prior camera / clear-if-empty);
  * a foreign-tenant wall → graceful ``ok=False`` (never a cross-tenant write);
  * a bare ``wall_display`` with no resolvable camera behaves like popup's no-camera path
    (``ok=False``, no state written);
  * explicit ``camera_source`` resolves the config's ``camera_id`` instead of the event's.

The revert is tested by driving ``hold_seconds`` with ``asyncio.sleep`` patched to a no-op
and awaiting the created task, so no real wall-clock wait is incurred.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.linkage.actions import ActionContext, action_wall_display
import app.vms.videowall.service as wall_svc_mod
from app.vms.videowall.schemas import MonitorCreate, WallCreate
from app.vms.videowall.service import VideoWallService
from app.vms.models import Camera

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()
TENANT_SCOPE = Scope(tenant_id=TENANT, is_superadmin=False)


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
async def maker(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
def capture(monkeypatch):
    """Silence + capture every NATS wall broadcast so tests need no broker."""
    published: list[tuple] = []

    async def _emit(tenant_id, wall_id, payload, **kw):
        published.append((tenant_id, wall_id, payload))
        return f"tenant.{tenant_id or 'platform'}.vms.wall.{wall_id}.state"

    monkeypatch.setattr(wall_svc_mod, "emit_wall_state", _emit)
    return published


@pytest_asyncio.fixture
async def camera(maker):
    async with maker() as s:
        cam = Camera(
            id=str(uuid.uuid4()),
            tenant_id=TENANT,
            name="Event Cam",
            brand="onvif",
            connection_type="onvif",
        )
        s.add(cam)
        await s.commit()
        return cam


@pytest_asyncio.fixture
async def other_camera(maker):
    async with maker() as s:
        cam = Camera(
            id=str(uuid.uuid4()),
            tenant_id=TENANT,
            name="Preset Cam",
            brand="onvif",
            connection_type="onvif",
        )
        s.add(cam)
        await s.commit()
        return cam


@pytest_asyncio.fixture
async def wall(maker):
    """A wall (tenant=TENANT) with one browser monitor. Returns (wall_id, monitor_id)."""
    async with maker() as s:
        svc = VideoWallService(s, TENANT_SCOPE)
        w = await svc.create_wall(WallCreate(name="Control Room", rows=2, cols=2), actor=ACTOR)
        m = await svc.create_monitor(
            w.id, MonitorCreate(name="Screen 1", position=0, kind="browser", layout=4), actor=ACTOR
        )
        return w.id, m.id


def _ctx(maker, *, camera_id):
    return ActionContext(
        tenant_id=str(TENANT),
        camera_id=camera_id,
        event_id=str(uuid.uuid4()),
        event_type="motion",
        severity="warning",
        title="Motion at Lobby",
        sessionmaker=maker,
        reason="motion detected",
    )


async def _state(maker, wall_id):
    async with maker() as s:
        return (await VideoWallService(s, TENANT_SCOPE).get_state(wall_id)).state or {}


# ── push (event camera) ────────────────────────────────────────────────────


async def test_wall_display_pushes_event_camera(maker, wall, camera):
    wall_id, mon_id = wall
    ctx = _ctx(maker, camera_id=camera.id)
    res = await action_wall_display(
        ctx,
        {"wall_id": wall_id, "monitor_id": mon_id, "cell_index": 1, "hold_seconds": 0},
    )
    assert res.ok is True
    assert res.type == "wall_display"
    # State written: the resolved event camera on the right (monitor, cell).
    assert (await _state(maker, wall_id)) == {mon_id: {"1": camera.id}}


# ── revert restores prior value ────────────────────────────────────────────


async def test_wall_display_reverts_to_prior_camera(maker, wall, camera, other_camera, monkeypatch):
    wall_id, mon_id = wall
    # Seed the cell with a PRIOR camera (other_camera) so revert must restore it.
    async with maker() as s:
        await VideoWallService(s, TENANT_SCOPE).push_cell(
            wall_id, mon_id, 1, other_camera.id, actor=ACTOR
        )

    # Patch asyncio.sleep to a no-op so the revert task fires immediately.
    async def _no_sleep(_):
        return None

    monkeypatch.setattr(asyncio, "sleep", _no_sleep)

    ctx = _ctx(maker, camera_id=camera.id)
    res = await action_wall_display(
        ctx,
        {"wall_id": wall_id, "monitor_id": mon_id, "cell_index": 1, "hold_seconds": 5},
    )
    assert res.ok is True
    # Immediately after push (before the revert task runs) the event camera is on the cell.
    # Let the scheduled revert task run to completion.
    await asyncio.gather(*[t for t in asyncio.all_tasks() if t is not asyncio.current_task()])
    # Prior camera restored.
    assert (await _state(maker, wall_id)) == {mon_id: {"1": other_camera.id}}


async def test_wall_display_reverts_to_empty_when_cell_was_empty(maker, wall, camera, monkeypatch):
    wall_id, mon_id = wall  # cell starts EMPTY

    async def _no_sleep(_):
        return None

    monkeypatch.setattr(asyncio, "sleep", _no_sleep)

    ctx = _ctx(maker, camera_id=camera.id)
    res = await action_wall_display(
        ctx,
        {"wall_id": wall_id, "monitor_id": mon_id, "cell_index": 2, "hold_seconds": 5},
    )
    assert res.ok is True
    await asyncio.gather(*[t for t in asyncio.all_tasks() if t is not asyncio.current_task()])
    # Cell reverts to empty → whole (empty) monitor dropped from state.
    assert (await _state(maker, wall_id)) == {}


# ── explicit camera_source ─────────────────────────────────────────────────


async def test_wall_display_explicit_camera_source(maker, wall, camera, other_camera):
    wall_id, mon_id = wall
    # Event camera is `camera`, but config asks for `other_camera` explicitly.
    ctx = _ctx(maker, camera_id=camera.id)
    res = await action_wall_display(
        ctx,
        {
            "wall_id": wall_id,
            "monitor_id": mon_id,
            "cell_index": 0,
            "camera_source": "explicit",
            "camera_id": other_camera.id,
            "hold_seconds": 0,
        },
    )
    assert res.ok is True
    assert (await _state(maker, wall_id)) == {mon_id: {"0": other_camera.id}}


# ── graceful failures ──────────────────────────────────────────────────────


async def test_wall_display_no_camera_like_popup(maker, wall):
    wall_id, mon_id = wall
    ctx = _ctx(maker, camera_id=None)  # camera-less event, default source
    res = await action_wall_display(
        ctx, {"wall_id": wall_id, "monitor_id": mon_id, "cell_index": 0, "hold_seconds": 0}
    )
    assert res.ok is False
    assert "no camera" in res.detail
    assert (await _state(maker, wall_id)) == {}  # nothing written


async def test_wall_display_foreign_tenant_wall_graceful(maker, camera):
    # A wall owned by OTHER_TENANT — the action's tenant scope (TENANT) must NOT touch it.
    async with maker() as s:
        osvc = VideoWallService(s, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
        w = await osvc.create_wall(WallCreate(name="Foreign Wall"), actor=ACTOR)
        m = await osvc.create_monitor(
            w.id, MonitorCreate(name="M", position=0, kind="browser", layout=4), actor=ACTOR
        )
        foreign_wall_id, foreign_mon_id = w.id, m.id

    ctx = _ctx(maker, camera_id=camera.id)  # ctx.tenant_id == TENANT
    res = await action_wall_display(
        ctx,
        {
            "wall_id": foreign_wall_id,
            "monitor_id": foreign_mon_id,
            "cell_index": 0,
            "hold_seconds": 0,
        },
    )
    assert res.ok is False
    assert "not found" in res.detail
    # Foreign wall state untouched.
    async with maker() as s:
        osvc = VideoWallService(s, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
        assert (await osvc.get_state(foreign_wall_id)).state == {}


async def test_wall_display_missing_wall_id_graceful(maker, camera):
    ctx = _ctx(maker, camera_id=camera.id)
    res = await action_wall_display(ctx, {"monitor_id": "x", "cell_index": 0})
    assert res.ok is False
    assert "required" in res.detail
