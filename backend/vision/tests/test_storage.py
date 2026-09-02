"""Recording-integrity tests (no network) — checksum, verify, lock, default pool.

The storage data-plane (StoragePool/TierRule CRUD, retention, capacity, tiering,
RAID) was retired from this VMS — the NVR owns it — so those tests are gone. What
remains is what the VMS still owns: the default-pool bootstrap + recording
integrity/lock/verify, exercised against an in-memory SQLite DB with the filesystem
backed by ``tmp_path``.

  * default-pool bootstrap (seed + idempotent promote).
  * checksum-on-verify (real SHA-256 over a temp file) + corrupt → ``corrupted`` +
    delete → ``missing``; finalize-missing → ``unchecked``.
  * recording lock / unlock.

pytest-asyncio auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timezone

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.models import Camera, Recording
from app.vms.storage.service import StorageService, compute_integrity

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


def _svc(db, tenant=TENANT):
    return StorageService(db, _scope(tenant))


async def _make_recording(db, camera, *, path, start, size=1024, pool_id=None, locked=False):
    rec = Recording(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        camera_id=camera.id,
        profile="main",
        path=path,
        start_time=start,
        file_size=size,
        storage_pool_id=pool_id,
        locked=locked,
    )
    db.add(rec)
    await db.commit()
    return rec


def _write_file(tmp_path, name, data=b"hello-segment"):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


# ── default-pool bootstrap ─────────────────────────────────────────────────


async def test_ensure_default_pool_seeds_local(db, monkeypatch):
    monkeypatch.setenv("VE_RECORDINGS_DIR", "/tmp")
    svc = _svc(db)
    pool = await svc.ensure_default_pool()
    assert pool.is_default is True
    assert pool.pool_type == "local"
    # Idempotent — second call returns the same default (no duplicate).
    again = await svc.ensure_default_pool()
    assert again.id == pool.id


# ── checksum / integrity / verify ──────────────────────────────────────────


async def test_verify_computes_and_matches_checksum(db, camera, tmp_path):
    path = _write_file(tmp_path, "seg.mp4", b"payload-1234")
    expected = hashlib.sha256(b"payload-1234").hexdigest()
    rec = await _make_recording(db, camera, path=path, start=datetime.now(timezone.utc))
    svc = _svc(db)
    res = await svc.verify(rec.id)
    assert res.integrity_status == "verified"
    assert res.checksum == expected


async def test_verify_detects_corruption(db, camera, tmp_path):
    path = _write_file(tmp_path, "seg.mp4", b"original")
    rec = await _make_recording(db, camera, path=path, start=datetime.now(timezone.utc))
    svc = _svc(db)
    await svc.verify(rec.id)  # stores checksum of "original"
    # Corrupt the file on disk, re-verify → corrupted.
    with open(path, "wb") as fh:
        fh.write(b"tampered!")
    res = await svc.verify(rec.id)
    assert res.integrity_status == "corrupted"


async def test_verify_detects_missing_file(db, camera, tmp_path):
    path = _write_file(tmp_path, "seg.mp4", b"data")
    rec = await _make_recording(db, camera, path=path, start=datetime.now(timezone.utc))
    svc = _svc(db)
    await svc.verify(rec.id)
    os.remove(path)
    res = await svc.verify(rec.id)
    assert res.integrity_status == "missing"


async def test_compute_integrity_finalize_missing_is_unchecked(db, camera):
    # A not-yet-flushed segment at finalize → unchecked (not missing), for backfill.
    rec = await _make_recording(db, camera, path="/no/such/file.mp4", start=datetime.now(timezone.utc))
    status = await compute_integrity(db, _scope(), rec, missing_as_unchecked=True)
    assert status == "unchecked"


# ── recording lock / unlock ────────────────────────────────────────────────


async def test_lock_and_unlock(db, camera):
    rec = await _make_recording(db, camera, path="/x/a.mp4", start=datetime.now(timezone.utc))
    svc = _svc(db)
    res = await svc.set_lock(rec.id, locked=True, actor=_Actor(), reason="case-42")
    assert res.locked is True
    assert res.locked_by == str(_Actor.user_id)
    res2 = await svc.set_lock(rec.id, locked=False, actor=_Actor())
    assert res2.locked is False
    assert res2.locked_by is None
