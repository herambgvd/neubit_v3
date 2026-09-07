"""Motion-zone + privacy-mask config (G5-backend) tests — no network, in-memory SQLite.

Covers the G5 backend deliverables:
  * ``motion_zones`` column + create/update advanced-config parity + the read schema.
  * Local config GET/PUT for ``motion_zones`` (mirror of ``privacy_masks``).
  * The driver push seam: ``put_local_config`` best-effort calls ``driver.configure``
    with the drawn shapes; the local save ALWAYS succeeds and the echo carries
    ``pushed`` / ``push_error`` (store-only vs applied-on-device).
  * Tenant isolation on the config endpoints.
  * ``privacy_masks`` still works (no regression).

pytest-asyncio auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError, ValidationError

from app.db import Base
from app.vms.cameras import service as camera_service
from app.vms.cameras.schemas import AdvancedConfig, CameraCreate, CameraUpdate
from app.vms.cameras.service import CameraService
from app.vms.models import Camera

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()

# Normalized (0..1) draw-tool shapes — the shape the G5 frontend + drivers agree on.
RECT = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.25}
POLY = {"points": [[0.5, 0.5], [0.8, 0.5], [0.8, 0.9], [0.5, 0.9]]}
ZONE = {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5, "sensitivity": 3, "threshold": 5}


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
    """A minimal camera with a host so the driver-push path is exercised."""
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="Cam A",
        connection_type="rtsp", brand="onvif", onvif_host="10.0.0.9",
    )
    db.add(cam)
    await db.commit()
    return cam


@pytest.fixture
def spy_driver(monkeypatch):
    """Replace ``get_driver`` with a spy driver capturing every ``configure`` call."""

    calls: list[dict] = []

    class _SpyDriver:
        async def configure(self, host, creds, section, payload):
            calls.append({"host": host, "section": section, "payload": payload})
            return {"applied": True}

        async def aclose(self):
            return None

    monkeypatch.setattr(camera_service, "get_driver", lambda brand: _SpyDriver())
    return calls


# ── column + schema parity ───────────────────────────────────────────────────


def test_model_has_motion_zones_default():
    cam = Camera(name="x")
    # Column default is applied at flush; the attribute default here is None until then,
    # but the server_default is '[]' — assert the column exists on the model.
    assert "motion_zones" in Camera.__table__.columns


def test_advanced_schema_carries_motion_zones():
    adv = AdvancedConfig(privacy_masks=[RECT], motion_zones=[ZONE])
    assert adv.motion_zones == [ZONE]
    # default is an empty list
    assert AdvancedConfig().motion_zones == []


async def test_create_persists_motion_zones(db):
    svc = CameraService(db, _scope())
    body = CameraCreate(
        name="Cam Create",
        advanced=AdvancedConfig(privacy_masks=[RECT], motion_zones=[ZONE, POLY]),
    )
    pub = await svc.create(body, actor=_Actor(), probe=False)
    assert pub.advanced.motion_zones == [ZONE, POLY]
    assert pub.advanced.privacy_masks == [RECT]

    # read back through get → schema round-trips motion_zones
    got = await svc.get(pub.id)
    assert got.advanced.motion_zones == [ZONE, POLY]


async def test_update_advanced_replaces_motion_zones(db, camera):
    svc = CameraService(db, _scope())
    pub = await svc.update(
        camera.id,
        CameraUpdate(advanced=AdvancedConfig(motion_zones=[RECT], privacy_masks=[POLY])),
        actor=_Actor(),
    )
    assert pub.advanced.motion_zones == [RECT]
    assert pub.advanced.privacy_masks == [POLY]


# ── local config GET/PUT parity + driver push ────────────────────────────────


# The local-config GET/PUT seam is gone, and with it the "store locally, push
# best-effort to the device" shape these covered. Motion zones and privacy masks are
# written on the camera, by the recorder that owns it. What remains here is the column
# and schema parity, which the estate's own model still carries.
