"""P6-B tamper-proof signed-export tests — hash + Ed25519 sign + verify (+ tamper).

Three layers, no network:
  * signing unit — build a manifest, sign it, verify it; verify a tampered file →
    ``valid=false, reason="tampered"``; verify a mutated signature → ``bad-signature``;
    the env-key path (VE_EXPORT_SIGNING_KEY) round-trips.
  * worker E2E — the full concat + SIGN: synthetic fmp4 segments (REAL ffmpeg, skipped if
    absent) → the worker produces the mp4 + a ``<job>.manifest.json`` sidecar (hash +
    Ed25519 sig) → ExportService.verify → valid:true; corrupt the mp4 → valid:false.
  * watermark — a watermark:true export re-encodes with drawtext (assert it runs + the
    manifest records watermark=true).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.export import signing
from app.vms.export.service import ExportService
from app.vms.models import Camera, ExportJob, Recording

TENANT = uuid.uuid4()
_HAS_FFMPEG = shutil.which("ffmpeg") is not None


class _Actor:
    user_id = uuid.uuid4()


def _dt(h, m=0, s=0):
    return datetime(2026, 7, 9, h, m, s, tzinfo=timezone.utc)


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
    cam = Camera(id=str(uuid.uuid4()), tenant_id=TENANT, name="Front Door", connection_type="rtsp")
    db.add(cam)
    await db.commit()
    return cam


async def _add_recording(db, camera_id, start, end, *, path):
    rec = Recording(
        tenant_id=TENANT, camera_id=camera_id, profile="main", path=path,
        start_time=start, end_time=end,
        duration=((end - start).total_seconds() if end else None),
        trigger_type="continuous",
    )
    db.add(rec)
    await db.commit()
    return rec


# ── signing unit ───────────────────────────────────────────────────────────────
def test_sha256_file(tmp_path):
    p = tmp_path / "x.bin"
    p.write_bytes(b"hello world")
    import hashlib

    assert signing.sha256_file(str(p)) == hashlib.sha256(b"hello world").hexdigest()


def test_sign_and_verify_roundtrip(tmp_path, monkeypatch):
    monkeypatch.delenv("VE_EXPORT_SIGNING_KEY", raising=False)
    signing.reset_signer_cache()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00\x01\x02fake-mp4-bytes")
    h = signing.sha256_file(str(clip))
    manifest = signing.build_manifest(
        file_name="clip.mp4", file_hash=h, camera_id="cam1", tenant_id=str(TENANT),
        from_=_dt(10), to=_dt(11), duration_sec=3600.0, fmt="mp4", watermark=False,
        exported_by="user1", exported_at=_dt(11), job_id="job1",
    )
    sidecar = signing.sign_manifest(manifest)
    assert sidecar["algorithm"] == "Ed25519"
    assert sidecar["signature"]
    res = signing.verify_sidecar(sidecar, file_path=str(clip))
    assert res["valid"] is True and res["reason"] == "ok"


def test_verify_detects_tampered_file(tmp_path, monkeypatch):
    monkeypatch.delenv("VE_EXPORT_SIGNING_KEY", raising=False)
    signing.reset_signer_cache()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"original-bytes")
    h = signing.sha256_file(str(clip))
    manifest = signing.build_manifest(
        file_name="clip.mp4", file_hash=h, camera_id="cam1", tenant_id=None,
        from_=_dt(10), to=_dt(11), duration_sec=3600.0, fmt="mp4", watermark=False,
        exported_by=None, exported_at=_dt(11), job_id="job1",
    )
    sidecar = signing.sign_manifest(manifest)
    # Tamper: mutate the file after signing.
    clip.write_bytes(b"TAMPERED-bytes-different-length")
    res = signing.verify_sidecar(sidecar, file_path=str(clip))
    assert res["valid"] is False and res["reason"] == "tampered"


def test_verify_detects_bad_signature(tmp_path, monkeypatch):
    monkeypatch.delenv("VE_EXPORT_SIGNING_KEY", raising=False)
    signing.reset_signer_cache()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"bytes")
    h = signing.sha256_file(str(clip))
    manifest = signing.build_manifest(
        file_name="clip.mp4", file_hash=h, camera_id="c", tenant_id=None,
        from_=_dt(10), to=_dt(11), duration_sec=1.0, fmt="mp4", watermark=False,
        exported_by=None, exported_at=_dt(11), job_id="j",
    )
    sidecar = signing.sign_manifest(manifest)
    # Mutate the SIGNED manifest content but keep the old signature → sig no longer valid.
    sidecar["manifest"]["camera_id"] = "attacker"
    res = signing.verify_sidecar(sidecar, file_path=str(clip))
    assert res["valid"] is False and res["reason"] == "bad-signature"


def test_env_key_path(tmp_path, monkeypatch):
    priv, pub = signing.generate_keypair_pem()
    monkeypatch.setenv("VE_EXPORT_SIGNING_KEY", priv)
    signing.reset_signer_cache()
    assert signing.signer_public_pem().strip() == pub.strip()
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"abc")
    h = signing.sha256_file(str(clip))
    manifest = signing.build_manifest(
        file_name="c.mp4", file_hash=h, camera_id="c", tenant_id=None,
        from_=_dt(10), to=_dt(11), duration_sec=1.0, fmt="mp4", watermark=False,
        exported_by=None, exported_at=_dt(11), job_id="j",
    )
    sidecar = signing.sign_manifest(manifest)
    assert sidecar["key_id"] == signing.signer_key_id()
    assert signing.verify_sidecar(sidecar, file_path=str(clip))["valid"] is True
    monkeypatch.delenv("VE_EXPORT_SIGNING_KEY", raising=False)
    signing.reset_signer_cache()


# ── worker E2E: real ffmpeg concat + sign + verify + tamper ────────────────────
def _make_segment(path: str, seconds: int) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=160x120:rate=15:duration={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            path,
        ],
        check=True, capture_output=True,
    )


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg not installed")
async def test_worker_signs_and_verifies(db, camera, tmp_path, monkeypatch):
    from app.vms.export import worker as worker_mod

    monkeypatch.delenv("VE_EXPORT_SIGNING_KEY", raising=False)
    signing.reset_signer_cache()
    monkeypatch.setenv("VE_DOWNLOADS_DIR", str(tmp_path / "downloads"))
    seg1 = str(tmp_path / "seg1.mp4")
    seg2 = str(tmp_path / "seg2.mp4")
    _make_segment(seg1, 2)
    _make_segment(seg2, 2)
    await _add_recording(db, camera.id, _dt(10, 0, 0), _dt(10, 0, 2), path=seg1)
    await _add_recording(db, camera.id, _dt(10, 0, 2), _dt(10, 0, 4), path=seg2)

    job = await ExportService(db, _scope()).create(
        camera.id, _dt(10, 0, 0), _dt(10, 0, 4), "mp4", actor=_Actor()
    )
    sm = async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False)
    assert await worker_mod.ExportWorker(sm).run_cycle() == 1

    await db.commit()
    done = await db.get(ExportJob, job.id)
    await db.refresh(done)
    assert done.status == "done", done.error
    assert done.checksum and done.signature and done.manifest_path
    assert os.path.exists(done.manifest_path)
    # Sidecar structure.
    sidecar = json.loads(open(done.manifest_path).read())
    assert sidecar["algorithm"] == "Ed25519"
    assert sidecar["manifest"]["file_hash"] == f"sha256:{done.checksum}"

    # Service verify → valid.
    res = await ExportService(db, _scope()).verify(job.id)
    assert res["valid"] is True and res["reason"] == "ok"

    # Tamper the produced mp4 → verify reports tampered.
    with open(done.file_path, "ab") as fh:
        fh.write(b"EXTRA-TAMPER-BYTES")
    res2 = await ExportService(db, _scope()).verify(job.id)
    assert res2["valid"] is False and res2["reason"] == "tampered"


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg not installed")
async def test_worker_watermark_reencodes(db, camera, tmp_path, monkeypatch):
    from app.vms.export import worker as worker_mod

    monkeypatch.delenv("VE_EXPORT_SIGNING_KEY", raising=False)
    signing.reset_signer_cache()
    monkeypatch.setenv("VE_DOWNLOADS_DIR", str(tmp_path / "downloads"))
    seg = str(tmp_path / "seg.mp4")
    _make_segment(seg, 2)
    await _add_recording(db, camera.id, _dt(10, 0, 0), _dt(10, 0, 2), path=seg)

    job = await ExportService(db, _scope()).create(
        camera.id, _dt(10, 0, 0), _dt(10, 0, 2), "mp4", actor=_Actor(), watermark=True
    )
    assert job.watermark is True
    sm = async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False)
    assert await worker_mod.ExportWorker(sm).run_cycle() == 1

    await db.commit()
    done = await db.get(ExportJob, job.id)
    await db.refresh(done)
    assert done.status == "done", done.error
    assert done.watermark is True
    # The manifest records the watermark; the re-encoded clip is still valid + signed.
    sidecar = json.loads(open(done.manifest_path).read())
    assert sidecar["manifest"]["watermark"] is True
    res = await ExportService(db, _scope()).verify(job.id)
    assert res["valid"] is True


def test_watermark_filter_escapes():
    f = signing  # noqa: F841 — keep import symmetry
    from app.vms.export.ffmpeg import build_watermark_filter

    filt = build_watermark_filter("Cam: A'B")
    assert "drawtext=" in filt
    assert "localtime" in filt
