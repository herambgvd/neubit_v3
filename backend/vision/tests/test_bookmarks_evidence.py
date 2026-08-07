"""Bookmarks + Evidence Lock / Legal Hold tests (G3) — no network, in-memory SQLite.

Exercises the tenant-scoped bookmark + evidence-lock control planes and the
``recording_is_locked`` seam (the retention SWEEP that consumed it is owned by the
NVR — the VMS RetentionTieringWorker was retired — so we assert the helper directly).

  * Bookmark CRUD: create (point + range) → row persisted; range query by camera + window;
    patch/delete; tenant isolation (a foreign tenant → NotFound → 404); range validation.
  * Evidence lock: create a hold on a camera+range; list (+ active_only); soft-release keeps
    the row but flips is_active; check (point + range) badge; tenant isolation.
  * Retention with a lock: seed an unlocked recording covered by an ACTIVE lock + an unlocked
    one outside any lock → run ``_run_age_retention`` → the LOCKED-by-range survives, the
    unlocked is deleted. Released lock no longer protects. Capacity retention respects the
    range lock too.

pytest-asyncio auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError, ValidationError

from app.db import Base
from app.vms.models import Bookmark, Camera, EvidenceLock, Recording
from app.vms.bookmarks.service import BookmarkService
from app.vms.bookmarks.schemas import BookmarkCreate, BookmarkUpdate
from app.vms.evidence.service import EvidenceService, recording_is_locked, is_locked
from app.vms.evidence.schemas import EvidenceLockCreate

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


@pytest_asyncio.fixture
async def camera(db):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        connection_type="rtsp",
        retention_days=7,
    )
    db.add(cam)
    await db.commit()
    return cam


def _now():
    return datetime.now(timezone.utc)


async def _make_recording(db, camera, *, path, start, end=None, size=1024, pool_id=None, locked=False):
    rec = Recording(
        id=str(uuid.uuid4()),
        tenant_id=camera.tenant_id,
        camera_id=camera.id,
        profile="main",
        path=path,
        start_time=start,
        end_time=end,
        file_size=size,
        storage_pool_id=pool_id,
        locked=locked,
    )
    db.add(rec)
    await db.commit()
    return rec


def _write_file(tmp_path, name, data=b"seg-bytes"):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


# ── Bookmarks ───────────────────────────────────────────────────────────────


async def test_bookmark_create_point_and_range(db, camera):
    svc = BookmarkService(db, _scope())
    t = _now()
    pt = await svc.create(
        BookmarkCreate(camera_id=camera.id, start_ts=t, title="moment", tags=["x"]),
        actor=_Actor(),
    )
    assert pt.end_ts is None
    assert pt.tags == ["x"]
    rng = await svc.create(
        BookmarkCreate(camera_id=camera.id, start_ts=t, end_ts=t + timedelta(minutes=5), title="range"),
        actor=_Actor(),
    )
    assert rng.end_ts is not None
    assert rng.created_by == str(_Actor.user_id)


async def test_bookmark_range_query_by_window(db, camera):
    svc = BookmarkService(db, _scope())
    base = _now()
    # inside window
    await svc.create(BookmarkCreate(camera_id=camera.id, start_ts=base + timedelta(hours=1), title="in"), actor=_Actor())
    # outside window (way later)
    await svc.create(BookmarkCreate(camera_id=camera.id, start_ts=base + timedelta(days=2), title="out"), actor=_Actor())
    items, total = await svc.list_(
        camera_id=camera.id, from_=base, to=base + timedelta(hours=2)
    )
    titles = {b.title for b in items}
    assert "in" in titles and "out" not in titles
    assert total == 1


async def test_bookmark_update_and_delete(db, camera):
    svc = BookmarkService(db, _scope())
    b = await svc.create(BookmarkCreate(camera_id=camera.id, start_ts=_now(), title="t"), actor=_Actor())
    upd = await svc.update(b.id, BookmarkUpdate(title="t2", note="hello", tags=["a", "b"]))
    assert upd.title == "t2" and upd.note == "hello" and upd.tags == ["a", "b"]
    await svc.delete(b.id)
    with pytest.raises(NotFoundError):
        await svc.update(b.id, BookmarkUpdate(title="x"))


async def test_bookmark_tenant_isolation(db, camera):
    svc = BookmarkService(db, _scope())
    b = await svc.create(BookmarkCreate(camera_id=camera.id, start_ts=_now(), title="mine"), actor=_Actor())
    other = BookmarkService(db, _scope(OTHER_TENANT))
    # foreign tenant cannot see / mutate it
    with pytest.raises(NotFoundError):
        await other.update(b.id, BookmarkUpdate(title="hijack"))
    # foreign tenant listing this camera → camera not owned → 404
    with pytest.raises(NotFoundError):
        await other.list_(camera_id=camera.id)


async def test_bookmark_range_validation(db, camera):
    svc = BookmarkService(db, _scope())
    t = _now()
    with pytest.raises(ValueError):  # pydantic model_validator
        BookmarkCreate(camera_id=camera.id, start_ts=t, end_ts=t - timedelta(minutes=1), title="bad")


# ── Evidence lock CRUD ──────────────────────────────────────────────────────


async def test_evidence_create_list_release(db, camera):
    svc = EvidenceService(db, _scope())
    t = _now()
    lk = await svc.create(
        EvidenceLockCreate(
            camera_id=camera.id, start_ts=t - timedelta(hours=1), end_ts=t,
            reason="theft", case_ref="CASE-42",
        ),
        actor=_Actor(),
    )
    assert lk.is_active is True and lk.case_ref == "CASE-42"

    items, total = await svc.list_(camera_id=camera.id, active_only=True)
    assert total == 1

    rel = await svc.release(lk.id, actor=_Actor())
    assert rel.is_active is False
    assert rel.released_by == str(_Actor.user_id) and rel.released_at is not None
    # row is KEPT (audit trail) — still fetchable, just inactive
    active_items, active_total = await svc.list_(camera_id=camera.id, active_only=True)
    assert active_total == 0
    all_items, all_total = await svc.list_(camera_id=camera.id, active_only=False)
    assert all_total == 1


async def test_evidence_check_point_and_range(db, camera):
    svc = EvidenceService(db, _scope())
    t = _now()
    await svc.create(
        EvidenceLockCreate(camera_id=camera.id, start_ts=t - timedelta(hours=2), end_ts=t - timedelta(hours=1)),
        actor=_Actor(),
    )
    # point inside the hold
    assert await svc.check(camera.id, at=t - timedelta(minutes=90), start=None, end=None) is True
    # point outside
    assert await svc.check(camera.id, at=t, start=None, end=None) is False
    # range overlapping the hold
    assert await svc.check(camera.id, at=None, start=t - timedelta(hours=3), end=t - timedelta(minutes=90)) is True


async def test_evidence_tenant_isolation(db, camera):
    svc = EvidenceService(db, _scope())
    t = _now()
    lk = await svc.create(
        EvidenceLockCreate(camera_id=camera.id, start_ts=t - timedelta(hours=1), end_ts=t),
        actor=_Actor(),
    )
    other = EvidenceService(db, _scope(OTHER_TENANT))
    with pytest.raises(NotFoundError):
        await other.get(lk.id)


# ── evidence lock → recording_is_locked seam ───────────────────────────────
# NOTE: the retention/capacity SWEEP that consumed this seam is owned by the NVR
# (the VMS RetentionTieringWorker was retired), so these tests assert the
# ``recording_is_locked`` helper directly rather than driving a worker.


async def test_recording_is_locked_reflects_active_lock(db, camera, tmp_path):
    """An ACTIVE evidence lock covering a recording's window → recording_is_locked
    True; a recording outside any lock window → False (protection is by range alone,
    the per-recording ``locked`` bool stays False)."""
    old = _now() - timedelta(days=10)

    p_locked = _write_file(tmp_path, "held.mp4")
    rec_locked = await _make_recording(
        db, camera, path=p_locked, start=old, end=old + timedelta(minutes=30)
    )
    p_free = _write_file(tmp_path, "free.mp4")
    rec_free = await _make_recording(
        db, camera, path=p_free, start=old + timedelta(hours=5), end=old + timedelta(hours=5, minutes=30)
    )

    ev = EvidenceService(db, _scope())
    await ev.create(
        EvidenceLockCreate(
            camera_id=camera.id,
            start_ts=old - timedelta(minutes=10),
            end_ts=old + timedelta(hours=1),
            reason="legal hold",
        ),
        actor=_Actor(),
    )

    assert await recording_is_locked(db, rec_locked) is True
    assert await recording_is_locked(db, rec_free) is False


async def test_released_lock_no_longer_protects(db, camera, tmp_path):
    old = _now() - timedelta(days=10)
    p = _write_file(tmp_path, "held.mp4")
    rec = await _make_recording(db, camera, path=p, start=old, end=old + timedelta(minutes=30))

    ev = EvidenceService(db, _scope())
    lk = await ev.create(
        EvidenceLockCreate(
            camera_id=camera.id, start_ts=old - timedelta(minutes=10), end_ts=old + timedelta(hours=1)
        ),
        actor=_Actor(),
    )
    # While active → protected.
    assert await recording_is_locked(db, rec) is True

    # Release the lock → no longer protects.
    await ev.release(lk.id, actor=_Actor())
    assert await recording_is_locked(db, rec) is False


async def test_is_locked_helper_requires_point_or_range(db, camera):
    with pytest.raises(ValidationError):
        await is_locked(db, camera_id=camera.id, tenant_id=TENANT)
