"""A RECORDER'S BACKLOG IS MIRRORED WHOLE, AND MIRRORED AS HISTORY (SCRUM-333).

The supervisor asked each recorder for ``since=<watermark>&limit=200`` and the
recorder answered NEWEST first. The watermark then moved to the newest row of that
page. Whenever more than a page had built up — an outage, a newly enrolled
recorder's day of history, a busy recorder between two polls — the page was the top
of the backlog and every row below it was skipped for good. Nothing logged it.

It asks ``order=asc`` now and keeps reading while pages come back full.

The second half is what that would otherwise have caused: every ingested row was
published, and the console's siren, workflow incidents and linkage act on a publish.
A backlog drained in full would have rung hours-old motion as alarms now. An event
older than the live window — on the RECORDER's clock — is stored and not published.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.vms.events import service as events_svc
from app.vms.events import supervisor as sup
from app.vms.models import MediaNode, VmsEvent

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()


@pytest_asyncio.fixture
async def sm():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    yield maker
    await engine.dispose()


@pytest.fixture
def published(monkeypatch):
    """Every event that went out as a live alarm, by the recorder's event id."""
    out: list[str] = []

    async def _emit(tenant_id, event_type, payload, **kw):
        out.append(((payload.get("raw") or {}).get("node_event_id")))
        return f"tenant.{tenant_id}.vms.camera.{event_type}"

    monkeypatch.setattr(events_svc, "emit_camera_event", _emit)
    return out


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _event(created: datetime) -> dict:
    # A camera per event, so the (camera, type, time-bucket) dedupe never merges two
    # of them and a count of rows is a count of events.
    return {
        "id": str(uuid.uuid4()),
        "camera_id": str(uuid.uuid4()),
        "camera_name": "Channel 1",
        "type": "motion",
        "severity": "alarm",
        "created_at": _iso(created),
        "started_at": _iso(created),
    }


class Recorder:
    """The node's GET /estate/events, as the recorder serves it: ``since`` is
    inclusive on created_at, ``order=asc`` is oldest first, and a recorder that
    predates SCRUM-333 answers newest first and sends neither ``order`` nor
    ``server_time``."""

    def __init__(self, events: list[dict], *, now: datetime | None = None, modern: bool = True):
        self.events = events
        self.now = now or datetime.now(timezone.utc)
        self.modern = modern
        self.asks: list[dict] = []

    async def list(self, api_url, *, since=None, limit=200, order=None, credential=None):
        self.asks.append({"since": since, "limit": limit, "order": order})
        rows = [e for e in self.events if not since or _parse(e["created_at"]) >= _parse(since)]
        asc = self.modern and order == "asc"
        rows.sort(key=lambda e: (_parse(e["created_at"]), e["id"]), reverse=not asc)
        out: dict = {"items": rows[:limit], "total": len(rows)}
        if self.modern:
            out["order"] = "asc" if asc else "desc"
            out["server_time"] = _iso(self.now)
        return out


async def _node(sm, synced: datetime) -> MediaNode:
    async with sm() as db:
        n = MediaNode(
            id=str(uuid.uuid4()), tenant_id=TENANT, name="recorder-a", host="nvr",
            api_url="http://nvr:8000", credential="k", status="online",
            events_synced_at=synced,
        )
        db.add(n)
        await db.commit()
        await db.refresh(n)
        return n


async def _stored(sm) -> int:
    async with sm() as db:
        return (await db.execute(select(func.count()).select_from(VmsEvent))).scalar_one()


def _backlog(n: int, start: datetime) -> list[dict]:
    return [_event(start + timedelta(seconds=i)) for i in range(n)]


async def test_a_backlog_bigger_than_a_page_is_mirrored_whole(sm, monkeypatch, published):
    # The bug, exactly: 450 events since the watermark, 200 to a page. Newest first,
    # 250 of them were never stored.
    start = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
    rec = Recorder(_backlog(450, start))
    monkeypatch.setattr(sup.fed, "list_events_node", rec.list)
    node = await _node(sm, synced=start - timedelta(seconds=1))

    await sup.EventSupervisor(sm)._poll_node(node)

    assert await _stored(sm) == 450, "part of the backlog was skipped"
    assert {a["order"] for a in rec.asks} == {"asc"}
    assert len(rec.asks) == 3  # 200, 200 and the short page that ends it
    async with sm() as db:
        row = await db.get(MediaNode, node.id)
    assert _parse(_iso(row.events_synced_at.replace(tzinfo=timezone.utc))) == _parse(
        rec.events[-1]["created_at"]
    )


