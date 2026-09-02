"""Stream codec policy tests (G8 — zero-transcode live view).

Three layers, no live devices:

  * Driver set-codec / probe request-build per brand — the ``_http`` helpers (Hik ISAPI,
    Dahua/CP-Plus CGI) are monkeypatched to capture the request the driver builds, so the
    endpoint + codec-value construction run for real. ONVIF uses a hand-built fake camera
    (Media2 SetVideoEncoderConfiguration capture). Graceful-unsupported is asserted for
    Lumina (no set surface) + the no-SDK ONVIF path.
  * The policy gate — ``VE_ENFORCE_H264_WEB`` default-on + ``needs_web_codec_enforcement``.
  * The onboard hook + apply — an in-memory SQLite DB seeded across two tenants; a fake
    driver so we assert the hook pushes when policy on + sub is H265, SKIPS when already
    H264 / policy off, and the bulk fan-out returns per-camera results with tenant isolation.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

import app.vms.drivers._http as http_mod
from app.db import Base
from app.vms.common import stream_policy
from app.vms.common.crypto import encrypt_secret
from app.vms.drivers import (
    CpPlusDriver,
    Credentials,
    FleetOpResult,
    HikvisionDriver,
    LuminaDriver,
    OnvifDriver,
    StreamCodecProfile,
)
from app.vms.models import Camera

CREDS = Credentials(username="admin", password="pass12", port=80, rtsp_port=554)

TENANT = uuid.uuid4()
OTHER = uuid.uuid4()


def _scope(t=TENANT):
    return Scope(tenant_id=t, is_superadmin=False)


# ── Hikvision (ISAPI) set/get codec request-build ─────────────────────────────────
_HIK_SUB_H265 = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<StreamingChannel xmlns="http://www.hikvision.com/ver20/XMLSchema">'
    "<id>102</id><Video><videoCodecType>H.265</videoCodecType></Video></StreamingChannel>"
)
_HIK_SUB_H264 = _HIK_SUB_H265.replace("H.265", "H.264")


async def test_hik_set_stream_codec_rewrites_sub_channel(monkeypatch):
    captured = {}

    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return _HIK_SUB_H265 if url.endswith("/Streaming/channels/102") else None

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured.update(method=method, url=url, content=content)
        return "<ResponseStatus/>"

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().set_stream_codec("10.0.0.5", CREDS, profile="sub", codec="h264")
    assert res.ok is True and res.data["codec"] == "H264"
    # Targets the SUB channel id (ch1 sub = 102) and rewrites the codec value to H.264.
    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/ISAPI/Streaming/channels/102")
    assert "<videoCodecType>H.264</videoCodecType>" in captured["content"]


async def test_hik_set_stream_codec_skips_when_already_h264(monkeypatch):
    puts = []

    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return _HIK_SUB_H264 if url.endswith("/Streaming/channels/102") else None

    async def _strict(*a, **k):
        puts.append(a)
        return "<ResponseStatus/>"

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().set_stream_codec("10.0.0.5", CREDS, profile="sub", codec="h264")
    assert res.ok is True and res.data.get("already") is True
    assert puts == []  # no PUT issued — device already compliant


async def test_hik_set_stream_codec_device_reject_graceful(monkeypatch):
    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return _HIK_SUB_H265

    async def _strict(*a, **k):
        raise http_mod.BrandHTTPError(403, "forbidden")

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await HikvisionDriver().set_stream_codec("10.0.0.5", CREDS, profile="sub", codec="h264")
    assert res.ok is False and res.supported is True  # ran but device rejected


async def test_hik_get_stream_codecs_reads_main_and_sub(monkeypatch):
    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        if url.endswith("/channels/101"):
            return _HIK_SUB_H265.replace("102", "101")  # main = H265
        if url.endswith("/channels/102"):
            return _HIK_SUB_H264  # sub = H264
        return None

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    codecs = await HikvisionDriver().get_stream_codecs("10.0.0.5", CREDS)
    by_role = {c.role: c.codec for c in codecs}
    assert by_role == {"main": "H265", "sub": "H264"}


# ── CP-Plus / Dahua (CGI) set/get codec request-build ─────────────────────────────
_DAHUA_ENCODE_H265_SUB = (
    "table.Encode[0].MainFormat[0].Video.Compression=H.265\n"
    "table.Encode[0].ExtraFormat[0].Video.Compression=H.265\n"
)


async def test_cpplus_set_stream_codec_hits_extraformat(monkeypatch):
    captured = {}

    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return _DAHUA_ENCODE_H265_SUB if "getConfig&name=Encode" in url else None

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return "OK"

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await CpPlusDriver().set_stream_codec("10.0.0.7", CREDS, profile="sub", codec="h264")
    assert res.ok is True and res.data["codec"] == "H264"
    assert "action=setConfig" in captured["url"]
    assert "Encode[0].ExtraFormat[0].Video.Compression=H.264" in captured["url"]


async def test_cpplus_set_stream_codec_skips_when_already_h264(monkeypatch):
    strict_calls = []

    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return (
            "table.Encode[0].MainFormat[0].Video.Compression=H.265\n"
            "table.Encode[0].ExtraFormat[0].Video.Compression=H.264\n"
        )

    async def _strict(*a, **k):
        strict_calls.append(a)
        return "OK"

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    monkeypatch.setattr(http_mod, "request_strict", _strict)
    res = await CpPlusDriver().set_stream_codec("10.0.0.7", CREDS, profile="sub", codec="h264")
    assert res.ok is True and res.data.get("already") is True
    assert strict_calls == []


async def test_cpplus_get_stream_codecs(monkeypatch):
    async def _get_text(url, user, password, *, verify_tls=False, timeout=8.0):
        return _DAHUA_ENCODE_H265_SUB

    monkeypatch.setattr(http_mod, "get_text", _get_text)
    codecs = await CpPlusDriver().get_stream_codecs("10.0.0.7", CREDS)
    by_role = {c.role: c.codec for c in codecs}
    assert by_role == {"main": "H265", "sub": "H265"}


# ── Lumina inherits the base default → graceful unsupported for set ────────────────
async def test_lumina_set_stream_codec_unsupported():
    res = await LuminaDriver().set_stream_codec("10.0.0.9", CREDS, profile="sub", codec="h264")
    assert res.ok is False and res.supported is False


# ── ONVIF SDK-backed set/get via a hand-built fake camera ─────────────────────────
class _FakeEnc:
    def __init__(self, encoding, w, h, token="enc0"):
        from types import SimpleNamespace as NS

        self.Encoding = encoding
        self.Resolution = NS(Width=w, Height=h)
        self.token = token


class _FakeProfile:
    def __init__(self, token, enc):
        self.token = token
        self.VideoEncoderConfiguration = enc


class _FakeMedia2:
    def __init__(self, profiles):
        self._profiles = profiles
        self.set_calls = []

    def GetProfiles(self, _req=None):
        return self._profiles

    def SetVideoEncoderConfiguration(self, req):
        self.set_calls.append(req)


class _FakeDeviceMgmt:
    def GetServices(self, _req=None):
        from types import SimpleNamespace as NS

        return [NS(Namespace="http://www.onvif.org/ver20/media/wsdl", XAddr="http://x/media2")]


class _FakeOnvifCam:
    """Media2-capable fake with main=H265, sub=H265 profiles + a set-capture media2."""

    def __init__(self, host, port, user, password, *a, **k):
        main = _FakeProfile("prof_main", _FakeEnc("H265", 1920, 1080, "enc_main"))
        sub = _FakeProfile("prof_sub", _FakeEnc("H265", 640, 480, "enc_sub"))
        self._media2 = _FakeMedia2([main, sub])
        self.devicemgmt = _FakeDeviceMgmt()

    def create_media2_service(self):
        return self._media2

    def create_media_service(self):
        return self._media2


def _patch_onvif(monkeypatch, cam_cls=_FakeOnvifCam):
    import app.vms.drivers.onvif as onvif_mod

    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", True)
    monkeypatch.setattr(onvif_mod, "ONVIFCamera", cam_cls)

    async def _reachable(host, port, timeout=2.0):
        return True

    monkeypatch.setattr(onvif_mod, "_tcp_reachable", _reachable)


async def test_onvif_set_stream_codec_media2(monkeypatch):
    _patch_onvif(monkeypatch)
    d = OnvifDriver()
    res = await d.set_stream_codec("10.0.0.1", CREDS, profile="sub", codec="h264")
    assert res.ok is True and res.data["codec"] == "H264"


async def test_onvif_get_stream_codecs_media2(monkeypatch):
    _patch_onvif(monkeypatch)
    codecs = await OnvifDriver().get_stream_codecs("10.0.0.1", CREDS)
    by_role = {c.role: c.codec for c in codecs}
    assert by_role.get("main") == "H265" and by_role.get("sub") == "H265"


async def test_onvif_set_stream_codec_no_sdk_graceful(monkeypatch):
    import app.vms.drivers.onvif as onvif_mod

    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", False)
    res = await OnvifDriver().set_stream_codec("10.0.0.1", CREDS, profile="sub", codec="h264")
    assert res.ok is False and res.supported is False


# ── policy gate ───────────────────────────────────────────────────────────────────
def test_policy_default_on(monkeypatch):
    monkeypatch.delenv("VE_ENFORCE_H264_WEB", raising=False)
    assert stream_policy.enforce_h264_web() is True


def test_policy_off(monkeypatch):
    monkeypatch.setenv("VE_ENFORCE_H264_WEB", "false")
    assert stream_policy.enforce_h264_web() is False


def test_needs_enforcement(monkeypatch):
    monkeypatch.setenv("VE_ENFORCE_H264_WEB", "true")
    assert stream_policy.needs_web_codec_enforcement("H265") is True
    assert stream_policy.needs_web_codec_enforcement("H.265") is True
    assert stream_policy.needs_web_codec_enforcement("H264") is False
    assert stream_policy.needs_web_codec_enforcement(None) is False
    monkeypatch.setenv("VE_ENFORCE_H264_WEB", "false")
    assert stream_policy.needs_web_codec_enforcement("H265") is False


# ── service apply + onboard hook (in-memory DB + fake driver) ─────────────────────
@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


def _cam(cid, tenant, host="10.0.0.5", brand="hikvision", sub_codec="H265", name=None):
    return Camera(
        id=cid, tenant_id=tenant, name=name or cid, connection_type="onvif", status="online",
        brand=brand, onvif_host=host, onvif_port=80, onvif_user="admin",
        onvif_enc_pass=encrypt_secret("pass12"), network_info={"ip": host},
        sub_stream_codec=sub_codec,
    )


@pytest_asyncio.fixture
async def seeded(db):
    db.add(_cam("cam-h265", TENANT, name="H265 Cam", sub_codec="H265"))
    db.add(_cam("cam-h264", TENANT, name="H264 Cam", sub_codec="H264"))
    db.add(_cam("cam-other", OTHER, name="Foreign", sub_codec="H265"))
    await db.commit()


class _FakeDriver:
    """Records set_stream_codec calls; probe returns a configurable sub codec."""

    calls: list = []
    probe_sub = "H265"

    def __init__(self, brand="hikvision"):
        self.brand = brand

    async def get_stream_codecs(self, host, creds):
        return [
            StreamCodecProfile(role="main", codec="H265"),
            StreamCodecProfile(role="sub", codec=_FakeDriver.probe_sub),
        ]

    async def set_stream_codec(self, host, creds, *, profile="sub", codec="h264"):
        _FakeDriver.calls.append((host, profile, codec))
        return FleetOpResult(ok=True, detail="set to h264", data={"codec": "H264", "role": profile})

    async def aclose(self):
        return None


def _patch_camera_driver(monkeypatch, probe_sub="H265"):
    _FakeDriver.calls = []
    _FakeDriver.probe_sub = probe_sub
    monkeypatch.setattr("app.vms.cameras.service.get_driver", lambda brand: _FakeDriver(brand))


async def test_apply_stream_policy_pushes_h265_sub(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    _patch_camera_driver(monkeypatch, probe_sub="H265")
    svc = CameraService(db, _scope())
    res = await svc.apply_stream_policy("cam-h265")
    assert res["ok"] is True and res["status"] == "applied"
    assert _FakeDriver.calls == [("10.0.0.5", "sub", "h264")]
    row = await db.get(Camera, "cam-h265")
    assert row.sub_stream_codec == "H264" and row.web_codec_enforced_at is not None


async def test_apply_stream_policy_skips_when_already_h264(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    _patch_camera_driver(monkeypatch, probe_sub="H264")
    svc = CameraService(db, _scope())
    res = await svc.apply_stream_policy("cam-h264")
    assert res["ok"] is True and res["status"] == "already_h264"
    assert _FakeDriver.calls == []  # no device push — already compliant


async def test_onboard_hook_pushes_when_policy_on_and_sub_h265(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    monkeypatch.setenv("VE_ENFORCE_H264_WEB", "true")
    _patch_camera_driver(monkeypatch, probe_sub="H265")
    # Point the hook's fresh-session at THIS in-memory session's factory.
    monkeypatch.setattr(
        "app.db.get_sessionmaker",
        lambda: async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False),
    )
    svc = CameraService(db, _scope())
    await svc._maybe_enforce_web_codec("cam-h265")
    assert _FakeDriver.calls == [("10.0.0.5", "sub", "h264")]


async def test_onboard_hook_skips_when_policy_off(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    monkeypatch.setenv("VE_ENFORCE_H264_WEB", "false")
    _patch_camera_driver(monkeypatch, probe_sub="H265")
    svc = CameraService(db, _scope())
    await svc._maybe_enforce_web_codec("cam-h265")
    assert _FakeDriver.calls == []  # policy off → no push


async def test_onboard_hook_skips_when_sub_already_h264(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    monkeypatch.setenv("VE_ENFORCE_H264_WEB", "true")
    _patch_camera_driver(monkeypatch, probe_sub="H264")
    svc = CameraService(db, _scope())
    # cam-h264 already has sub_stream_codec=H264 → gate short-circuits, no session/driver.
    await svc._maybe_enforce_web_codec("cam-h264")
    assert _FakeDriver.calls == []


async def test_bulk_apply_stream_policy_fans_out(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    _patch_camera_driver(monkeypatch, probe_sub="H265")
    svc = CameraService(db, _scope())
    res = await svc.bulk_apply_stream_policy(["cam-h265", "cam-h264"])
    assert res["total"] == 2 and res["succeeded"] == 2
    by_id = {i["camera_id"]: i for i in res["items"]}
    # h265 sub is pushed (probe returns H265); h264-seeded probe also returns H265 here so
    # both get pushed — assert both ok + the per-camera envelope shape.
    assert by_id["cam-h265"]["ok"] is True
    assert set(by_id) == {"cam-h265", "cam-h264"}


async def test_bulk_apply_stream_policy_tenant_isolation(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    _patch_camera_driver(monkeypatch, probe_sub="H265")
    svc = CameraService(db, _scope())
    res = await svc.bulk_apply_stream_policy(["cam-h265", "cam-other"])
    # Foreign-tenant camera drops out entirely.
    assert res["total"] == 1
    assert {i["camera_id"] for i in res["items"]} == {"cam-h265"}
