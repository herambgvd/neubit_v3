"""LuminaDriver tests — v2 HTTP-API port: URL/auth/parse against fabricated fixtures.

Lumina's REST surface (``/api/v1/system/info``, ``/media/profiles``, ``/ptz/capabilities``,
``/media/snapshot``, ``/ptz/control``) is stubbed via a fake httpx transport, so the
driver's real request construction + JSON parsing (ported from neubit_v2's Lumina plugin)
run without a device.
"""

from __future__ import annotations

import httpx

from app.vms.drivers import Credentials, LuminaDriver, OnvifDriver, PtzCommand
from app.vms.drivers.base import DriverError

CREDS = Credentials(username="admin", password="lum!na", port=8080, rtsp_port=554)


def _mock_transport(monkeypatch, routes: dict, *, post_capture: dict | None = None):
    """Patch httpx.AsyncClient with a MockTransport dispatching by URL path substring.

    ``routes`` maps a path-substring → (status, json_or_bytes). POST bodies are captured
    into ``post_capture`` when provided.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and post_capture is not None:
            post_capture["url"] = str(request.url)
            try:
                post_capture["json"] = __import__("json").loads(request.content or b"{}")
            except Exception:
                post_capture["json"] = None
        for needle, (status, payload) in routes.items():
            if needle in str(request.url):
                if isinstance(payload, (bytes, bytearray)):
                    return httpx.Response(status, content=payload)
                return httpx.Response(status, json=payload)
        return httpx.Response(404, json={})

    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        kwargs.pop("verify", None)
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)


SYSTEM_INFO = {
    "manufacturer": "Lumina",
    "model": "LM-IPC-4MP",
    "firmware_version": "1.8.2",
    "serial_number": "LUM-99887766",
    "mac_address": "b0:c5:54:aa:bb:cc",
    "channels": 1,
}

MEDIA_PROFILES = {
    "profiles": [
        {"name": "Main", "token": "prof-main", "stream_type": "main", "resolution": "2560x1440",
         "codec": "h265", "fps": 25, "bitrate": 4096, "rtsp_url": "rtsp://cam.lan:554/live/main", "audio": True},
        {"name": "Sub", "token": "prof-sub", "stream_type": "sub", "resolution": "640x480",
         "codec": "h264", "fps": 15, "rtsp_url": "rtsp://cam.lan:554/live/sub"},
    ]
}

PTZ_CAPS = {"supported": True, "presets": True, "preset_count": 8, "absolute": True, "continuous": True}


def test_lumina_is_not_onvif_subclass():
    assert not isinstance(LuminaDriver(), OnvifDriver)


# ── probe (v2 test_connection + /system/info) ────────────────────────────────────
async def test_probe_parses_system_info(monkeypatch):
    _mock_transport(monkeypatch, {"/api/v1/system/info": (200, SYSTEM_INFO)})
    info = await LuminaDriver().probe("10.0.0.9", CREDS)
    assert info.reachable is True
    assert info.manufacturer == "Lumina" and info.model == "LM-IPC-4MP"
    assert info.serial_number == "LUM-99887766"
    assert info.firmware == "1.8.2"
    assert info.mac == "b0:c5:54:aa:bb:cc"


async def test_probe_unreachable_is_graceful(monkeypatch):
    _mock_transport(monkeypatch, {"/api/v1/system/info": (500, {})})
    info = await LuminaDriver().probe("10.0.0.9", CREDS)
    assert info.reachable is False and info.error


# ── capabilities + channels + stream uris (v2 fetch_capabilities) ────────────────
async def test_get_capabilities_and_channels(monkeypatch):
    _mock_transport(
        monkeypatch,
        {
            "/api/v1/system/info": (200, SYSTEM_INFO),
            "/api/v1/media/profiles": (200, MEDIA_PROFILES),
            "/api/v1/ptz/capabilities": (200, PTZ_CAPS),
        },
    )
    d = LuminaDriver()
    caps = await d.get_capabilities("10.0.0.9", CREDS)
    assert caps.ptz is True
    assert caps.audio is True  # main profile has audio

    channels = await d.enumerate_channels("10.0.0.9", CREDS)
    assert len(channels) == 1
    ch = channels[0]
    assert ch.main.codec == "H265" and ch.main.resolution == "2560x1440" and ch.main.fps == 25
    # device rtsp_url had no creds → driver injects percent-encoded creds.
    assert ch.main.stream_url == "rtsp://admin:lum%21na@cam.lan:554/live/main"
    assert ch.sub.stream_url == "rtsp://admin:lum%21na@cam.lan:554/live/sub"
    assert ch.ptz_capable is True

    uris = await d.get_stream_uris("10.0.0.9", CREDS)
    assert uris.main == "rtsp://admin:lum%21na@cam.lan:554/live/main" and uris.codec == "H265"


async def test_stream_uri_injects_creds_when_device_url_lacks_them(monkeypatch):
    profiles = {"profiles": [{"name": "Main", "stream_type": "main", "rtsp_url": "rtsp://cam.lan:554/live/main"}]}
    _mock_transport(
        monkeypatch,
        {"/api/v1/system/info": (200, SYSTEM_INFO), "/api/v1/media/profiles": (200, profiles), "/ptz/capabilities": (200, {})},
    )
    uris = await LuminaDriver().get_stream_uris("10.0.0.9", CREDS)
    # rtsp_url had no creds → driver injects percent-encoded creds.
    assert uris.main == "rtsp://admin:lum%21na@cam.lan:554/live/main"


# ── snapshot (v2 plugin.snapshot) ────────────────────────────────────────────────
async def test_get_snapshot(monkeypatch):
    _mock_transport(monkeypatch, {"/api/v1/media/snapshot": (200, b"\xff\xd8jpegbytes")})
    data = await LuminaDriver().get_snapshot("10.0.0.9", CREDS, profile="1")
    assert data.startswith(b"\xff\xd8")


async def test_get_snapshot_graceful(monkeypatch):
    _mock_transport(monkeypatch, {"/api/v1/media/snapshot": (404, {})})
    assert await LuminaDriver().get_snapshot("10.0.0.9", CREDS) is None


# ── PTZ (v2 plugin.ptz — POST /api/v1/ptz/control) ───────────────────────────────
async def test_ptz_continuous_posts_control(monkeypatch):
    cap: dict = {}
    _mock_transport(monkeypatch, {"/api/v1/ptz/control": (200, {"result": "ok"})}, post_capture=cap)
    await LuminaDriver().ptz("10.0.0.9", CREDS, PtzCommand(action="continuous", pan=0.5, tilt=-0.3, speed=0.8, profile_token="2"))
    assert cap["url"].endswith("/api/v1/ptz/control")
    assert cap["json"]["action"] == "continuous_move"  # mapped from driver action
    assert cap["json"]["channel"] == 2
    assert cap["json"]["pan"] == 0.5 and cap["json"]["tilt"] == -0.3


async def test_ptz_goto_preset_maps(monkeypatch):
    cap: dict = {}
    _mock_transport(monkeypatch, {"/api/v1/ptz/control": (200, {})}, post_capture=cap)
    await LuminaDriver().ptz("10.0.0.9", CREDS, PtzCommand(action="goto_preset", preset_token="3"))
    assert cap["json"]["action"] == "preset_goto" and cap["json"]["preset_token"] == "3"


async def test_ptz_unsupported_action_raises(monkeypatch):
    _mock_transport(monkeypatch, {})
    try:
        await LuminaDriver().ptz("10.0.0.9", CREDS, PtzCommand(action="warp"))
        assert False, "expected DriverError"
    except DriverError:
        pass


async def test_ptz_http_error_raises(monkeypatch):
    _mock_transport(monkeypatch, {"/api/v1/ptz/control": (500, {"error": "boom"})})
    try:
        await LuminaDriver().ptz("10.0.0.9", CREDS, PtzCommand(action="stop"))
        assert False, "expected DriverError"
    except DriverError:
        pass


# ── configure (v2 /API/ChannelConfig/Color) ──────────────────────────────────────
async def test_configure_imaging_read(monkeypatch):
    cap: dict = {}
    _mock_transport(
        monkeypatch,
        {"/API/ChannelConfig/Color/Get": (200, {"result": "success", "data": {"brightness": 60}})},
        post_capture=cap,
    )
    result = await LuminaDriver().configure("10.0.0.9", CREDS, "imaging", {})
    assert result["data"]["brightness"] == 60
    assert cap["json"]["data"]["channel"] == "CH1"


async def test_configure_unsupported_section_raises(monkeypatch):
    _mock_transport(monkeypatch, {})
    try:
        await LuminaDriver().configure("10.0.0.9", CREDS, "nonsense", {})
        assert False, "expected DriverError"
    except DriverError:
        pass


# ── event topic map (device motion only) ─────────────────────────────────────────
def test_event_topic_map_motion_only():
    m = LuminaDriver().event_topic_map()
    assert m["motion"] == ("motion_detected", "alarm", "Motion detected")
    # AI-analytics event types are OUT of VMS scope — must NOT appear.
    for ai in ("frs", "lp", "fd", "sod", "lcd", "face", "license_plate"):
        assert ai not in m
