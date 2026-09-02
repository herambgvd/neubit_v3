"""Video-decoder tests (VW-B) — driver request-build + factory + CRUD tenant isolation +
wall push wiring. NO live devices: ``_http.request_strict`` / ``_tcp_reachable`` are
monkeypatched to capture the built request (URL/verb/body) without touching hardware, and
the wall's decoder driver is patched to assert the wall-service hook calls it with the
right channel + rtsp while STILL writing + broadcasting wall state.

``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

import app.vms.drivers._http as http_mod
import app.vms.drivers.decoder_base as decoder_base
import app.vms.drivers.dahua_cpplus_decoder as dahua_mod
import app.vms.drivers.hikvision_decoder as hik_mod
from app.db import Base
from app.vms.drivers.dahua_cpplus_decoder import DahuaCpPlusDecoder
from app.vms.drivers.decoder_base import DecoderCredentials, DecoderResult
from app.vms.drivers.decoder_factory import get_decoder_driver, supported_decoder_brands
from app.vms.drivers.hikvision_decoder import HikvisionDecoder
from app.vms.common.crypto import encrypt_secret
from app.vms.models import Camera, MediaProfile, VideoDecoder
import app.vms.videowall.service as wall_svc_mod
from app.vms.videowall.decoder_schemas import DecoderCreate, DecoderUpdate
from app.vms.videowall.decoder_service import VideoDecoderService
from app.vms.videowall.schemas import MonitorCreate, WallCreate
from app.vms.videowall.service import VideoWallService

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()
CREDS = DecoderCredentials(username="admin", password="pass12", port=80)


class _Actor:
    user_id = uuid.uuid4()


ACTOR = _Actor()


# ── fixtures ──────────────────────────────────────────────────────────────────
@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine):
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s


@pytest.fixture
def scope():
    return Scope(tenant_id=TENANT, is_superadmin=False)


@pytest.fixture
def dec_svc(db, scope):
    return VideoDecoderService(db, scope)


@pytest.fixture
def reachable(monkeypatch):
    """Force the TCP pre-gate open (in each driver module's namespace) so request-build
    runs. The drivers ``from .decoder_base import _tcp_reachable``, so the bound name lives
    in the driver module — patch it there, not on decoder_base."""
    async def _ok(host, port, timeout=2.0):
        return True

    monkeypatch.setattr(hik_mod, "_tcp_reachable", _ok)
    monkeypatch.setattr(dahua_mod, "_tcp_reachable", _ok)


@pytest.fixture
def capture_strict(monkeypatch):
    """Capture every ``_http.request_strict`` (method, url, body) + return 'OK'."""
    calls: list[dict] = []

    async def _req(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        calls.append({"method": method, "url": url, "content": content, "headers": headers})
        return "OK"

    monkeypatch.setattr(http_mod, "request_strict", _req)
    return calls


# ── factory ───────────────────────────────────────────────────────────────────
def test_factory_picks_brand():
    assert isinstance(get_decoder_driver("hikvision"), HikvisionDecoder)
    assert isinstance(get_decoder_driver("hik"), HikvisionDecoder)
    assert isinstance(get_decoder_driver("dahua_cpplus"), DahuaCpPlusDecoder)
    assert isinstance(get_decoder_driver("dahua"), DahuaCpPlusDecoder)
    assert isinstance(get_decoder_driver("cp-plus"), DahuaCpPlusDecoder)


def test_factory_graceful_on_unknown_or_empty():
    assert get_decoder_driver("nope") is None
    assert get_decoder_driver("") is None
    assert get_decoder_driver(None) is None
    assert "hikvision" in supported_decoder_brands()


# ── Hik driver request-build ────────────────────────────────────────────────────
async def test_hik_display_builds_isapi_put(reachable, capture_strict):
    res = await HikvisionDecoder().display("10.0.0.9", CREDS, channel=1, cell=2, rtsp_uri="rtsp://x/y")
    assert res.ok is True
    call = capture_strict[0]
    assert call["method"] == "PUT"
    assert call["url"].endswith("/ISAPI/ContentMgmt/dynamicChannels/1")
    assert "<srcUrl>rtsp://x/y</srcUrl>" in call["content"]
    assert "<window>2</window>" in call["content"]
    assert call["headers"]["Content-Type"] == "application/xml"


async def test_hik_set_layout_builds_window_put(reachable, capture_strict):
    res = await HikvisionDecoder().set_layout("10.0.0.9", CREDS, channel=0, grid=4)
    assert res.ok is True
    call = capture_strict[0]
    assert call["method"] == "PUT"
    assert call["url"].endswith("/ISAPI/System/Video/outputs/channels/0/window")
    assert "<layout>4</layout>" in call["content"]


async def test_hik_set_layout_rejects_bad_grid(reachable, capture_strict):
    res = await HikvisionDecoder().set_layout("10.0.0.9", CREDS, channel=0, grid=7)
    assert res.ok is False and "grid" in res.error
    assert capture_strict == []  # never hit the wire


async def test_hik_clear_builds_empty_srcurl(reachable, capture_strict):
    res = await HikvisionDecoder().clear("10.0.0.9", CREDS, channel=1, cell=3)
    assert res.ok is True
    assert "<srcUrl></srcUrl>" in capture_strict[0]["content"]


async def test_hik_display_graceful_when_unreachable(monkeypatch, capture_strict):
    async def _down(host, port, timeout=2.0):
        return False

    monkeypatch.setattr(hik_mod, "_tcp_reachable", _down)
    res = await HikvisionDecoder().display("10.0.0.9", CREDS, 1, 0, "rtsp://x")
    assert res.ok is False and "unreachable" in res.error
    assert capture_strict == []


# ── Dahua/CP-Plus driver request-build ──────────────────────────────────────────
async def test_dahua_display_builds_makeconnect(reachable, capture_strict):
    res = await DahuaCpPlusDecoder().display("10.0.0.8", CREDS, channel=1, cell=2, rtsp_uri="rtsp://a/b")
    assert res.ok is True
    call = capture_strict[0]
    assert call["method"] == "GET"
    assert "/cgi-bin/decoder.cgi?action=makeConnect" in call["url"]
    assert "channel=102" in call["url"]  # channel*100 + cell = 1*100 + 2
    assert "url=rtsp%3A%2F%2Fa%2Fb" in call["url"]  # rtsp url percent-encoded


async def test_dahua_set_layout_builds_splitmode(reachable, capture_strict):
    res = await DahuaCpPlusDecoder().set_layout("10.0.0.8", CREDS, channel=0, grid=9)
    assert res.ok is True
    assert "SplitMode=9" in capture_strict[0]["url"]


async def test_dahua_clear_builds_closeconnect(reachable, capture_strict):
    res = await DahuaCpPlusDecoder().clear("10.0.0.8", CREDS, channel=1, cell=0)
    assert res.ok is True
    assert "action=closeConnect" in capture_strict[0]["url"]
    assert "channel=100" in capture_strict[0]["url"]


async def test_display_empty_rtsp_is_graceful(reachable, capture_strict):
    res = await DahuaCpPlusDecoder().display("10.0.0.8", CREDS, 1, 0, "")
    assert res.ok is False and capture_strict == []


# ── decoder CRUD + tenant isolation ─────────────────────────────────────────────
async def test_decoder_crud_and_password_encrypted(dec_svc, db):
    created = await dec_svc.create(
        DecoderCreate(name="Wall Dec", brand="hikvision", host="10.0.0.9", port=80,
                      username="admin", password="s3cret", channel_count=4),
        actor=ACTOR,
    )
    assert created.brand == "hikvision" and created.has_password is True
    # Public schema never leaks the password; the stored value is encrypted (enc: prefix).
    row = await db.get(VideoDecoder, created.id)
    assert row.enc_password and row.enc_password.startswith("enc:") and "s3cret" not in row.enc_password

    listed = await dec_svc.list()
    assert listed.total == 1

    upd = await dec_svc.update(created.id, DecoderUpdate(name="Dec-1", port=8000), actor=ACTOR)
    assert upd.name == "Dec-1" and upd.port == 8000

    await dec_svc.delete(created.id)
    assert (await dec_svc.list()).total == 0


async def test_decoder_tenant_isolation(db):
    mine = VideoDecoderService(db, Scope(tenant_id=TENANT, is_superadmin=False))
    theirs = VideoDecoderService(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
    created = await mine.create(
        DecoderCreate(name="D", brand="hikvision", host="10.0.0.9"), actor=ACTOR
    )
    # A foreign tenant cannot read it (clean NotFound → 404).
    with pytest.raises(NotFoundError):
        await theirs.get(created.id)
    # And it does not appear in the foreign tenant's list.
    assert (await theirs.list()).total == 0
    # resolve_driver is also tenant-scoped: foreign tenant → None (no cross-tenant push).
    assert await theirs.resolve_driver(created.id) is None


async def test_decoder_test_probe(dec_svc, monkeypatch):
    created = await dec_svc.create(
        DecoderCreate(name="D", brand="hikvision", host="10.0.0.9", username="admin", password="p"),
        actor=ACTOR,
    )

    async def _probe(self, host, creds):
        return decoder_base.DecoderInfo(reachable=True, manufacturer="Hikvision", model="DS-6900")

    monkeypatch.setattr(HikvisionDecoder, "probe", _probe)
    res = await dec_svc.test(created.id)
    assert res.reachable is True and res.model == "DS-6900"


# ── wall push → decoder wiring ───────────────────────────────────────────────────
async def _make_camera(db, cam_id):
    cam = Camera(id=cam_id, tenant_id=TENANT, name="Cam", brand="onvif", connection_type="onvif",
                 onvif_host="10.0.0.50", onvif_user="admin", onvif_enc_pass=encrypt_secret("p"))
    db.add(cam)
    db.add(MediaProfile(id=str(uuid.uuid4()), tenant_id=TENANT, camera_id=cam_id,
                        name="main", rtsp_path="rtsp://10.0.0.50:554/main"))
    await db.commit()
    return cam


@pytest.fixture
def capture_wall_emit(monkeypatch):
    published: list = []

    async def _emit(tenant_id, wall_id, payload, **kw):
        published.append((tenant_id, wall_id, payload))
        return "subj"

    monkeypatch.setattr(wall_svc_mod, "emit_wall_state", _emit)
    return published


async def test_push_cell_to_decoder_monitor_calls_driver_and_broadcasts(
    db, scope, monkeypatch, capture_wall_emit
):
    cam_id = str(uuid.uuid4())
    await _make_camera(db, cam_id)
    dec = VideoDecoderService(db, scope)
    decoder = await dec.create(
        DecoderCreate(name="D", brand="hikvision", host="10.0.0.9", username="admin", password="p"),
        actor=ACTOR,
    )

    wall_svc = VideoWallService(db, scope)
    wall = await wall_svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await wall_svc.create_monitor(
        wall.id,
        MonitorCreate(name="Dec-Screen", kind="decoder", layout=4,
                      decoder_id=decoder.id, decoder_channel=2),
        actor=ACTOR,
    )

    # Patch the decoder driver's display to capture the call.
    calls: list = []

    async def _display(self, host, creds, channel, cell, rtsp_uri):
        calls.append({"host": host, "channel": channel, "cell": cell, "rtsp": rtsp_uri})
        return DecoderResult(ok=True)

    monkeypatch.setattr(HikvisionDecoder, "display", _display)

    res = await wall_svc.push_cell(wall.id, mon.id, 3, cam_id, actor=ACTOR)

    # Wall state STILL written + broadcast.
    assert res.state == {mon.id: {"3": cam_id}}
    assert len(capture_wall_emit) == 1
    assert capture_wall_emit[0][2]["action"] == "push"

    # Driver invoked with the monitor's decoder channel (2), the cell index (3) + camera RTSP.
    assert len(calls) == 1
    assert calls[0]["host"] == "10.0.0.9"
    assert calls[0]["channel"] == 2
    assert calls[0]["cell"] == 3
    assert calls[0]["rtsp"] == "rtsp://admin:p@10.0.0.50:554/main"


async def test_push_cell_browser_monitor_does_not_touch_decoder(db, scope, monkeypatch, capture_wall_emit):
    cam_id = str(uuid.uuid4())
    await _make_camera(db, cam_id)
    wall_svc = VideoWallService(db, scope)
    wall = await wall_svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await wall_svc.create_monitor(wall.id, MonitorCreate(name="Kiosk", kind="browser"), actor=ACTOR)

    called = {"n": 0}

    async def _display(self, *a, **k):
        called["n"] += 1
        return DecoderResult(ok=True)

    monkeypatch.setattr(HikvisionDecoder, "display", _display)
    await wall_svc.push_cell(wall.id, mon.id, 0, cam_id, actor=ACTOR)
    assert called["n"] == 0  # browser monitor → no decoder push
    assert len(capture_wall_emit) == 1


async def test_push_cell_decoder_failure_does_not_break_wall(db, scope, monkeypatch, capture_wall_emit):
    cam_id = str(uuid.uuid4())
    await _make_camera(db, cam_id)
    dec = VideoDecoderService(db, scope)
    decoder = await dec.create(
        DecoderCreate(name="D", brand="hikvision", host="10.0.0.9", username="admin", password="p"),
        actor=ACTOR,
    )
    wall_svc = VideoWallService(db, scope)
    wall = await wall_svc.create_wall(WallCreate(name="W"), actor=ACTOR)
    mon = await wall_svc.create_monitor(
        wall.id, MonitorCreate(name="Dec", kind="decoder", decoder_id=decoder.id, decoder_channel=1),
        actor=ACTOR,
    )

    async def _boom(self, *a, **k):
        raise RuntimeError("decoder exploded")

    monkeypatch.setattr(HikvisionDecoder, "display", _boom)
    # Must NOT raise — wall state + broadcast still succeed.
    res = await wall_svc.push_cell(wall.id, mon.id, 0, cam_id, actor=ACTOR)
    assert res.state == {mon.id: {"0": cam_id}}
    assert len(capture_wall_emit) == 1
