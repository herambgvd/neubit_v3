"""HikvisionDriver tests — ISAPI URL construction + XML parsing against fixtures.

The ``_http`` GET helpers are monkeypatched to return fabricated ISAPI XML (or None
for unreachable), so the driver's endpoint construction + XML parsing run for real
without touching a device.
"""

from __future__ import annotations

import app.vms.drivers._http as http_mod
from app.vms.drivers import Credentials, HikvisionDriver, PtzCommand
from app.vms.drivers.base import DriverError
from app.vms.drivers.hikvision import _rtsp_channel_id, _rtsp_url

from . import fixtures as fx

CREDS = Credentials(username="admin", password="pass12", port=80, rtsp_port=554)


def _route_get_text(mapping, default=None):
    """Return a fake get_text that dispatches by substring match on the URL."""

    async def _get(url, user, password, *, verify_tls=False, timeout=8.0):
        for needle, body in mapping.items():
            if needle in url:
                return body
        return default

    return _get


# ── URL construction ─────────────────────────────────────────────────────────────
def test_rtsp_channel_id_math():
    assert _rtsp_channel_id(1, 1) == 101  # ch1 main
    assert _rtsp_channel_id(1, 2) == 102  # ch1 sub
    assert _rtsp_channel_id(3, 1) == 301  # ch3 main


def test_rtsp_url_injects_creds():
    url = _rtsp_url("10.0.0.5", CREDS, 2, 1)
    assert url == "rtsp://admin:pass12@10.0.0.5:554/Streaming/Channels/201"


# ── probe ────────────────────────────────────────────────────────────────────────
async def test_probe_parses_device_info(monkeypatch):
    monkeypatch.setattr(http_mod, "get_text", _route_get_text({"deviceInfo": fx.HIK_DEVICE_INFO}))
    info = await HikvisionDriver().probe("10.0.0.5", CREDS)
    assert info.reachable is True
    assert info.manufacturer == "Hikvision"
    assert info.model == "DS-7616NI-K2"
    assert info.serial_number == "DS-7616NI-K20123456789"
    assert info.mac == "44:19:b6:11:22:33"
    assert info.firmware == "V4.30.005"
    assert info.raw.get("device_type") == "NVR"


async def test_probe_unreachable_is_graceful(monkeypatch):
    monkeypatch.setattr(http_mod, "get_text", _route_get_text({}, default=None))
    info = await HikvisionDriver().probe("10.0.0.5", CREDS)
    assert info.reachable is False and info.error


# ── channel enumeration (NVR InputProxy) ─────────────────────────────────────────
async def test_enumerate_channels_nvr_input_proxy(monkeypatch):
    monkeypatch.setattr(
        http_mod,
        "get_text",
        _route_get_text({"InputProxy/channels": fx.HIK_INPUT_PROXY_CHANNELS}),
    )
    channels = await HikvisionDriver().enumerate_channels("10.0.0.5", CREDS)
    assert len(channels) == 2
    assert channels[0].name == "Front Door" and channels[0].channel_number == 1
    assert channels[0].main.stream_url == "rtsp://admin:pass12@10.0.0.5:554/Streaming/Channels/101"
    assert channels[0].sub.stream_url.endswith("/102")
    assert channels[1].name == "Parking"


# ── channel enumeration (standalone camera Streaming/channels) ───────────────────
async def test_enumerate_channels_camera_streaming(monkeypatch):
    # InputProxy returns None (not an NVR); Streaming/channels returns the camera list.
    monkeypatch.setattr(
        http_mod,
        "get_text",
        _route_get_text({"Streaming/channels": fx.HIK_STREAMING_CHANNELS}),
    )
    channels = await HikvisionDriver().enumerate_channels("10.0.0.6", CREDS)
    assert len(channels) == 1
    ch = channels[0]
    assert ch.channel_number == 1
    assert ch.main.resolution == "1920x1080" and ch.main.codec == "H.264"
    assert ch.main.fps == 25  # 2500 centi-fps → 25
    assert ch.sub.resolution == "640x480"


# ── stream URIs / snapshot ───────────────────────────────────────────────────────
async def test_get_stream_uris_construction():
    uris = await HikvisionDriver().get_stream_uris("10.0.0.5", CREDS, profile="4")
    assert uris.main.endswith("/Streaming/Channels/401")
    assert uris.sub.endswith("/Streaming/Channels/402")


async def test_get_snapshot_calls_isapi_picture(monkeypatch):
    captured = {}

    async def _get_bytes(url, user, password, *, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return b"\xff\xd8jpegdata"

    monkeypatch.setattr(http_mod, "get_bytes", _get_bytes)
    data = await HikvisionDriver().get_snapshot("10.0.0.5", CREDS, profile="2")
    assert data.startswith(b"\xff\xd8")
    assert captured["url"].endswith("/ISAPI/Streaming/channels/201/picture")


# ── capabilities ─────────────────────────────────────────────────────────────────
async def test_get_capabilities(monkeypatch):
    monkeypatch.setattr(
        http_mod,
        "get_text",
        _route_get_text({"System/capabilities": fx.HIK_CAPABILITIES, "PTZCtrl/channels/1/status": "<PTZStatus/>"}),
    )
    caps = await HikvisionDriver().get_capabilities("10.0.0.5", CREDS)
    assert caps.ptz is True and caps.imaging is True and caps.events is True
    assert caps.io is True and caps.recording_search is True


# ── PTZ get_presets parsing ──────────────────────────────────────────────────────
async def test_ptz_get_presets(monkeypatch):
    monkeypatch.setattr(http_mod, "get_text", _route_get_text({"presets": fx.HIK_PRESETS}))
    presets = await HikvisionDriver().ptz("10.0.0.5", CREDS, PtzCommand(action="get_presets"))
    assert {"token": "1", "name": "Entrance"} in presets
    assert {"token": "2", "name": "Yard"} in presets


# ── PTZ write (continuous) issues a strict digest PUT ────────────────────────────
async def test_ptz_continuous_issues_put(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured.update(method=method, url=url, content=content)
        return "<ResponseStatus/>"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    await HikvisionDriver().ptz("10.0.0.5", CREDS, PtzCommand(action="continuous", pan=0.5, tilt=-0.25, zoom=0.0, profile_token="2"))
    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/ISAPI/PTZCtrl/channels/2/continuous")
    assert "<pan>50</pan>" in captured["content"] and "<tilt>-25</tilt>" in captured["content"]


async def test_ptz_failure_raises_driver_error(monkeypatch):
    async def _strict(*a, **k):
        raise http_mod.BrandHTTPError(500, "boom")

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    try:
        await HikvisionDriver().ptz("10.0.0.5", CREDS, PtzCommand(action="continuous", pan=1.0))
        assert False, "expected DriverError"
    except DriverError:
        pass


# ── NVR footage (P4-B) — graceful empty when unreachable (no monkeypatch) ─────────
# The full ISAPI ContentMgmt/search + playback-URI construction are exercised in
# ``test_nvr_footage.py`` with fabricated ISAPI fixtures; here we only assert the
# unreachable-host path degrades to [] (the search POST fails → None → []).
async def test_search_recordings_unreachable_is_empty():
    assert await HikvisionDriver().search_recordings("10.0.0.5", CREDS) == []
