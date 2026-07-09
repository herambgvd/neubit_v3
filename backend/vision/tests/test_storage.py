"""P3-B storage tests (no network) — pools, checksum, retention, tiering, integrity.

Exercises the vision storage control-plane against an in-memory SQLite DB with the
filesystem backed by ``tmp_path`` and the S3 backend monkeypatched (no MinIO):

  * StoragePool CRUD (create local + s3, list, usage, default-pool bootstrap).
  * checksum-on-verify (real SHA-256 over a temp file) + corrupt → ``corrupted`` +
    delete → ``missing``.
  * retention: an old unlocked recording is deleted (file + row); an old **locked**
    recording is KEPT (lock protects against deletion).
  * capacity retention: pool over max_size deletes oldest-first, unlocked only.
  * tiering: a local→"s3" TierRule re-points an aged recording, removes the local
    file, and the (stubbed) object exists in the bucket.

Mirrors the P3-A recording-test discipline: fabricated stubs at every boundary;
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.models import Camera, Recording, StoragePool
from app.vms.storage.service import S3_PATH_PREFIX, StorageService, compute_integrity
from app.vms.storage.worker import RetentionTieringWorker
from app.vms.storage.schemas import StoragePoolCreate, TierRuleCreate

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


# ── StoragePool CRUD ───────────────────────────────────────────────────────


async def test_create_local_pool(db, tmp_path):
    svc = _svc(db)
    pool = await svc.create_pool(
        StoragePoolCreate(name="hot", pool_type="local", path=str(tmp_path), is_default=True),
        actor=_Actor(),
    )
    assert pool.pool_type == "local"
    assert pool.is_default is True
    assert pool.reachable is True  # tmp_path exists


async def test_create_s3_pool_encrypts_secret(db, monkeypatch):
    # Stub the S3 backend so no MinIO is needed (ensure_bucket + head succeed).
    async def _ok(self, *a, **k):
        return None

    async def _head(self):
        return True

    monkeypatch.setattr("app.vms.storage.service.S3Backend.ensure_bucket", _ok, raising=True)
    monkeypatch.setattr("app.vms.storage.service.S3Backend.head", _head, raising=True)

    svc = _svc(db)
    pool = await svc.create_pool(
        StoragePoolCreate(
            name="cold",
            pool_type="s3",
            s3_endpoint="http://minio:9000",
            s3_bucket="recordings",
            s3_access_key="minioadmin",
            s3_secret_key="supersecret",
        ),
        actor=_Actor(),
    )
    assert pool.s3_has_secret_key is True
    # Secret is NOT echoed in the public read.
    assert not hasattr(pool, "s3_secret_key")
    # Stored encrypted (not plaintext).
    row = await db.get(StoragePool, pool.id)
    assert row.s3_enc_secret_key.startswith("enc:")
    assert "supersecret" not in row.s3_enc_secret_key


async def test_duplicate_pool_name_conflicts(db, tmp_path):
    svc = _svc(db)
    await svc.create_pool(StoragePoolCreate(name="dup", path=str(tmp_path)), actor=_Actor())
    from kernel.errors import ConflictError

    with pytest.raises(ConflictError):
        await svc.create_pool(StoragePoolCreate(name="dup", path=str(tmp_path)), actor=_Actor())


async def test_ensure_default_pool_seeds_local(db, monkeypatch):
    monkeypatch.setenv("VE_RECORDINGS_DIR", "/tmp")
    svc = _svc(db)
    pool = await svc.ensure_default_pool()
    assert pool.is_default is True
    assert pool.pool_type == "local"
    # Idempotent — second call returns the same default (no duplicate).
    again = await svc.ensure_default_pool()
    assert again.id == pool.id


async def test_pool_usage_counts_bytes(db, camera, tmp_path):
    svc = _svc(db)
    pool = await svc.create_pool(StoragePoolCreate(name="p", path=str(tmp_path)), actor=_Actor())
    now = datetime.now(timezone.utc)
    await _make_recording(db, camera, path="/x/a.mp4", start=now, size=1000, pool_id=pool.id)
    await _make_recording(db, camera, path="/x/b.mp4", start=now, size=2000, pool_id=pool.id)
    usage = await svc.pool_usage(pool.id)
    assert usage.recording_count == 2
    assert usage.bytes_used == 3000


async def test_pool_tenant_isolation(db, tmp_path):
    svc = _svc(db)
    pool = await svc.create_pool(StoragePoolCreate(name="mine", path=str(tmp_path)), actor=_Actor())
    other = StorageService(db, _scope(OTHER_TENANT))
    from kernel.errors import NotFoundError

    with pytest.raises(NotFoundError):
        await other.get_pool(pool.id)


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


# ── retention worker: age ──────────────────────────────────────────────────


async def test_retention_deletes_old_unlocked(db, camera, tmp_path, monkeypatch):
    monkeypatch.setenv("VE_DEFAULT_RETENTION_DAYS", "30")
    path = _write_file(tmp_path, "old.mp4")
    old = datetime.now(timezone.utc) - timedelta(days=10)  # camera.retention_days=7
    rec = await _make_recording(db, camera, path=path, start=old)
    w = RetentionTieringWorker(None)
    deleted = await w._run_age_retention(db)
    assert deleted == 1
    assert await db.get(Recording, rec.id) is None
    assert not os.path.exists(path)  # file removed too


async def test_retention_keeps_locked(db, camera, tmp_path):
    path = _write_file(tmp_path, "locked.mp4")
    old = datetime.now(timezone.utc) - timedelta(days=10)
    rec = await _make_recording(db, camera, path=path, start=old, locked=True)
    w = RetentionTieringWorker(None)
    deleted = await w._run_age_retention(db)
    assert deleted == 0
    assert await db.get(Recording, rec.id) is not None  # KEPT
    assert os.path.exists(path)  # file untouched


async def test_retention_keeps_recent(db, camera, tmp_path):
    path = _write_file(tmp_path, "recent.mp4")
    recent = datetime.now(timezone.utc) - timedelta(days=1)  # < 7d
    rec = await _make_recording(db, camera, path=path, start=recent)
    w = RetentionTieringWorker(None)
    deleted = await w._run_age_retention(db)
    assert deleted == 0
    assert await db.get(Recording, rec.id) is not None


# ── retention worker: capacity ─────────────────────────────────────────────


async def test_capacity_retention_deletes_oldest_first_unlocked(db, camera, tmp_path):
    svc = _svc(db)
    pool = await svc.create_pool(
        StoragePoolCreate(name="capped", path=str(tmp_path), max_size_bytes=1500),
        actor=_Actor(),
    )
    now = datetime.now(timezone.utc)
    p_old = _write_file(tmp_path, "old.mp4")
    p_mid = _write_file(tmp_path, "mid.mp4")
    p_new = _write_file(tmp_path, "new.mp4")
    # 3 x 1000 bytes = 3000 > 1500 cap → delete oldest until under.
    await _make_recording(db, camera, path=p_old, start=now - timedelta(hours=3), size=1000, pool_id=pool.id)
    await _make_recording(db, camera, path=p_mid, start=now - timedelta(hours=2), size=1000, pool_id=pool.id)
    await _make_recording(db, camera, path=p_new, start=now - timedelta(hours=1), size=1000, pool_id=pool.id, locked=True)
    w = RetentionTieringWorker(None)
    deleted = await w._run_capacity_retention(db)
    # Deletes oldest unlocked (old, mid) → 2000 freed, under cap; the locked new stays.
    assert deleted == 2
    assert not os.path.exists(p_old)
    assert os.path.exists(p_new)  # locked → kept even though it'd help capacity


# ── tiering worker: local → s3 re-point ────────────────────────────────────


async def test_tiering_moves_to_s3_and_repoints(db, camera, tmp_path, monkeypatch):
    svc = _svc(db)
    src = await svc.create_pool(StoragePoolCreate(name="local", path=str(tmp_path)), actor=_Actor())
    # Stub the s3 pool creation reachability + build a fake object store.
    store: dict[str, bool] = {}

    async def _ok(self, *a, **k):
        return None

    async def _head(self):
        return True

    async def _put_file(self, local_path, rel):
        key = rel
        store[key] = True
        return key

    async def _obj_exists(self, key):
        return store.get(key, False)

    monkeypatch.setattr("app.vms.storage.service.S3Backend.ensure_bucket", _ok, raising=True)
    monkeypatch.setattr("app.vms.storage.service.S3Backend.head", _head, raising=True)
    monkeypatch.setattr("app.vms.storage.worker.S3Backend.put_file", _put_file, raising=True)
    monkeypatch.setattr("app.vms.storage.worker.S3Backend.object_exists", _obj_exists, raising=True)

    dst = await svc.create_pool(
        StoragePoolCreate(
            name="s3cold", pool_type="s3", s3_endpoint="http://minio:9000",
            s3_bucket="recordings", s3_access_key="k", s3_secret_key="s",
        ),
        actor=_Actor(),
    )
    await svc.create_rule(
        TierRuleCreate(name="to-cold", source_pool_id=src.id, target_pool_id=dst.id, after_age_hours=1),
        actor=_Actor(),
    )
    # A recording on the local pool, older than 1h, with a real file.
    monkeypatch.setenv("VE_RECORDINGS_DIR", str(tmp_path))
    path = _write_file(tmp_path, "seg.mp4", b"cold-me")
    old = datetime.now(timezone.utc) - timedelta(hours=3)
    rec = await _make_recording(db, camera, path=path, start=old, pool_id=src.id)

    w = RetentionTieringWorker(None)
    moved = await w._run_tiering(db)
    assert moved == 1

    await db.refresh(rec)
    assert rec.storage_pool_id == dst.id
    assert rec.path.startswith(S3_PATH_PREFIX)
    assert rec.integrity_status == "verified"
    assert not os.path.exists(path)  # source file removed
    # The object was put into the (stub) bucket.
    assert store  # non-empty
