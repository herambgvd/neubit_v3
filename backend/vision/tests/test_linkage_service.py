"""P5-B event-linkage tests (no network, no NATS).

Exercises the linkage domain against an in-memory SQLite DB with every action executor
stubbed (nvr / driver / NATS-emit monkeypatched): CRUD + tenant scoping, the engine's
match → filter → scope → schedule → cooldown → execute → audit path for a camera event,
the access door→camera resolution (explicit map), and the fire-audit.

Mirrors the P5-A events-test discipline: every boundary is a stub; ``pytest-asyncio``
auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.linkage import actions as actions_mod
from app.vms.linkage.consumer import LinkageConsumer
from app.vms.linkage.schemas import LinkageAction, LinkageRuleCreate, LinkageRuleUpdate
from app.vms.linkage.service import LinkageEngine, LinkageRuleService
from app.vms.models import Camera, CameraGroup, LinkageFire, LinkageRule

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()
PLATFORM = Scope(tenant_id=None, is_superadmin=True)
TENANT_SCOPE = Scope(tenant_id=TENANT, is_superadmin=False)


class _Actor:
    user_id = uuid.uuid4()


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


@pytest_asyncio.fixture
async def db(maker):
    async with maker() as s:
        yield s


@pytest_asyncio.fixture
async def camera(db):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        brand="onvif",
        connection_type="onvif",
        onvif_host="10.0.0.5",
        onvif_port=80,
        onvif_user="admin",
    )
    db.add(cam)
    await db.commit()
    return cam


@pytest.fixture
def spy(monkeypatch):
    """Replace every action executor with a spy that records the call + returns ok."""
    calls: list[tuple[str, dict, str | None]] = []

    def _make(name):
        async def _exec(ctx, config):
            calls.append((name, dict(config), ctx.camera_id))
            return actions_mod.ActionResult(name, True, f"{name} ok (spy)")
        return _exec

    stub = {k: _make(k) for k in actions_mod.EXECUTORS}
    # Patch the dict the engine imported at module load.
    from app.vms.linkage import service as svc_mod
    monkeypatch.setattr(svc_mod, "EXECUTORS", stub)
    return calls


def _cam_event_env(camera_id, event_type="motion", severity="alarm", tenant=TENANT, **payload):
    return {
        "tenant_id": str(tenant) if tenant else None,
        "type": f"vms.camera.{event_type}",
        "payload": {
            "event_id": str(uuid.uuid4()),
            "camera_id": camera_id,
            "event_type": event_type,
            "severity": severity,
            "title": f"{event_type} event",
            **payload,
        },
    }


async def _mk_rule(db, **over):
    base = dict(
        tenant_id=TENANT,
        name="Motion → record + popup",
        is_active=True,
        trigger_event_type="motion",
        trigger_filter={},
        camera_scope={},
        actions=[
            {"type": "start_recording", "config": {"pre_seconds": 5, "post_seconds": 10}},
            {"type": "popup", "config": {}},
        ],
        cooldown_seconds=0,
        schedule={},
    )
    base.update(over)
    row = LinkageRule(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


# ── CRUD + tenant scoping ─────────────────────────────────────────────────────
async def test_crud_create_and_get(db):
    svc = LinkageRuleService(db, TENANT_SCOPE)
    body = LinkageRuleCreate(
        name="R1",
        trigger_event_type="motion",
        actions=[LinkageAction(type="popup", config={})],
        cooldown_seconds=30,
    )
    pub = await svc.create(body, actor=_Actor())
    assert pub.trigger_event_type == "motion"
    assert pub.cooldown_seconds == 30
    got = await svc.get(pub.id)
    assert got.id == pub.id
    row = await db.get(LinkageRule, pub.id)
    assert str(row.tenant_id) == str(TENANT)


async def test_crud_update_and_delete(db):
    svc = LinkageRuleService(db, TENANT_SCOPE)
    pub = await svc.create(
        LinkageRuleCreate(name="R", trigger_event_type="motion"), actor=_Actor()
    )
    upd = await svc.update(
        pub.id, LinkageRuleUpdate(is_active=False, cooldown_seconds=60), actor=_Actor()
    )
    assert upd.is_active is False and upd.cooldown_seconds == 60
    await svc.delete(pub.id)
    with pytest.raises(NotFoundError):
        await svc.get(pub.id)


async def test_crud_tenant_isolation(db):
    owner = LinkageRuleService(db, TENANT_SCOPE)
    pub = await owner.create(
        LinkageRuleCreate(name="R", trigger_event_type="motion"), actor=_Actor()
    )
    other = LinkageRuleService(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
    with pytest.raises(NotFoundError):
        await other.get(pub.id)
    assert (await other.list_()).total == 0


async def test_action_schema_rejects_unknown_type():
    with pytest.raises(ValueError):
        LinkageAction(type="detonate", config={})


# ── engine: match + execute + audit ───────────────────────────────────────────
async def test_engine_matches_and_fires_actions(engine, maker, db, camera, spy):
    await _mk_rule(db)
    eng = LinkageEngine(maker)
    fired = await eng.handle_camera_event(_cam_event_env(camera.id))
    assert fired == 1
    # Both actions ran, targeting the event camera.
    names = [c[0] for c in spy]
    assert "start_recording" in names and "popup" in names
    assert all(c[2] == camera.id for c in spy)
    # A fire-audit row was written with per-action outcomes.
    async with maker() as s:
        fires = (await s.execute(LinkageFire.__table__.select())).fetchall()
    assert len(fires) == 1


async def test_engine_ignores_nonmatching_type(engine, maker, db, camera, spy):
    await _mk_rule(db, trigger_event_type="tamper")
    eng = LinkageEngine(maker)
    fired = await eng.handle_camera_event(_cam_event_env(camera.id, event_type="motion"))
    assert fired == 0 and spy == []


async def test_engine_cooldown_blocks_rapid_second_fire(engine, maker, db, camera, spy):
    await _mk_rule(db, cooldown_seconds=300)
    eng = LinkageEngine(maker)
    first = await eng.handle_camera_event(_cam_event_env(camera.id))
    second = await eng.handle_camera_event(_cam_event_env(camera.id))
    assert first == 1 and second == 0  # cooldown blocks the second
    # Only one fire's worth of action calls (2 actions).
    assert len([c for c in spy if c[0] == "popup"]) == 1


async def test_engine_filter_min_severity(engine, maker, db, camera, spy):
    await _mk_rule(db, trigger_filter={"min_severity": "alarm"})
    eng = LinkageEngine(maker)
    # A warning event is below the threshold → no fire.
    assert await eng.handle_camera_event(
        _cam_event_env(camera.id, severity="warning")
    ) == 0
    # An alarm event fires.
    assert await eng.handle_camera_event(
        _cam_event_env(camera.id, severity="alarm")
    ) == 1


async def test_engine_scope_camera_ids_gate(engine, maker, db, camera, spy):
    # Rule scoped to a DIFFERENT camera → the event camera isn't in scope → no fire.
    await _mk_rule(db, camera_scope={"camera_ids": ["some-other-cam"]})
    eng = LinkageEngine(maker)
    assert await eng.handle_camera_event(_cam_event_env(camera.id)) == 0
    assert spy == []


async def test_engine_scope_group_membership(engine, maker, db, camera, spy):
    grp = CameraGroup(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="G", camera_ids=[camera.id]
    )
    db.add(grp)
    await db.commit()
    await _mk_rule(db, camera_scope={"group_ids": [grp.id]})
    eng = LinkageEngine(maker)
    assert await eng.handle_camera_event(_cam_event_env(camera.id)) == 1


async def test_engine_schedule_window_closed(engine, maker, db, camera, spy, monkeypatch):
    # A schedule that is closed on every weekday → never fires.
    await _mk_rule(db, schedule={"mon": [], "tue": [], "wed": [], "thu": [],
                                 "fri": [], "sat": [], "sun": []})
    eng = LinkageEngine(maker)
    assert await eng.handle_camera_event(_cam_event_env(camera.id)) == 0


async def test_engine_platform_rule_does_not_fire_for_tenant_isolation(engine, maker, db, camera, spy):
    # A rule for OTHER_TENANT must not fire on TENANT's camera event.
    await _mk_rule(db, tenant_id=OTHER_TENANT)
    eng = LinkageEngine(maker)
    assert await eng.handle_camera_event(_cam_event_env(camera.id, tenant=TENANT)) == 0


# ── access ↔ video: door → camera resolution (explicit map) ────────────────────
def _access_env(door_ref, category="door", etype="forced", tenant=TENANT):
    return {
        "tenant_id": str(tenant) if tenant else None,
        "type": f"access.{category}.{etype}",
        "payload": {
            "event_id": str(uuid.uuid4()),
            "category": category,
            "type": etype,
            "door_ref": door_ref,
            "result": "alarm",
        },
    }


async def test_access_door_forced_resolves_camera_explicit_map(engine, maker, db, camera, spy):
    # A rule triggered by access_door_forced with an explicit door→camera map.
    await _mk_rule(
        db,
        name="Door forced → pop + record",
        trigger_event_type="access_door_forced",
        trigger_filter={"door_camera_map": {"DOOR-1": [camera.id]}},
        actions=[
            {"type": "start_recording", "config": {}},
            {"type": "popup", "config": {}},
        ],
    )
    eng = LinkageEngine(maker)
    fired = await eng.handle_access_event(_access_env("DOOR-1"))
    assert fired == 1
    # Actions targeted the mapped camera.
    assert any(c[0] == "start_recording" and c[2] == camera.id for c in spy)
    assert any(c[0] == "popup" and c[2] == camera.id for c in spy)
    # Audit records the door_ref + camera.
    async with maker() as s:
        row = (await s.execute(LinkageFire.__table__.select())).fetchone()
    assert row.door_ref == "DOOR-1" and row.camera_id == camera.id


async def test_access_door_catchall_camera(engine, maker, db, camera, spy):
    # No explicit door entry → the "*" catch-all camera is used.
    await _mk_rule(
        db,
        trigger_event_type="access_door_held",
        trigger_filter={"door_camera_map": {"*": [camera.id]}},
        actions=[{"type": "popup", "config": {}}],
    )
    eng = LinkageEngine(maker)
    fired = await eng.handle_access_event(_access_env("UNMAPPED-DOOR", etype="held"))
    assert fired == 1
    assert any(c[0] == "popup" and c[2] == camera.id for c in spy)


async def test_access_no_camera_still_fires_cameraless_actions(engine, maker, db, spy):
    # A door event with no resolvable camera still fires a bare notify (camera-less).
    await _mk_rule(
        db,
        trigger_event_type="access_door_forced",
        trigger_filter={},  # no map, no core → no camera resolves
        actions=[{"type": "notify", "config": {"channel": "email"}}],
    )
    eng = LinkageEngine(maker)
    fired = await eng.handle_access_event(_access_env("NOPE"))
    assert fired == 1
    assert any(c[0] == "notify" for c in spy)


# ── consumer wiring (subjects + routing) ───────────────────────────────────────
async def test_consumer_routes_camera_and_access(maker, camera, db, spy):
    await _mk_rule(db)  # motion rule
    await _mk_rule(
        db,
        trigger_event_type="access_door_forced",
        trigger_filter={"door_camera_map": {"*": [camera.id]}},
        actions=[{"type": "popup", "config": {}}],
    )

    subscribed: list[str] = []

    class _Bus:
        async def subscribe(self, pattern, handler, *, durable=None):
            subscribed.append(pattern)

    consumer = LinkageConsumer(_Bus(), maker)
    await consumer.start()
    assert "tenant.*.vms.>" in subscribed
    assert "tenant.*.access.>" in subscribed

    # Drive both handlers directly.
    assert await consumer._engine.handle_camera_event(_cam_event_env(camera.id)) == 1
    assert await consumer._engine.handle_access_event(_access_env("X")) == 1
