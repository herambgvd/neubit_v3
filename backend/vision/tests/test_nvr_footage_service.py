"""NVR footage-extraction SERVICE tests (P4-B) — endpoint wiring, no network.

Exercises ``NvrService.channel_recordings`` + ``channel_playback`` against an in-memory
SQLite DB with the brand driver + the Go-nvr client stubbed:
  * recordings → maps driver matches into the response shape; graceful empty when the
    driver returns nothing (unreachable NVR).
  * playback → registers the NVR playback RTSP via the nvr client (HLS/WebRTC + media
    token) on success; falls back to the raw RTSP URI when the nvr data-plane is down;
    a clean empty session when no playback URI is derivable.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.common import media_token
from app.vms.common.nvr_client import NvrUnavailable
from app.vms.models import NVR
from app.vms.nvr.service import NvrService

TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


class _StubDriver:
    """Brand-driver stub: canned search results + a playback URI (or None)."""

    def __init__(self, *, matches=None, playback_uri="rtsp://nvr/playback"):
        self._matches = matches or []
        self._playback_uri = playback_uri
        self.aclosed = False

    async def search_recordings(self, host, creds, *, channel=None, start_time=None, end_time=None):
        return self._matches

    async def get_playback_uri(self, host, creds, *, channel=None, start_time=None, end_time=None, recording_token=None):
        return self._playback_uri

    async def aclose(self):
        self.aclosed = True


class _StubNvrClient:
    """Go-nvr client stub: ensure_stream returns URLs, or raises when ``down``."""

    def __init__(self, *, down=False):
        self.down = down
        self.calls = []

    async def ensure_stream(self, *, camera_id, rtsp_url, profile):
        self.calls.append({"camera_id": camera_id, "rtsp_url": rtsp_url, "profile": profile})
        if self.down:
            raise NvrUnavailable("nvr data-plane unreachable: boom")
        return {
            "name": f"{camera_id}/{profile}",
            "node": "mediamtx-0",
            "hls_url": f"http://localhost/media/{camera_id}/index.m3u8",
            "webrtc_url": f"http://localhost/media/{camera_id}/whep",
            "rtsp_url": rtsp_url,
            "ready": True,
        }


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
async def nvr(db):
    row = NVR(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="NVR One",
        brand="hikvision",
        host="10.0.0.5",
        port=80,
        username="admin",
        status="online",
    )
    db.add(row)
    await db.commit()
    return row


def _scope():
    return Scope(tenant_id=TENANT, is_superadmin=False)


def _svc(db, driver, monkeypatch, client=None):
    import app.vms.nvr.service as mod

    svc = NvrService(db, _scope(), bearer="fake.jwt")
    monkeypatch.setattr(mod, "get_driver", lambda brand: driver)
    if client is not None:
        monkeypatch.setattr(mod, "NvrClient", lambda *, bearer=None: client)
    return svc


# ── recordings search ──────────────────────────────────────────────────────────────
async def test_channel_recordings_maps_matches(db, nvr, monkeypatch):
    driver = _StubDriver(
        matches=[
            {"channel": 1, "start_time": "2026-07-09T10:00:00Z", "end_time": "2026-07-09T10:15:00Z", "track_id": 101},
            {"channel": 1, "start_time": "2026-07-09T10:20:00Z", "end_time": "2026-07-09T10:35:00Z", "track_id": 101},
        ]
    )
    out = await _svc(db, driver, monkeypatch).channel_recordings(
        nvr.id, 1, "2026-07-09T10:00:00Z", "2026-07-09T11:00:00Z"
    )
    assert out.total == 2
    assert out.channel == 1
    assert out.items[0].start == "2026-07-09T10:00:00Z"
    assert out.items[0].extra.get("track_id") == 101
    assert driver.aclosed is True  # driver always closed


async def test_channel_recordings_unreachable_is_empty(db, nvr, monkeypatch):
    driver = _StubDriver(matches=[])
    out = await _svc(db, driver, monkeypatch).channel_recordings(nvr.id, 2, None, None)
    assert out.total == 0 and out.items == []


async def test_channel_recordings_tenant_isolation(db, nvr, monkeypatch):
    from kernel.errors import NotFoundError
    import app.vms.nvr.service as mod

    svc = NvrService(db, Scope(tenant_id=uuid.uuid4(), is_superadmin=False))
    monkeypatch.setattr(mod, "get_driver", lambda brand: _StubDriver())
    with pytest.raises(NotFoundError):
        await svc.channel_recordings(nvr.id, 1, None, None)


# ── playback session ────────────────────────────────────────────────────────────────
async def test_channel_playback_registers_mediamtx_with_token(db, nvr, monkeypatch):
    from datetime import datetime, timezone

    driver = _StubDriver(playback_uri="rtsp://10.0.0.5:554/Streaming/tracks/101?starttime=x&endtime=y")
    client = _StubNvrClient()
    svc = _svc(db, driver, monkeypatch, client)

    frm = datetime(2026, 7, 9, 10, 0, tzinfo=timezone.utc)
    to = datetime(2026, 7, 9, 11, 0, tzinfo=timezone.utc)
    out = await svc.channel_playback(nvr.id, 1, frm, to)

    assert out.kind == "nvr_recorded"
    assert out.ready is True
    assert out.hls_url and "token=" in out.hls_url
    assert out.token
    # The token is a media token in playback mode bound to the pseudo NVR-channel.
    # The pseudo id is TIME-KEYED (…-pb<from-unix>) — an NVR replay is a linear stream
    # pinned to its starttime, so a seek must land on a NEW MediaMTX path (fresh pull).
    claims = media_token.verify_media_token(out.token)
    assert claims["mode"] == "playback"
    assert claims["camera_id"] == f"nvr-{nvr.id}-ch1-pb{int(frm.timestamp())}"
    # The nvr client was asked to register the NVR's playback RTSP.
    assert client.calls and client.calls[0]["profile"] == "playback"
    assert "Streaming/tracks/101" in client.calls[0]["rtsp_url"]


async def test_channel_playback_falls_back_to_rtsp_when_nvr_down(db, nvr, monkeypatch):
    from datetime import datetime, timezone

    driver = _StubDriver(playback_uri="rtsp://10.0.0.5:554/Streaming/tracks/101?starttime=x&endtime=y")
    client = _StubNvrClient(down=True)
    out = await _svc(db, driver, monkeypatch, client).channel_playback(
        nvr.id, 1, datetime(2026, 7, 9, 10, 0, tzinfo=timezone.utc), datetime(2026, 7, 9, 11, 0, tzinfo=timezone.utc)
    )
    # No MediaMTX URLs, but the raw RTSP playback URI is returned for a P4-C proxy.
    assert out.hls_url is None and out.token is None
    assert out.rtsp_url and "Streaming/tracks/101" in out.rtsp_url
    assert out.ready is False


async def test_channel_playback_no_uri_is_empty_session(db, nvr, monkeypatch):
    from datetime import datetime, timezone

    driver = _StubDriver(playback_uri=None)  # NVR unreachable / no window
    out = await _svc(db, driver, monkeypatch, _StubNvrClient()).channel_playback(
        nvr.id, 1, datetime(2026, 7, 9, 10, 0, tzinfo=timezone.utc), datetime(2026, 7, 9, 11, 0, tzinfo=timezone.utc)
    )
    assert out.hls_url is None and out.rtsp_url is None and out.token is None
    assert out.ready is False


# ── recording-days calendar (Task 1) ────────────────────────────────────────────────
async def test_recording_days_groups_ranges_by_local_day(db, nvr, monkeypatch):
    # Ranges on the 14th and 16th (UTC), plus a 14th→15th midnight-spanner → {14,15,16}.
    driver = _StubDriver(
        matches=[
            {"channel": 1, "start_time": "2026-07-14T08:00:00Z", "end_time": "2026-07-14T09:00:00Z"},
            {"channel": 1, "start_time": "2026-07-14T23:30:00Z", "end_time": "2026-07-15T00:30:00Z"},
            {"channel": 1, "start_time": "2026-07-16T01:00:00Z", "end_time": "2026-07-16T02:00:00Z"},
        ]
    )
    out = await _svc(db, driver, monkeypatch).recording_days_nvr(nvr.id, 1, "2026-07", 0)
    assert out.year == 2026 and out.month == 7
    assert out.days == [14, 15, 16]


async def test_recording_days_tz_shift_moves_day(db, nvr, monkeypatch):
    # 23:00Z on the 14th → 04:30 on the 15th in IST (+330) → day 15.
    driver = _StubDriver(
        matches=[{"channel": 1, "start_time": "2026-07-14T23:00:00Z", "end_time": "2026-07-14T23:30:00Z"}]
    )
    out = await _svc(db, driver, monkeypatch).recording_days_nvr(nvr.id, 1, "2026-07", 330)
    assert out.days == [15]


async def test_recording_days_unreachable_nvr_is_empty(db, nvr, monkeypatch):
    # channel_recordings returns empty on an unreachable NVR → {days: []}, never 500.
    driver = _StubDriver(matches=[])
    out = await _svc(db, driver, monkeypatch).recording_days_nvr(nvr.id, 1, "2026-07", 0)
    assert out.days == []


async def test_recording_days_driver_raises_is_graceful(db, nvr, monkeypatch):
    # A driver that blows up mid-search must still yield an empty calendar (never 500).
    class _Boom(_StubDriver):
        async def search_recordings(self, *a, **k):
            raise RuntimeError("device timeout")

    out = await _svc(db, _Boom(), monkeypatch).recording_days_nvr(nvr.id, 1, "2026-07", 0)
    assert out.days == []


async def test_recording_days_bad_month_raises_before_driver(db, nvr, monkeypatch):
    from kernel.errors import ValidationError

    # A driver that would fail the test if called — bad month must short-circuit first.
    class _NeverCalled(_StubDriver):
        async def search_recordings(self, *a, **k):
            raise AssertionError("driver must not be reached on a bad month")

    with pytest.raises(ValidationError):
        await _svc(db, _NeverCalled(), monkeypatch).recording_days_nvr(nvr.id, 1, "2026-13", 0)


async def test_recording_days_tenant_isolation(db, nvr, monkeypatch):
    from kernel.errors import NotFoundError
    import app.vms.nvr.service as mod

    svc = NvrService(db, Scope(tenant_id=uuid.uuid4(), is_superadmin=False))
    monkeypatch.setattr(mod, "get_driver", lambda brand: _StubDriver())
    with pytest.raises(NotFoundError):
        await svc.recording_days_nvr(nvr.id, 1, "2026-07", 0)
