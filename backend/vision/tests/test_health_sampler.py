"""Health sampler + config tests — no DB, no NATS, no device access.

Every boundary is faked: the reachability probe is monkeypatched, the NATS emit is
captured, and the DB session is a minimal stub that just records ``add``. This keeps
the test hermetic (same discipline as the driver tests) while exercising the core
``sample_one`` logic (status mutation, health-row creation, transition-only emit),
the ``_host_port`` selection, and the env-driven config knobs.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.vms.health import service as health_svc
from app.vms.health.service import (
    _host_port,
    retention_days,
    sample_concurrency,
    sample_interval_sec,
    sample_one,
)


class _FakeSession:
    """Minimal AsyncSession stand-in: records ``add``-ed rows; no real IO."""

    def __init__(self) -> None:
        self.added: list = []

    def add(self, obj) -> None:
        self.added.append(obj)


def _camera(**over):
    base = dict(
        id="cam-1",
        tenant_id=None,
        is_enabled=True,
        status="connecting",
        onvif_host="10.0.0.5",
        onvif_port=8000,
        network_info={},
        last_seen_at=None,
        last_error=None,
        updated_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
    )
    base.update(over)
    return SimpleNamespace(**base)


# ── _host_port selection ─────────────────────────────────────────────────────────
def test_host_port_prefers_onvif():
    cam = _camera(onvif_host="1.2.3.4", onvif_port=8899)
    assert _host_port(cam) == ("1.2.3.4", 8899)


def test_host_port_falls_back_to_network_info_ip():
    cam = _camera(onvif_host=None, network_info={"ip": "9.9.9.9", "rtsp_port": 554})
    host, port = _host_port(cam)
    assert host == "9.9.9.9"
    assert port == 554


def test_host_port_none_when_no_host():
    cam = _camera(onvif_host=None, network_info={})
    host, _port = _host_port(cam)
    assert host is None


# ── sample_one: status mutation + health-row + transition-only emit ───────────────
@pytest.mark.asyncio
async def test_sample_one_offline_when_unreachable(monkeypatch):
    emitted: list = []

    async def _unreachable(host, port, timeout):
        return False

    async def _capture_emit(tenant_id, payload, **kw):
        emitted.append(payload)
        return "subj"

    monkeypatch.setattr(health_svc, "_tcp_reachable", _unreachable)
    monkeypatch.setattr(health_svc, "emit_camera_status", _capture_emit)

    db = _FakeSession()
    cam = _camera(status="online")  # prev=online → offline is a TRANSITION
    sample = await sample_one(db, cam, timeout=0.1)

    assert cam.status == "offline"
    assert cam.last_error and "unreachable" in cam.last_error
    assert sample.status == "offline"
    assert sample.bitrate_kbps is None  # P2 metric — null in P1
    assert db.added == [sample]
    assert len(emitted) == 1 and emitted[0]["status"] == "offline"


@pytest.mark.asyncio
async def test_sample_one_online_sets_last_seen(monkeypatch):
    async def _reachable(host, port, timeout):
        return True

    async def _emit(tenant_id, payload, **kw):
        return "subj"

    monkeypatch.setattr(health_svc, "_tcp_reachable", _reachable)
    monkeypatch.setattr(health_svc, "emit_camera_status", _emit)

    db = _FakeSession()
    cam = _camera(status="offline")
    sample = await sample_one(db, cam, timeout=0.1)

    assert cam.status == "online"
    assert cam.last_seen_at is not None
    assert cam.last_error is None
    assert sample.status == "online"


@pytest.mark.asyncio
async def test_sample_one_no_emit_when_status_unchanged(monkeypatch):
    emitted: list = []

    async def _unreachable(host, port, timeout):
        return False

    async def _capture_emit(tenant_id, payload, **kw):
        emitted.append(payload)
        return "subj"

    monkeypatch.setattr(health_svc, "_tcp_reachable", _unreachable)
    monkeypatch.setattr(health_svc, "emit_camera_status", _capture_emit)

    db = _FakeSession()
    cam = _camera(status="offline")  # prev already offline → NO transition, NO emit
    await sample_one(db, cam, timeout=0.1)

    assert cam.status == "offline"
    assert emitted == []


@pytest.mark.asyncio
async def test_sample_one_offline_when_no_host(monkeypatch):
    # No host → treated offline WITHOUT even attempting a probe.
    called = {"probe": False}

    async def _probe(host, port, timeout):
        called["probe"] = True
        return True

    async def _emit(tenant_id, payload, **kw):
        return "subj"

    monkeypatch.setattr(health_svc, "_tcp_reachable", _probe)
    monkeypatch.setattr(health_svc, "emit_camera_status", _emit)

    db = _FakeSession()
    cam = _camera(status="online", onvif_host=None, network_info={})
    sample = await sample_one(db, cam, timeout=0.1)

    assert sample.status == "offline"
    assert called["probe"] is False  # short-circuited (no host)


# ── env-driven config knobs ───────────────────────────────────────────────────────
def test_config_defaults(monkeypatch):
    for k in (
        "VE_HEALTH_SAMPLE_INTERVAL_SEC",
        "VE_HEALTH_SAMPLE_CONCURRENCY",
        "VE_HEALTH_RETENTION_DAYS",
    ):
        monkeypatch.delenv(k, raising=False)
    assert sample_interval_sec() == 45
    assert sample_concurrency() == 32
    assert retention_days() == 30


def test_config_overrides(monkeypatch):
    monkeypatch.setenv("VE_HEALTH_SAMPLE_INTERVAL_SEC", "60")
    monkeypatch.setenv("VE_HEALTH_SAMPLE_CONCURRENCY", "8")
    monkeypatch.setenv("VE_HEALTH_RETENTION_DAYS", "7")
    assert sample_interval_sec() == 60
    assert sample_concurrency() == 8
    assert retention_days() == 7


def test_config_clamps_floors(monkeypatch):
    # Interval floored at 5s, concurrency at 1, retention at 1 day.
    monkeypatch.setenv("VE_HEALTH_SAMPLE_INTERVAL_SEC", "0")
    monkeypatch.setenv("VE_HEALTH_SAMPLE_CONCURRENCY", "0")
    monkeypatch.setenv("VE_HEALTH_RETENTION_DAYS", "0")
    assert sample_interval_sec() == 5
    assert sample_concurrency() == 1
    assert retention_days() == 1
