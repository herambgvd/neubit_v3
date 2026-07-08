"""OnvifDriver tests against fabricated SOAP fixtures + topic-map logic.

The python-onvif-zeep SDK is stubbed via ``FakeONVIFCamera`` patched over
``app.vms.drivers.onvif.ONVIFCamera`` (and ``_HAS_ONVIF`` forced True), so the driver's
REAL parsing logic (ported from gvd_nvr) runs against representative data. No sockets,
no live cameras.
"""

from __future__ import annotations

import app.vms.drivers.onvif as onvif_mod
from app.vms.drivers import Credentials, OnvifDriver, PtzCommand
from app.vms.drivers.base import DriverError
from app.vms.drivers.onvif import _resolve_topic, _inject_creds

from .fixtures import SINGLE_CAMERA_PROFILES, make_fake_onvif


def _patch_onvif(monkeypatch, *, profiles=None, media2=True):
    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", True)
    monkeypatch.setattr(onvif_mod, "ONVIFCamera", make_fake_onvif(profiles=profiles, media2=media2))


CREDS = Credentials(username="admin", password="p@ss:word", port=80)


# ── topic map (gvd_nvr port) ─────────────────────────────────────────────────────
def test_topic_map_exact_and_prefix_resolution():
    assert _resolve_topic("tns1:VideoSource/MotionAlarm")[0] == "motion_detected"
    assert _resolve_topic("tns1:VideoSource/ImageTooDark")[0] == "camera_tamper"
    assert _resolve_topic("tns1:VideoSource/ConnectionFailed")[0] == "video_loss"
    # Prefix walk: a deeper topic still resolves to the parent mapping.
    assert _resolve_topic("tns1:RuleEngine/LineDetector/Crossed")[0] == "line_crossing"
    assert _resolve_topic("tns1:Totally/Unknown/Topic") is None


def test_event_topic_map_carries_full_gvd_nvr_map():
    m = OnvifDriver().event_topic_map()
    # A representative slice of the ported gvd_nvr _TOPIC_MAP.
    assert m["tns1:VideoSource/MotionAlarm"] == ("motion_detected", "alarm", "Motion detected")
    assert m["tns1:AudioAnalytics/Audio/DetectedSound"][0] == "audio_alarm"
    assert m["tns1:ThermalService/TemperatureAlarm"][0] == "system_error"


# ── credential injection (percent-encode, idempotent) ────────────────────────────
def test_inject_creds_percent_encodes_and_is_idempotent():
    url = _inject_creds("rtsp://cam.local:554/stream", "admin", "p@ss:word")
    assert url == "rtsp://admin:p%40ss%3Aword@cam.local:554/stream"
    # Already-authed URL is left alone.
    assert _inject_creds(url, "admin", "p@ss:word") == url
    # No username → unchanged.
    assert _inject_creds("rtsp://cam/stream", "", "x") == "rtsp://cam/stream"


# ── probe ────────────────────────────────────────────────────────────────────────
async def test_probe_parses_device_info_and_caps(monkeypatch):
    _patch_onvif(monkeypatch)
    info = await OnvifDriver().probe("10.0.0.5", CREDS)
    assert info.reachable is True
    assert info.manufacturer == "ACME" and info.model == "IPC-9000"
    assert info.firmware == "V5.6.3" and info.serial_number == "SN-ABC-123"
    assert info.mac == "AA:BB:CC:DD:EE:FF"
    assert info.has_ptz and info.has_imaging and info.has_events and info.has_analytics
    assert info.channel_count == 1  # one VideoSource in the fixture


# ── channel enumeration (multi-channel NVR grouping) ─────────────────────────────
async def test_enumerate_channels_groups_by_videosource(monkeypatch):
    _patch_onvif(monkeypatch)  # TWO_CHANNEL_PROFILES default
    channels = await OnvifDriver().enumerate_channels("10.0.0.5", CREDS)
    assert len(channels) == 2
    ch1 = channels[0]
    assert ch1.channel == 1
    assert ch1.name == "Channel1_Main"  # non-generic name preserved
    # main = highest-width profile; sub present.
    assert ch1.main.resolution == "1920x1080" and ch1.main.codec == "H264" and ch1.main.fps == 25
    assert ch1.sub.resolution == "640x480"
    # Credentials injected into the stream URL.
    assert ch1.main.stream_url.startswith("rtsp://admin:p%40ss%3Aword@cam.local:554/onvif/")
    assert ch1.ptz_capable is True
    # snapshot url surfaced
    assert ch1.snapshot_url and "snapshot" in ch1.snapshot_url


