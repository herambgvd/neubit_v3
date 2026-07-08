"""CpPlusDriver tests — Dahua CGI URL construction + key=value parsing against fixtures.

The ``_http`` GET helpers are monkeypatched to return fabricated Dahua CGI ``key=value``
bodies, so the driver's endpoint construction + CGI parsing run without a device.
"""

from __future__ import annotations

import app.vms.drivers._http as http_mod
from app.vms.drivers import CpPlusDriver, Credentials, PtzCommand
from app.vms.drivers.base import DriverError
from app.vms.drivers.cpplus import _rtsp_url

from . import fixtures as fx

CREDS = Credentials(username="admin", password="dah@ua", port=80, rtsp_port=554)


def _route_get_text(mapping, default=None):
    async def _get(url, user, password, *, verify_tls=False, timeout=8.0):
        for needle, body in mapping.items():
            if needle in url:
                return body
        return default

    return _get


# ── URL construction ─────────────────────────────────────────────────────────────
def test_rtsp_url_dahua_realmonitor():
    url = _rtsp_url("10.0.0.7", CREDS, 3, 0)
    assert url == "rtsp://admin:dah%40ua@10.0.0.7:554/cam/realmonitor?channel=3&subtype=0"
    assert _rtsp_url("10.0.0.7", CREDS, 3, 1).endswith("subtype=1")  # sub stream


# ── probe ────────────────────────────────────────────────────────────────────────
async def test_probe_parses_cgi_system_info(monkeypatch):
    monkeypatch.setattr(
        http_mod,
        "get_text",
        _route_get_text(
            {
                "getSystemInfo": fx.CPPLUS_SYSTEM_INFO,
                "getMachineName": fx.CPPLUS_MACHINE_NAME,
                "getSoftwareVersion": fx.CPPLUS_SOFTWARE_VERSION,
                "getProductDefinition": fx.CPPLUS_PRODUCT_DEFINITION,
            }
        ),
    )
    info = await CpPlusDriver().probe("10.0.0.7", CREDS)
    assert info.reachable is True
    assert info.manufacturer == "CP-Plus"
    assert info.model == "NVR5216-16P-4KS2E"
    assert info.serial_number == "5J0ABC123456789"
    assert info.firmware.startswith("4.001")
    assert info.channel_count == 16  # MaxRemoteInputChannels
    assert info.raw.get("machine_name") == "CP-Plus-NVR-Reception"


async def test_probe_unreachable_is_graceful(monkeypatch):
    monkeypatch.setattr(http_mod, "get_text", _route_get_text({}, default=None))
    info = await CpPlusDriver().probe("10.0.0.7", CREDS)
    assert info.reachable is False and info.error


# ── channel enumeration (NVR product definition) ─────────────────────────────────
async def test_enumerate_channels_nvr(monkeypatch):
    monkeypatch.setattr(
        http_mod, "get_text", _route_get_text({"getProductDefinition": fx.CPPLUS_PRODUCT_DEFINITION})
    )
    channels = await CpPlusDriver().enumerate_channels("10.0.0.7", CREDS)
    assert len(channels) == 16
    assert channels[0].channel_number == 1
    assert channels[0].main.stream_url.endswith("channel=1&subtype=0")
    assert channels[0].sub.stream_url.endswith("channel=1&subtype=1")
    assert channels[0].snapshot_url.endswith("/cgi-bin/snapshot.cgi?channel=1")
    assert channels[15].channel_number == 16


async def test_enumerate_channels_single_camera(monkeypatch):
    # Camera product-definition reports 0 remote inputs → falls back to probe → 1 channel.
    def _router(url, user, password, *, verify_tls=False, timeout=8.0):
        return None

    async def _get(url, user, password, *, verify_tls=False, timeout=8.0):
        if "getProductDefinition" in url:
            return fx.CPPLUS_PRODUCT_DEFINITION_CAMERA
        if "getSystemInfo" in url:
            return fx.CPPLUS_SYSTEM_INFO
        return None

    monkeypatch.setattr(http_mod, "get_text", _get)
    channels = await CpPlusDriver().enumerate_channels("10.0.0.8", CREDS)
    assert len(channels) == 1  # 0 remote inputs, reachable → single camera


# ── stream URIs / snapshot ───────────────────────────────────────────────────────
async def test_get_stream_uris():
    uris = await CpPlusDriver().get_stream_uris("10.0.0.7", CREDS, profile="5")
    assert uris.main.endswith("channel=5&subtype=0")
    assert uris.sub.endswith("channel=5&subtype=1")


async def test_get_snapshot(monkeypatch):
    captured = {}

    async def _get_bytes(url, user, password, *, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return b"\xff\xd8jpeg"

    monkeypatch.setattr(http_mod, "get_bytes", _get_bytes)
    data = await CpPlusDriver().get_snapshot("10.0.0.7", CREDS, profile="4")
    assert data.startswith(b"\xff\xd8")
    assert captured["url"].endswith("/cgi-bin/snapshot.cgi?channel=4")


# ── capabilities ─────────────────────────────────────────────────────────────────
async def test_get_capabilities(monkeypatch):
    monkeypatch.setattr(
        http_mod,
        "get_text",
        _route_get_text({"getCurrentProtocolCaps": fx.CPPLUS_PTZ_PROTOCOL_CAPS, "encode.cgi": "table.Caps.Audio=true"}),
    )
    caps = await CpPlusDriver().get_capabilities("10.0.0.7", CREDS)
    assert caps.ptz is True
    assert caps.audio is True
    assert caps.recording_search is True


# ── PTZ (dominant-axis → Dahua code) ─────────────────────────────────────────────
async def test_ptz_continuous_maps_dominant_axis(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return "OK"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    # tilt is dominant + positive → "Up".
    await CpPlusDriver().ptz("10.0.0.7", CREDS, PtzCommand(action="continuous", pan=0.1, tilt=0.9, profile_token="2"))
    assert "code=Up" in captured["url"] and "channel=2" in captured["url"]


async def test_ptz_goto_preset(monkeypatch):
    captured = {}

    async def _strict(method, url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured["url"] = url
        return "OK"

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    await CpPlusDriver().ptz("10.0.0.7", CREDS, PtzCommand(action="goto_preset", preset_token="7"))
    assert "code=GotoPreset" in captured["url"] and "arg2=7" in captured["url"]


async def test_ptz_failure_raises(monkeypatch):
    async def _strict(*a, **k):
        raise http_mod.BrandHTTPError(403, "denied")

    monkeypatch.setattr(http_mod, "request_strict", _strict)
    try:
        await CpPlusDriver().ptz("10.0.0.7", CREDS, PtzCommand(action="continuous", tilt=1.0))
        assert False, "expected DriverError"
    except DriverError:
        pass


# ── configure imaging (read parses kv) ───────────────────────────────────────────
async def test_configure_imaging_read(monkeypatch):
    monkeypatch.setattr(http_mod, "get_text", _route_get_text({"VideoInOptions": fx.CPPLUS_VIDEO_IN_OPTIONS}))
    result = await CpPlusDriver().configure("10.0.0.7", CREDS, "imaging", {})
    assert result["table.VideoInOptions[0].Brightness"] == "50"


# ── NVR footage stub (P4) ────────────────────────────────────────────────────────
async def test_search_recordings_is_stub():
    assert await CpPlusDriver().search_recordings("10.0.0.7", CREDS) == []
