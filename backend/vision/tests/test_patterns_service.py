"""P3-C video-wall Pattern + camera-group layout tests (no network).

Exercises the pattern control plane + the new ``camera_groups.layout`` column against
an in-memory SQLite DB:

  * Pattern CRUD: create → get → list (+ ``is_active`` filter) → update (seconds/groups)
    → delete → 404, name unique-per-tenant (409), tenant isolation (unowned → 404).
  * Seconds validation happens at the pydantic schema (1..3600) — asserted directly.
  * CameraGroup ``layout``: create/update round-trips the grid-layout key; default 2x2.
  * Cascade: deleting a camera-group scrubs its id from every pattern that references it.

Mirrors the P3-A/P3-B service-test discipline: in-memory SQLite via ``Base.metadata``,
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import ConflictError, NotFoundError

from app.db import Base
from app.vms.groups.schemas import CameraGroupCreate, CameraGroupUpdate
from app.vms.groups.service import CameraGroupService
from app.vms.patterns.schemas import PatternCreate, PatternUpdate
from app.vms.patterns.service import PatternService

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


def _scope(tenant=TENANT):
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


def _psvc(db, tenant=TENANT):
    return PatternService(db, _scope(tenant))


def _gsvc(db, tenant=TENANT):
    return CameraGroupService(db, _scope(tenant))


# ── Pattern CRUD ────────────────────────────────────────────────────────


async def test_pattern_crud_roundtrip(db):
    svc = _psvc(db)
    created = await svc.create(
        PatternCreate(name="Lobby loop", camera_group_ids=["g1", "g2"], seconds=15),
        actor=_Actor(),
    )
    assert created.name == "Lobby loop"
    assert created.seconds == 15
    assert created.camera_group_ids == ["g1", "g2"]
    assert created.is_active is True

    fetched = await svc.get(created.id)
    assert fetched.id == created.id

    listed = await svc.list_()
    assert [p.id for p in listed] == [created.id]

    updated = await svc.update(
        created.id,
        PatternUpdate(seconds=30, camera_group_ids=["g3"]),
        actor=_Actor(),
    )
    assert updated.seconds == 30
    assert updated.camera_group_ids == ["g3"]

    await svc.delete(created.id)
    with pytest.raises(NotFoundError):
        await svc.get(created.id)


async def test_pattern_list_is_active_filter(db):
    svc = _psvc(db)
    a = await svc.create(PatternCreate(name="Active", is_active=True), actor=_Actor())
    b = await svc.create(PatternCreate(name="Inactive", is_active=False), actor=_Actor())

    active = await svc.list_(is_active=True)
    assert {p.id for p in active} == {a.id}
    inactive = await svc.list_(is_active=False)
    assert {p.id for p in inactive} == {b.id}
    assert len(await svc.list_()) == 2


async def test_pattern_duplicate_name_conflicts(db):
    svc = _psvc(db)
    await svc.create(PatternCreate(name="Dup"), actor=_Actor())
    with pytest.raises(ConflictError):
        await svc.create(PatternCreate(name="Dup"), actor=_Actor())


async def test_pattern_tenant_isolation(db):
    owner = _psvc(db, TENANT)
    created = await owner.create(PatternCreate(name="Mine"), actor=_Actor())

    other = _psvc(db, OTHER_TENANT)
    with pytest.raises(NotFoundError):
        await other.get(created.id)
    assert other.list_ is not None
    assert len(await other.list_()) == 0


def test_pattern_seconds_validation():
    with pytest.raises(PydanticValidationError):
        PatternCreate(name="Bad", seconds=0)
    with pytest.raises(PydanticValidationError):
        PatternCreate(name="Bad", seconds=3601)
    # boundaries are valid
    assert PatternCreate(name="ok", seconds=1).seconds == 1
    assert PatternCreate(name="ok", seconds=3600).seconds == 3600


# ── CameraGroup layout ──────────────────────────────────────────────────


async def test_group_layout_default_and_roundtrip(db):
    svc = _gsvc(db)
    default_grp = await svc.create(CameraGroupCreate(name="Default grid"), actor=_Actor())
    assert default_grp.layout == "2x2"

    grp = await svc.create(
        CameraGroupCreate(name="Big grid", layout="3x3"), actor=_Actor()
    )
    assert grp.layout == "3x3"

    updated = await svc.update(grp.id, CameraGroupUpdate(layout="8x8"), actor=_Actor())
    assert updated.layout == "8x8"


def test_group_layout_validation():
    with pytest.raises(PydanticValidationError):
        CameraGroupCreate(name="Bad", layout="5x5")


# ── Cascade cleanup on group delete ─────────────────────────────────────


async def test_group_delete_scrubs_pattern_membership(db):
    gsvc = _gsvc(db)
    psvc = _psvc(db)
    g1 = await gsvc.create(CameraGroupCreate(name="G1"), actor=_Actor())
    g2 = await gsvc.create(CameraGroupCreate(name="G2"), actor=_Actor())

    pat = await psvc.create(
        PatternCreate(name="Tour", camera_group_ids=[g1.id, g2.id]),
        actor=_Actor(),
    )
    assert set(pat.camera_group_ids) == {g1.id, g2.id}

    await gsvc.delete(g1.id)

    refreshed = await psvc.get(pat.id)
    assert refreshed.camera_group_ids == [g2.id]
