"""WHERE THE ESTATE'S EVENT FEED RESUMES FROM.

The supervisor mirrors each recorder's ONVIF ledger into this service, and it asks
for events ``since`` a watermark. That watermark lived in memory ONLY, with a
15-minute cold-start fallback — so every restart of this service asked the recorder
for the last quarter of an hour and nothing else.

On the live estate that produced an event feed that was permanently EMPTY while the
recorder held 56 events: the newest was ninety minutes old, the process had
restarted since, and everything before the fallback window was never asked for
again. Nothing logged an error — the poll succeeded and returned nothing.

So the watermark is persisted on the node row, and the cold start reaches back far
enough to be worth asking for. Re-asking is free: the ingest path dedupes on
(camera, type, time-bucket) with a UNIQUE constraint, which is what makes a
generous overlap the safe choice rather than a costly one.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.vms.events import supervisor as sup
from app.vms.models import MediaNode

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


async def _node(sm, **over) -> MediaNode:
    async with sm() as db:
        n = MediaNode(
            id=str(uuid.uuid4()), tenant_id=TENANT, name="recorder-a",
            host="nvr", api_url="http://nvr:8000", credential="k", status="online",
            **over,
        )
        db.add(n)
        await db.commit()
        await db.refresh(n)
        return n


def _event(created: datetime) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "camera_id": str(uuid.uuid4()),
        "camera_name": "Channel 1",
        "type": "motion",
        "severity": "alarm",
        "created_at": created.isoformat().replace("+00:00", "Z"),
        "started_at": created.isoformat().replace("+00:00", "Z"),
    }


async def test_a_cold_start_reaches_back_past_the_last_few_minutes(sm, monkeypatch):
    # The bug, exactly: the recorder's newest event is 90 minutes old and the
    # service has just restarted. A 15-minute window asks for nothing.
    node = await _node(sm)
    asked: dict = {}

    async def fake_list(api_url, *, since=None, limit=200, credential=None):
        asked["since"] = since
        return {"items": []}

    monkeypatch.setattr(sup.fed, "list_events_node", fake_list)
    await sup.EventSupervisor(sm)._poll_node(node)

    since = datetime.fromisoformat(asked["since"].replace("Z", "+00:00"))
    age = datetime.now(timezone.utc) - since
    assert age > timedelta(hours=2), f"cold start only looked back {age}"


async def test_the_watermark_survives_a_restart(sm, monkeypatch):
    """A fresh supervisor — a restarted process — resumes where the last one got to,
    not from a fixed window before now."""
    newest = datetime.now(timezone.utc) - timedelta(hours=6)
    node = await _node(sm)

    async def first_poll(api_url, *, since=None, limit=200, credential=None):
        return {"items": [_event(newest)]}

    monkeypatch.setattr(sup.fed, "list_events_node", first_poll)
    await sup.EventSupervisor(sm)._poll_node(node)

    asked: dict = {}

    async def second_poll(api_url, *, since=None, limit=200, credential=None):
        asked["since"] = since
        return {"items": []}

    monkeypatch.setattr(sup.fed, "list_events_node", second_poll)
    # A DIFFERENT instance: nothing in memory, exactly as after a deploy.
    async with sm() as db:
        fresh = (await db.execute(select(MediaNode).where(MediaNode.id == node.id))).scalar_one()
    await sup.EventSupervisor(sm)._poll_node(fresh)

    resumed = datetime.fromisoformat(asked["since"].replace("Z", "+00:00"))
    assert abs((resumed - newest).total_seconds()) < 2, "did not resume from the stored watermark"


async def test_the_watermark_is_written_to_the_node_row(sm, monkeypatch):
    newest = datetime.now(timezone.utc) - timedelta(minutes=20)
    node = await _node(sm)

    async def poll(api_url, *, since=None, limit=200, credential=None):
        return {"items": [_event(newest - timedelta(hours=1)), _event(newest)]}

    monkeypatch.setattr(sup.fed, "list_events_node", poll)
    await sup.EventSupervisor(sm)._poll_node(node)

    async with sm() as db:
        row = (await db.execute(select(MediaNode).where(MediaNode.id == node.id))).scalar_one()
    assert row.events_synced_at is not None
    assert abs((row.events_synced_at.replace(tzinfo=timezone.utc) - newest).total_seconds()) < 2


async def test_an_unreachable_recorder_does_not_move_the_watermark(sm, monkeypatch):
    """Whatever it kept while it was away must still be asked for when it returns."""
    node = await _node(sm)

    async def down(api_url, *, since=None, limit=200, credential=None):
        raise sup.fed.NodeUnavailable("connection refused")

    monkeypatch.setattr(sup.fed, "list_events_node", down)
    await sup.EventSupervisor(sm)._poll_node(node)

    async with sm() as db:
        row = (await db.execute(select(MediaNode).where(MediaNode.id == node.id))).scalar_one()
    assert row.events_synced_at is None


# ── the camera the event belongs to lives on the RECORDER ────────────────────


async def test_an_event_for_a_recorder_owned_camera_is_stored(sm):
    """`vms_events.camera_id` carried a FOREIGN KEY to this service's own `cameras`
    table. That table is empty on a single-ownership estate — the recorder owns every
    camera — so every mirrored event violated the constraint and was DISCARDED.

    It was invisible twice over: the insert failed inside the ingest path's
    `except Exception` (written for a racing duplicate), which logged it at DEBUG as
    a "dedup race" and returned None, and the supervisor then advanced its watermark
    because the poll itself had succeeded. The console showed an empty feed while the
    recorder held 56 events.
    """
    from app.vms.events.service import VmsEventService
    from app.vms.models import VmsEvent
    from kernel.auth import Scope

    async with sm() as db:
        svc = VmsEventService(db, Scope(tenant_id=None, is_superadmin=True))
        out = await svc.ingest_device_event(
            tenant_id=TENANT,
            # A node-side camera id: no row for it here, and there never will be.
            camera_id=str(uuid.uuid4()),
            driver_event_type="motion",
            severity="alarm",
            title="Channel 1",
            raw={"node_id": "n1"},
            source="onvif_pullpoint",
            occurred_at=datetime.now(timezone.utc),
        )
        assert out is not None, "the event was dropped"

    async with sm() as db:
        rows = (await db.execute(select(VmsEvent))).scalars().all()
    assert len(rows) == 1


def test_the_event_table_does_not_claim_the_camera_is_ours():
    """The rule, stated where SQLite cannot hide it.

    The failure above only reproduces against a database that ENFORCES foreign keys;
    the suite runs on SQLite, which does not. So this asserts the schema itself: a
    mirrored recorder event names a camera on the recorder, and a constraint saying
    otherwise silently discards every one of them.
    """
    from app.vms.models import VmsEvent

    fks = list(VmsEvent.__table__.c.camera_id.foreign_keys)
    assert fks == [], f"vms_events.camera_id points at {[str(f.column) for f in fks]}"
    # …and it stays indexed: it is what the console filters the feed by.
    indexed = any("camera_id" in {c.name for c in ix.columns} for ix in VmsEvent.__table__.indexes)
    assert indexed or VmsEvent.__table__.c.camera_id.index
