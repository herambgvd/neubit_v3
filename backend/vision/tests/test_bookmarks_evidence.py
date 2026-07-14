"""Bookmarks + Evidence Lock / Legal Hold tests (G3) — no network, in-memory SQLite.

Exercises the tenant-scoped bookmark + evidence-lock control planes and — the key value
of G3 — that the retention worker SKIPS a recording covered by an active evidence lock and
still deletes an unlocked one.

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
from app.vms.models import Bookmark, Camera, EvidenceLock, Recording, StoragePool
from app.vms.bookmarks.service import BookmarkService
from app.vms.bookmarks.schemas import BookmarkCreate, BookmarkUpdate
from app.vms.evidence.service import EvidenceService, recording_is_locked, is_locked
from app.vms.evidence.schemas import EvidenceLockCreate
from app.vms.storage.worker import RetentionTieringWorker
from app.vms.storage.service import StorageService
from app.vms.storage.schemas import StoragePoolCreate

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


# ── retention worker MUST respect the evidence lock (the key test) ──────────


async def test_retention_skips_evidence_locked_and_deletes_unlocked(db, camera, tmp_path, monkeypatch):
    """Seed a recording covered by an ACTIVE evidence lock + an unlocked one; run the
    age-retention step; assert the locked survives + the unlocked is deleted."""
    monkeypatch.setenv("VE_DEFAULT_RETENTION_DAYS", "30")
    old = _now() - timedelta(days=10)  # camera.retention_days=7 → both are past retention

    # A recording covered by an evidence lock (note: its per-recording `locked` bool is FALSE
    # — protection comes from the range lock alone, proving the seam works).
    p_locked = _write_file(tmp_path, "held.mp4")
    rec_locked = await _make_recording(
        db, camera, path=p_locked, start=old, end=old + timedelta(minutes=30)
    )
    # An unlocked recording on the same camera, outside any lock window.
    p_free = _write_file(tmp_path, "free.mp4")
    rec_free = await _make_recording(
        db, camera, path=p_free, start=old + timedelta(hours=5), end=old + timedelta(hours=5, minutes=30)
    )

    # Place an ACTIVE evidence lock covering the first recording's window only.
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

    # Sanity: the helper the worker uses agrees.
    assert await recording_is_locked(db, rec_locked) is True
    assert await recording_is_locked(db, rec_free) is False

    w = RetentionTieringWorker(None)
    deleted = await w._run_age_retention(db)

    assert deleted == 1
    # LOCKED survives (row + file).
    assert await db.get(Recording, rec_locked.id) is not None
    assert os.path.exists(p_locked)
    # UNLOCKED deleted (row + file).
    assert await db.get(Recording, rec_free.id) is None
    assert not os.path.exists(p_free)


async def test_released_lock_no_longer_protects(db, camera, tmp_path, monkeypatch):
    monkeypatch.setenv("VE_DEFAULT_RETENTION_DAYS", "30")
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

    w = RetentionTieringWorker(None)
    deleted = await w._run_age_retention(db)
    assert deleted == 1
    assert await db.get(Recording, rec.id) is None
    assert not os.path.exists(p)


async def test_capacity_retention_respects_evidence_lock(db, camera, tmp_path):
    svc = StorageService(db, _scope())
    pool = await svc.create_pool(
        StoragePoolCreate(name="capped", path=str(tmp_path), max_size_bytes=1500),
        actor=_Actor(),
    )
    now = _now()
    p_old = _write_file(tmp_path, "old.mp4")
    p_mid = _write_file(tmp_path, "mid.mp4")
    p_new = _write_file(tmp_path, "new.mp4")
    r_old = await _make_recording(db, camera, path=p_old, start=now - timedelta(hours=3), end=now - timedelta(hours=2, minutes=30), size=1000, pool_id=pool.id)
    await _make_recording(db, camera, path=p_mid, start=now - timedelta(hours=2), end=now - timedelta(hours=1, minutes=30), size=1000, pool_id=pool.id)
    await _make_recording(db, camera, path=p_new, start=now - timedelta(hours=1), end=now - timedelta(minutes=30), size=1000, pool_id=pool.id)

    # Evidence-lock the OLDEST (which capacity would delete first).
    ev = EvidenceService(db, _scope())
    await ev.create(
        EvidenceLockCreate(camera_id=camera.id, start_ts=now - timedelta(hours=4), end_ts=now - timedelta(hours=2, minutes=15)),
        actor=_Actor(),
    )

    w = RetentionTieringWorker(None)
    await w._run_capacity_retention(db)
    # The evidence-held oldest survives; unlocked recordings are evicted to get under cap.
    assert await db.get(Recording, r_old.id) is not None
    assert os.path.exists(p_old)


async def test_is_locked_helper_requires_point_or_range(db, camera):
    with pytest.raises(ValidationError):
        await is_locked(db, camera_id=camera.id, tenant_id=TENANT)
