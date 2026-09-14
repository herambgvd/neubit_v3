"""Retention sweeps for the tables that grew per camera per day with no deleter.

``vms_events``, ``linkage_fires`` and ``playback_sessions`` had no purge at all —
on an appliance nobody prunes by hand and a full disk takes the recorder down. These
tests run the real sweep against the real ORM on the in-memory SQLite the rest of
the suite uses, so a predicate that is wrong about a nullable column or an exempt
row fails here rather than on a customer's box a year in.

``recordings`` is asserted UNTOUCHED on purpose — see ``test_recordings_are_never_swept``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.vms.health.service import (
    HealthSampler,
    linkage_fire_retention_days,
    playback_session_retention_days,
    purge_batched,
    vms_event_retention_days,
)
from app.vms.models import Camera, LinkageFire, PlaybackSession, Recording, VmsEvent

CAM = "cam-retention-1"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ago(days: float) -> datetime:
    return _utcnow() - timedelta(days=days)


async def _seed_camera(sessionmaker) -> None:
    async with sessionmaker() as db:
        db.add(Camera(id=CAM, tenant_id=None, name="retention cam"))
        await db.commit()


async def _count(sessionmaker, model) -> int:
    async with sessionmaker() as db:
        return int(await db.scalar(select(func.count()).select_from(model)) or 0)


async def _ids(sessionmaker, model) -> set[str]:
    async with sessionmaker() as db:
        return set((await db.execute(select(model.id))).scalars().all())


def _event(ident: str, occurred: datetime, **over) -> VmsEvent:
    base = dict(
        id=ident,
        tenant_id=None,
        camera_id=CAM,
        event_type="motion",
        severity="info",
        source="onvif",
        title="motion",
        raw={},
        dedup_key=f"dk-{ident}",
        occurred_at=occurred,
        published=True,
    )
    base.update(over)
    return VmsEvent(**base)


def _fire(ident: str, fired: datetime, **over) -> LinkageFire:
    base = dict(
        id=ident,
        tenant_id=None,
        rule_id="rule-1",
        trigger_event_type="motion",
        actions_result=[],
        fired_at=fired,
    )
    base.update(over)
    return LinkageFire(**base)


def _session(ident: str, **over) -> PlaybackSession:
    base = dict(
        id=ident,
        tenant_id=None,
        camera_id=CAM,
        kind="live",
        profile="sub",
        expires_at=_ago(30),
        created_at=_ago(30),
        updated_at=_ago(30),
    )
    base.update(over)
    return PlaybackSession(**base)


# ── env-driven windows ───────────────────────────────────────────────────────────
def test_retention_defaults(monkeypatch):
    for k in (
        "VE_VMS_EVENT_RETENTION_DAYS",
        "VE_LINKAGE_FIRE_RETENTION_DAYS",
        "VE_PLAYBACK_SESSION_RETENTION_DAYS",
    ):
        monkeypatch.delenv(k, raising=False)
    assert vms_event_retention_days() == 365
    assert linkage_fire_retention_days() == 365
    assert playback_session_retention_days() == 7


def test_retention_overrides(monkeypatch):
    monkeypatch.setenv("VE_VMS_EVENT_RETENTION_DAYS", "90")
    monkeypatch.setenv("VE_LINKAGE_FIRE_RETENTION_DAYS", "45")
    monkeypatch.setenv("VE_PLAYBACK_SESSION_RETENTION_DAYS", "3")
    assert vms_event_retention_days() == 90
    assert linkage_fire_retention_days() == 45
    assert playback_session_retention_days() == 3


def test_retention_windows_floor_at_one_day(monkeypatch):
    # A 0 (or a typo that reads as 0) must not mean "delete everything older than now".
    for k in (
        "VE_VMS_EVENT_RETENTION_DAYS",
        "VE_LINKAGE_FIRE_RETENTION_DAYS",
        "VE_PLAYBACK_SESSION_RETENTION_DAYS",
    ):
        monkeypatch.setenv(k, "0")
    assert vms_event_retention_days() == 1
    assert linkage_fire_retention_days() == 1
    assert playback_session_retention_days() == 1


def test_retention_windows_survive_garbage(monkeypatch):
    monkeypatch.setenv("VE_VMS_EVENT_RETENTION_DAYS", "forever")
    monkeypatch.setenv("VE_PLAYBACK_SESSION_RETENTION_DAYS", "")
    assert vms_event_retention_days() == 365
    assert playback_session_retention_days() == 7


# ── vms_events ───────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_vms_events_older_than_window_are_swept(http_sessionmaker, monkeypatch):
    monkeypatch.setenv("VE_VMS_EVENT_RETENTION_DAYS", "30")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_event("ev-old", _ago(40)))
        db.add(_event("ev-edge", _ago(29)))
        db.add(_event("ev-new", _ago(1)))
        await db.commit()

    result = await HealthSampler(http_sessionmaker).purge_all()

    assert result["vms_events"] == 1
    assert await _ids(http_sessionmaker, VmsEvent) == {"ev-edge", "ev-new"}


@pytest.mark.asyncio
async def test_vms_events_carrying_evidence_are_exempt(http_sessionmaker, monkeypatch):
    # A snapshot path / recording id makes the row the INDEX INTO evidence that still
    # exists on disk. Sweeping it orphans the file.
    monkeypatch.setenv("VE_VMS_EVENT_RETENTION_DAYS", "30")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_event("ev-plain", _ago(400)))
        db.add(_event("ev-snap", _ago(400), snapshot_path="/evidence/a.jpg"))
        db.add(_event("ev-clip", _ago(400), recording_id="rec-1"))
        await db.commit()

    await HealthSampler(http_sessionmaker).purge_all()

    assert await _ids(http_sessionmaker, VmsEvent) == {"ev-snap", "ev-clip"}


# ── linkage_fires ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_linkage_fires_swept_but_recording_provenance_kept(
    http_sessionmaker, monkeypatch
):
    monkeypatch.setenv("VE_LINKAGE_FIRE_RETENTION_DAYS", "10")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_fire("fire-old", _ago(20)))
        db.add(_fire("fire-clip", _ago(20), recording_id="rec-9"))
        db.add(_fire("fire-new", _ago(2)))
        await db.commit()

    result = await HealthSampler(http_sessionmaker).purge_all()

    assert result["linkage_fires"] == 1
    assert await _ids(http_sessionmaker, LinkageFire) == {"fire-clip", "fire-new"}


# ── playback_sessions ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_playback_sessions_swept_by_expiry(http_sessionmaker, monkeypatch):
    monkeypatch.setenv("VE_PLAYBACK_SESSION_RETENTION_DAYS", "7")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_session("ps-old", expires_at=_ago(9)))
        db.add(_session("ps-recent", expires_at=_ago(1)))
        await db.commit()

    result = await HealthSampler(http_sessionmaker).purge_all()

    assert result["playback_sessions"] == 1
    assert await _ids(http_sessionmaker, PlaybackSession) == {"ps-recent"}


@pytest.mark.asyncio
async def test_playback_session_without_expiry_falls_back_to_created_at(
    http_sessionmaker, monkeypatch
):
    # expires_at is written a statement AFTER the INSERT; a half-failed request can
    # leave it NULL, and an expiry-only predicate would make that row immortal.
    monkeypatch.setenv("VE_PLAYBACK_SESSION_RETENTION_DAYS", "7")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_session("ps-null-old", expires_at=None, created_at=_ago(30)))
        db.add(_session("ps-null-new", expires_at=None, created_at=_ago(1)))
        await db.commit()

    await HealthSampler(http_sessionmaker).purge_all()

    assert await _ids(http_sessionmaker, PlaybackSession) == {"ps-null-new"}


# ── recordings: the table this sweep must never touch ────────────────────────────
@pytest.mark.asyncio
async def test_recordings_are_never_swept(http_sessionmaker, monkeypatch):
    """A Recording row points at a segment the RECORDER owns.

    Deleting the row orphans footage nothing else names; deleting the segment is not
    this service's call under single ownership. Every window is set to its floor here
    so the only thing keeping these rows is that nothing sweeps them.
    """
    for k in (
        "VE_HEALTH_RETENTION_DAYS",
        "VE_VMS_EVENT_RETENTION_DAYS",
        "VE_LINKAGE_FIRE_RETENTION_DAYS",
        "VE_PLAYBACK_SESSION_RETENTION_DAYS",
    ):
        monkeypatch.setenv(k, "1")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        for i in range(3):
            db.add(
                Recording(
                    id=f"rec-{i}",
                    tenant_id=None,
                    camera_id=CAM,
                    path=f"/footage/{i}.mp4",
                    start_time=_ago(900),
                )
            )
        await db.commit()

    result = await HealthSampler(http_sessionmaker).purge_all()

    assert "recordings" not in result
    assert await _count(http_sessionmaker, Recording) == 3


# ── batching + failure isolation ─────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_purge_batched_commits_in_batches(http_sessionmaker):
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        for i in range(5):
            db.add(_event(f"b-{i}", _ago(400)))
        await db.commit()

    removed = await purge_batched(
        http_sessionmaker, VmsEvent, VmsEvent.occurred_at < _ago(1), batch=2
    )

    assert removed == 5
    assert await _count(http_sessionmaker, VmsEvent) == 0


@pytest.mark.asyncio
async def test_one_failing_sweep_does_not_stop_the_others(
    http_sessionmaker, monkeypatch
):
    # A lock timeout on the event table is no reason to let viewer sessions
    # accumulate for another cycle.
    monkeypatch.setenv("VE_VMS_EVENT_RETENTION_DAYS", "1")
    monkeypatch.setenv("VE_PLAYBACK_SESSION_RETENTION_DAYS", "1")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_event("ev-x", _ago(400)))
        db.add(_session("ps-x", expires_at=_ago(400)))
        await db.commit()

    from app.vms.health import service as health_svc

    real = health_svc.purge_batched

    async def _explode(sessionmaker, model, whereclause, **kw):
        if model is VmsEvent:
            raise RuntimeError("lock timeout")
        return await real(sessionmaker, model, whereclause, **kw)

    monkeypatch.setattr(health_svc, "purge_batched", _explode)

    result = await HealthSampler(http_sessionmaker).purge_all()

    assert result["vms_events"] == 0
    assert result["playback_sessions"] == 1
    assert await _count(http_sessionmaker, VmsEvent) == 1
    assert await _count(http_sessionmaker, PlaybackSession) == 0


@pytest.mark.asyncio
async def test_purge_all_still_sweeps_camera_health(http_sessionmaker, monkeypatch):
    from app.vms.models import CameraHealth

    monkeypatch.setenv("VE_HEALTH_RETENTION_DAYS", "5")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(CameraHealth(id="h-old", tenant_id=None, camera_id=CAM, status="online",
                            captured_at=_ago(10)))
        db.add(CameraHealth(id="h-new", tenant_id=None, camera_id=CAM, status="online",
                            captured_at=_ago(1)))
        await db.commit()

    result = await HealthSampler(http_sessionmaker).purge_all()

    assert result["camera_health"] == 1
    assert await _ids(http_sessionmaker, CameraHealth) == {"h-new"}


@pytest.mark.asyncio
async def test_tenant_scoping_is_not_a_retention_filter(http_sessionmaker, monkeypatch):
    """The sweep is estate-wide, like the sampler: every tenant's old rows go.

    A per-tenant purge would need a tenant loop and would silently skip the NULL-tenant
    (platform/system) rows the health sampler itself writes.
    """
    monkeypatch.setenv("VE_VMS_EVENT_RETENTION_DAYS", "1")
    await _seed_camera(http_sessionmaker)
    async with http_sessionmaker() as db:
        db.add(_event("ev-t1", _ago(400), tenant_id=uuid.uuid4()))
        db.add(_event("ev-t2", _ago(400), tenant_id=uuid.uuid4()))
        db.add(_event("ev-plat", _ago(400), tenant_id=None))
        await db.commit()

    await HealthSampler(http_sessionmaker).purge_all()

    assert await _count(http_sessionmaker, VmsEvent) == 0
