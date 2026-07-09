"""NVR footage-extraction driver tests (P4-B) — search + playback-URI construction.

No live NVR is touched: the brand ``_http`` helpers are monkeypatched to return
fabricated ISAPI XML / Dahua CGI text, so the driver's endpoint construction, request
bodies, and response parsing run for real. Playback-URI construction is asserted against
the expected brand RTSP form (time normalisation + creds injection).
"""

from __future__ import annotations

import app.vms.drivers._http as http_mod
from app.vms.drivers import Credentials, CpPlusDriver, HikvisionDriver
from app.vms.drivers.cpplus import (
    _parse_dahua_find_items,
    _to_dahua_rtsp_time,
    _to_dahua_time,
)
from app.vms.drivers.hikvision import _to_hik_time, _to_rtsp_time

from . import fixtures as fx

CREDS = Credentials(username="admin", password="pass12", port=80, rtsp_port=554)

FROM = "2026-07-09T10:00:00Z"
TO = "2026-07-09T11:00:00Z"


# ── time-normalisation helpers ────────────────────────────────────────────────────
def test_hik_time_normalisation():
    assert _to_hik_time("2026-07-09T10:00:00+00:00") == "2026-07-09T10:00:00Z"
    assert _to_hik_time("2026-07-09T10:00:00Z") == "2026-07-09T10:00:00Z"
    assert _to_rtsp_time("2026-07-09T10:00:00Z") == "20260709T100000Z"
    assert _to_hik_time("garbage") is None


def test_dahua_time_normalisation():
    assert _to_dahua_time("2026-07-09T10:00:00Z") == "2026-07-09 10:00:00"
    assert _to_dahua_rtsp_time("2026-07-09T10:00:00Z") == "2026_07_09_10_00_00"
    assert _to_dahua_time(None) is None


# ── Hikvision ISAPI ContentMgmt/search ────────────────────────────────────────────
async def test_hik_search_recordings_parses_matches(monkeypatch):
    captured = {}

    async def _post(url, user, password, *, content=None, headers=None, verify_tls=False, timeout=8.0):
        captured["url"] = url
        captured["content"] = content
        return fx.HIK_CMSEARCH_RESULT

    monkeypatch.setattr(http_mod, "post_text", _post)
    out = await HikvisionDriver().search_recordings("10.0.0.5", CREDS, channel=1, start_time=FROM, end_time=TO)

    # POSTed a CMSearchDescription to the ISAPI search endpoint with the main track id.
    assert captured["url"].endswith("/ISAPI/ContentMgmt/search")
    assert "<trackID>101</trackID>" in captured["content"]
    assert "<startTime>2026-07-09T10:00:00Z</startTime>" in captured["content"]
    # Parsed two matches with their time spans + playback URIs.
    assert len(out) == 2
    assert out[0]["start_time"] == "2026-07-09T10:00:00Z"
    assert out[0]["end_time"] == "2026-07-09T10:15:00Z"
    assert out[0]["track_id"] == 101
    assert "Streaming/tracks/101" in out[0]["playback_uri"]
    assert out[1]["start_time"] == "2026-07-09T10:20:00Z"


async def test_hik_search_recordings_unreachable_is_empty(monkeypatch):
    async def _post(*a, **k):
        return None  # unreachable / auth-fail

    monkeypatch.setattr(http_mod, "post_text", _post)
    out = await HikvisionDriver().search_recordings("10.0.0.5", CREDS, channel=1, start_time=FROM, end_time=TO)
    assert out == []


async def test_hik_get_playback_uri_construction():
    uri = await HikvisionDriver().get_playback_uri(
        "10.0.0.5", CREDS, channel=3, start_time=FROM, end_time=TO
    )
    assert uri == (
        "rtsp://admin:pass12@10.0.0.5:554/Streaming/tracks/301"
        "?starttime=20260709T100000Z&endtime=20260709T110000Z"
    )


async def test_hik_get_playback_uri_missing_window_is_none():
    assert await HikvisionDriver().get_playback_uri("10.0.0.5", CREDS, channel=1) is None


# ── CP-Plus / Dahua mediaFileFind ─────────────────────────────────────────────────
def test_dahua_parse_find_items():
    items = _parse_dahua_find_items(fx.CPPLUS_FIND_NEXT, 1)
    assert len(items) == 2
    assert items[0]["start_time"] == "2026-07-09 10:00:00"
    assert items[0]["end_time"] == "2026-07-09 10:15:00"
    assert items[0]["file_path"].endswith(".dav")
    assert items[1]["start_time"] == "2026-07-09 10:20:00"


async def test_cpplus_search_recordings_find_lifecycle(monkeypatch):
    calls: list[str] = []

    async def _get(url, user, password, *, verify_tls=False, timeout=8.0):
        calls.append(url)
        if "action=factory.create" in url:
            return fx.CPPLUS_FIND_CREATE
        if "action=findFile" in url:
            return fx.CPPLUS_FIND_START
        if "action=findNextFile" in url:
            # First page returns 2 items; subsequent pages empty (ends the loop).
            page = sum(1 for c in calls if "findNextFile" in c)
            return fx.CPPLUS_FIND_NEXT if page == 1 else fx.CPPLUS_FIND_NEXT_EMPTY
        return "OK"  # close / destroy

    monkeypatch.setattr(http_mod, "get_text", _get)
    out = await CpPlusDriver().search_recordings("10.0.0.9", CREDS, channel=1, start_time=FROM, end_time=TO)

    # The full create → findFile → findNextFile → close lifecycle ran with the object id.
    assert any("action=factory.create" in c for c in calls)
    assert any("action=findFile&object=8675309" in c for c in calls)
    assert any("condition.Channel=1" in c for c in calls)
    assert any("action=findNextFile&object=8675309" in c for c in calls)
    assert any("action=close&object=8675309" in c for c in calls)
    # Parsed the two files.
    assert len(out) == 2
    assert out[0]["start_time"] == "2026-07-09 10:00:00"
    assert out[0]["file_path"].endswith(".dav")


async def test_cpplus_search_recordings_no_finder_is_empty(monkeypatch):
    async def _get(url, user, password, *, verify_tls=False, timeout=8.0):
        return None  # create returns nothing → unreachable

    monkeypatch.setattr(http_mod, "get_text", _get)
    out = await CpPlusDriver().search_recordings("10.0.0.9", CREDS, channel=1, start_time=FROM, end_time=TO)
    assert out == []


async def test_cpplus_get_playback_uri_construction():
    uri = await CpPlusDriver().get_playback_uri(
        "10.0.0.9", CREDS, channel=2, start_time=FROM, end_time=TO
    )
    assert uri == (
        "rtsp://admin:pass12@10.0.0.9:554/cam/playback"
        "?channel=2&starttime=2026_07_09_10_00_00&endtime=2026_07_09_11_00_00"
    )


async def test_cpplus_get_playback_uri_missing_window_is_none():
    assert await CpPlusDriver().get_playback_uri("10.0.0.9", CREDS, channel=1) is None