async def test_a_backlog_past_the_tick_cap_carries_on_next_tick(sm, monkeypatch, published):
    """One tick reads a bounded number of pages, so a huge backlog cannot hold up the
    other recorders' live events. The next tick resumes exactly where it stopped."""
    monkeypatch.setenv("VE_EVENT_POLL_MAX_PAGES", "2")
    start = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
    rec = Recorder(_backlog(450, start))
    monkeypatch.setattr(sup.fed, "list_events_node", rec.list)
    node = await _node(sm, synced=start - timedelta(seconds=1))
    supervisor = sup.EventSupervisor(sm)

    await supervisor._poll_node(node)
    assert len(rec.asks) == 2
    first = await _stored(sm)
    assert 0 < first < 450

    await supervisor._poll_node(node)
    assert await _stored(sm) == 450


async def test_a_backlog_is_history_and_a_fresh_event_is_an_alarm(sm, monkeypatch, published):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    old = [_event(now - timedelta(hours=3) + timedelta(seconds=i)) for i in range(3)]
    fresh = [_event(now - timedelta(seconds=10 - i)) for i in range(2)]
    rec = Recorder(old + fresh, now=now)
    monkeypatch.setattr(sup.fed, "list_events_node", rec.list)
    node = await _node(sm, synced=now - timedelta(hours=4))

    await sup.EventSupervisor(sm)._poll_node(node)

    assert await _stored(sm) == 5, "a backlogged event must still be in the feed"
    assert sorted(published) == sorted(e["id"] for e in fresh), (
        "only the events still live may ring the console, open an incident or fire linkage"
    )
    async with sm() as db:
        unpublished = (
            await db.execute(select(func.count()).select_from(VmsEvent).where(VmsEvent.published.is_(False)))
        ).scalar_one()
    assert unpublished == 3


async def test_an_events_age_is_read_on_the_recorders_clock(sm, monkeypatch, published):
    """The recorder runs three hours behind this server. Its events are seconds old
    on its own clock, and they are live alarms: our clock does not get a vote."""
    recorder_now = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=3)
    events = [_event(recorder_now - timedelta(seconds=5)), _event(recorder_now - timedelta(seconds=2))]
    rec = Recorder(events, now=recorder_now)
    monkeypatch.setattr(sup.fed, "list_events_node", rec.list)
    node = await _node(sm, synced=recorder_now - timedelta(minutes=1))

    await sup.EventSupervisor(sm)._poll_node(node)

    assert sorted(published) == sorted(e["id"] for e in events)


async def test_an_old_recorder_keeps_working_and_says_what_it_skipped(sm, monkeypatch, published, caplog):
    """A recorder that predates order=asc answers newest first. It is read as before,
    its events are not aged (it sends no clock to age them by), and a full page —
    which means rows below it were skipped — is a warning naming the recorder."""
    start = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
    rec = Recorder(_backlog(250, start), modern=False)
    monkeypatch.setattr(sup.fed, "list_events_node", rec.list)
    node = await _node(sm, synced=start - timedelta(seconds=1))

    with caplog.at_level(logging.WARNING, logger="vision.event_supervisor"):
        await sup.EventSupervisor(sm)._poll_node(node)

    assert len(rec.asks) == 1
    assert await _stored(sm) == 200
    assert len(published) == 200
    assert any("recorder-a" in r.getMessage() and "skipped" in r.getMessage() for r in caplog.records)


async def test_an_unreachable_recorder_mid_backlog_keeps_what_was_read(sm, monkeypatch, published):
    """The watermark moves page by page, so a recorder that drops off after the first
    page keeps that page AND is asked for the rest when it returns."""
    start = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
    rec = Recorder(_backlog(450, start))
    calls = {"n": 0}

    async def flaky(api_url, **kw):
        calls["n"] += 1
        if calls["n"] == 2:
            raise sup.fed.NodeUnavailable("connection reset")
        return await rec.list(api_url, **kw)

    monkeypatch.setattr(sup.fed, "list_events_node", flaky)
    node = await _node(sm, synced=start - timedelta(seconds=1))
    supervisor = sup.EventSupervisor(sm)

    await supervisor._poll_node(node)
    assert await _stored(sm) == 200

    await supervisor._poll_node(node)
    assert await _stored(sm) == 450
