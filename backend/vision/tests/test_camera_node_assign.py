"""Recorder-node assignment tests (MN-1c) — assign a camera to a MediaNode.

Exercises ``CameraService.update`` (PATCH ``media_node_id``) + ``CameraService.bulk``
(``assign_node`` action) directly against an in-memory SQLite DB — NO network:

  * PATCH assign to a valid tenant node persists ``media_node_id``.
  * PATCH assign to a NON-EXISTENT / CROSS-TENANT node is rejected (NotFound).
  * PATCH unassign (null) is allowed and clears ``media_node_id``.
  * bulk ``assign_node`` sets ``media_node_id`` on every listed (owned) camera;
    a bad node id rejects the whole op.
  * re-host is BEST-EFFORT: a raised error from the recording start/stop path does
    NOT fail the PATCH (the reassignment still persists).

Camera rows are inserted directly (bypassing the create-probe network path). The
recording re-host is monkeypatched so no Go-nvr call is made.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.cameras import service as cameras_service
from app.vms.cameras.schemas import CameraUpdate
from app.vms.cameras.service import CameraService
from app.vms.models import Camera, MediaNode

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


def _scope(tenant) -> Scope:
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


@pytest.fixture(autouse=True)
def no_rehost(monkeypatch):
    """Silence the best-effort re-host by default (no Go-nvr in unit tests).

    Individual tests that assert the best-effort contract override this.
    """
    async def _noop(self, camera, old_node_id):
        return None

    monkeypatch.setattr(CameraService, "_rehost_recording", _noop)


async def _mk_node(db, *, tenant, name="rec-a", api_url="http://rec-a:8000") -> MediaNode:
    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name, host=name,
        api_url=api_url, status="online",
    )
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def _mk_camera(db, *, tenant, name="cam", node_id=None, mode="continuous") -> Camera:
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name,
        media_node_id=node_id, recording_mode=mode, is_enabled=True,
    )
    db.add(cam)
    await db.commit()
    await db.refresh(cam)
    return cam


# ── PATCH assign / unassign ──────────────────────────────────────────────────────
async def test_patch_assign_to_valid_node_persists(db):
    node = await _mk_node(db, tenant=TENANT_A)
    cam = await _mk_camera(db, tenant=TENANT_A)
    svc = CameraService(db, _scope(TENANT_A))

    out = await svc.update(cam.id, CameraUpdate(media_node_id=node.id), actor=_Actor())
    assert out.media_node_id == node.id
    await db.refresh(cam)
    assert cam.media_node_id == node.id


async def test_patch_assign_to_missing_node_rejected(db):
    cam = await _mk_camera(db, tenant=TENANT_A)
    svc = CameraService(db, _scope(TENANT_A))
    with pytest.raises(NotFoundError):
        await svc.update(cam.id, CameraUpdate(media_node_id=str(uuid.uuid4())), actor=_Actor())
    await db.refresh(cam)
    assert cam.media_node_id is None  # unchanged


async def test_patch_assign_to_cross_tenant_node_rejected(db):
    node_b = await _mk_node(db, tenant=TENANT_B, name="rec-b", api_url="http://rec-b:8000")
    cam = await _mk_camera(db, tenant=TENANT_A)
    svc = CameraService(db, _scope(TENANT_A))
    # Tenant A cannot home a camera on tenant B's node (NotFound, not Forbidden).
    with pytest.raises(NotFoundError):
        await svc.update(cam.id, CameraUpdate(media_node_id=node_b.id), actor=_Actor())
    await db.refresh(cam)
    assert cam.media_node_id is None


async def test_patch_unassign_null_allowed(db):
    node = await _mk_node(db, tenant=TENANT_A)
    cam = await _mk_camera(db, tenant=TENANT_A, node_id=node.id)
    svc = CameraService(db, _scope(TENANT_A))

    out = await svc.update(cam.id, CameraUpdate(media_node_id=None), actor=_Actor())
    assert out.media_node_id is None
    await db.refresh(cam)
    assert cam.media_node_id is None


async def test_patch_assign_to_shared_null_tenant_node_allowed(db):
    # A platform/NULL-tenant node is usable by any tenant (mirrors owns() read rule).
    shared = await _mk_node(db, tenant=None, name="shared", api_url="http://shared:8000")
    cam = await _mk_camera(db, tenant=TENANT_A)
    svc = CameraService(db, _scope(TENANT_A))
    out = await svc.update(cam.id, CameraUpdate(media_node_id=shared.id), actor=_Actor())
    assert out.media_node_id == shared.id


# ── bulk assign_node ─────────────────────────────────────────────────────────────
async def test_bulk_assign_node_sets_all(db):
    node = await _mk_node(db, tenant=TENANT_A)
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1")
    c2 = await _mk_camera(db, tenant=TENANT_A, name="c2")
    svc = CameraService(db, _scope(TENANT_A))

    res = await svc.bulk(
        [c1.id, c2.id], "assign_node",
        group_id=None, retention_days=None, media_node_id=node.id, actor=_Actor(),
    )
    assert res["affected"] == 2
    await db.refresh(c1)
    await db.refresh(c2)
    assert c1.media_node_id == node.id
    assert c2.media_node_id == node.id


async def test_bulk_assign_node_bad_id_rejected(db):
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1")
    svc = CameraService(db, _scope(TENANT_A))
    with pytest.raises(NotFoundError):
        await svc.bulk(
            [c1.id], "assign_node",
            group_id=None, retention_days=None, media_node_id=str(uuid.uuid4()), actor=_Actor(),
        )
    await db.refresh(c1)
    assert c1.media_node_id is None


async def test_bulk_assign_node_null_unassigns(db):
    node = await _mk_node(db, tenant=TENANT_A)
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=node.id)
    svc = CameraService(db, _scope(TENANT_A))
    res = await svc.bulk(
        [c1.id], "assign_node",
        group_id=None, retention_days=None, media_node_id=None, actor=_Actor(),
    )
    assert res["affected"] == 1
    await db.refresh(c1)
    assert c1.media_node_id is None


# ── re-host is best-effort ───────────────────────────────────────────────────────
async def test_rehost_failure_does_not_fail_patch(db, monkeypatch):
    """A raised error from the recording re-host must NOT fail the PATCH — the
    reassignment still persists. We patch the recording start/stop seam to blow up
    and assert the real ``_rehost_recording`` swallows it."""
    # Undo the autouse no-op so the REAL _rehost_recording runs.
    monkeypatch.undo()

    node = await _mk_node(db, tenant=TENANT_A)
    cam = await _mk_camera(db, tenant=TENANT_A, mode="continuous")
    svc = CameraService(db, _scope(TENANT_A))

    # Make BOTH the recording drive-start AND the old-node stop raise; the real
    # _rehost_recording must catch both (no network is touched).
    from app.vms.common.nvr_client import NvrClient
    from app.vms.recording.service import RecordingService

    async def _boom(self, camera, *, trigger):
        raise RuntimeError("nvr exploded")

    async def _boom_stop(self, *, camera_id, profile):
        raise RuntimeError("stop exploded")

    monkeypatch.setattr(RecordingService, "_drive_start", _boom)
    monkeypatch.setattr(NvrClient, "stop_recording", _boom_stop)

    # The PATCH still succeeds and persists media_node_id despite the exploding re-host.
    out = await svc.update(cam.id, CameraUpdate(media_node_id=node.id), actor=_Actor())
    assert out.media_node_id == node.id
    await db.refresh(cam)
    assert cam.media_node_id == node.id