async def test_enumerate_channels_single_camera_generic_names(monkeypatch):
    _patch_onvif(monkeypatch, profiles=SINGLE_CAMERA_PROFILES)
    channels = await OnvifDriver().enumerate_channels("10.0.0.6", CREDS)
    # Both generic-named profiles (MediaProfile000/001) share source token → one channel.
    assert len(channels) == 1
    assert channels[0].name == "Channel 1"  # generic name replaced
    assert channels[0].main.resolution == "2560x1440"


# ── stream URIs (Media2 → Media fallback) ────────────────────────────────────────
async def test_get_stream_uris_prefers_media2(monkeypatch):
    _patch_onvif(monkeypatch, media2=True)
    uris = await OnvifDriver().get_stream_uris("10.0.0.5", CREDS)
    assert uris.media_version == 2
    assert uris.main and uris.sub
    assert uris.main.startswith("rtsp://admin:")


async def test_get_stream_uris_falls_back_to_media1(monkeypatch):
    _patch_onvif(monkeypatch, media2=False)
    uris = await OnvifDriver().get_stream_uris("10.0.0.5", CREDS)
    assert uris.media_version == 1
    assert uris.main is not None


# ── capabilities ─────────────────────────────────────────────────────────────────
async def test_get_capabilities_detects_matrix(monkeypatch):
    _patch_onvif(monkeypatch, media2=True)
    caps = await OnvifDriver().get_capabilities("10.0.0.5", CREDS)
    assert caps.ptz and caps.imaging and caps.events
    assert caps.media2 is True
    assert caps.recording_search is True  # recording service in GetServices fixture
    assert caps.io is True                # relay outputs present
    assert caps.audio is True             # audio encoder config present


# ── PTZ ──────────────────────────────────────────────────────────────────────────
async def test_ptz_actions(monkeypatch):
    _patch_onvif(monkeypatch)
    d = OnvifDriver()
    assert await d.ptz("10.0.0.5", CREDS, PtzCommand(action="continuous", pan=0.5)) is None
    assert await d.ptz("10.0.0.5", CREDS, PtzCommand(action="stop")) is None
    presets = await d.ptz("10.0.0.5", CREDS, PtzCommand(action="get_presets"))
    assert presets == [{"token": "1", "name": "Gate"}, {"token": "2", "name": "Lobby"}]
    token = await d.ptz("10.0.0.5", CREDS, PtzCommand(action="set_preset", preset_name="Home"))
    assert token == "99"


async def test_ptz_unknown_action_raises(monkeypatch):
    _patch_onvif(monkeypatch)
    try:
        await OnvifDriver().ptz("10.0.0.5", CREDS, PtzCommand(action="warp_drive"))
        assert False, "expected DriverError"
    except DriverError:
        pass


# ── configure (imaging read/write) ───────────────────────────────────────────────
async def test_configure_imaging_read_and_write(monkeypatch):
    _patch_onvif(monkeypatch)
    d = OnvifDriver()
    read = await d.configure("10.0.0.5", CREDS, "imaging", {})
    assert read["brightness"] == 50.0 and read["ir_cut_filter"] == "AUTO"
    written = await d.configure("10.0.0.5", CREDS, "imaging", {"brightness": 70})
    assert "brightness" in written


async def test_configure_unsupported_section_raises(monkeypatch):
    _patch_onvif(monkeypatch)
    try:
        await OnvifDriver().configure("10.0.0.5", CREDS, "nonsense", {})
        assert False, "expected DriverError"
    except DriverError:
        pass


# ── graceful degradation: SDK missing ────────────────────────────────────────────
async def test_probe_without_sdk_is_graceful(monkeypatch):
    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", False)

    async def _no_endpoint(ip, port, timeout=2.0):
        return False

    monkeypatch.setattr(onvif_mod, "_is_onvif_endpoint", _no_endpoint)
    info = await OnvifDriver().probe("10.0.0.9", CREDS)
    assert info.reachable is False and info.error


async def test_read_methods_without_sdk_return_empty(monkeypatch):
    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", False)
    d = OnvifDriver()
    assert await d.enumerate_channels("h", CREDS) == []
    assert (await d.get_stream_uris("h", CREDS)).main is None
    caps = await d.get_capabilities("h", CREDS)
    assert caps.ptz is False
    assert await d.get_snapshot("h", CREDS) is None


async def test_ptz_without_sdk_raises(monkeypatch):
    monkeypatch.setattr(onvif_mod, "_HAS_ONVIF", False)
    try:
        await OnvifDriver().ptz("h", CREDS, PtzCommand(action="stop"))
        assert False, "expected DriverError"
    except DriverError:
        pass
