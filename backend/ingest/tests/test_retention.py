"""The delivery-log purge: what it deletes, and which column it reads.

The sweep used to filter on ``created_at``, which carries no index on a table that
carries ten — so every hourly run scanned the whole retained table to return nothing.
It now filters on the indexed ``received_at``. The two are written microseconds apart
by the same INSERT, so no behaviour should change; the tests below pin that, and pin
which column the predicate actually names (a row whose timestamps disagree is the
only way to tell the two implementations apart from the outside).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app import retention
from app.ingest.models import IngestEventLog


def _ago(days: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def _log(ident: str, received: datetime, created: datetime | None = None) -> IngestEventLog:
    return IngestEventLog(
        id=ident,
        tenant_id=None,
        webhook_id="wh-1",
        category_id="cat-1",
        received_at=received,
        created_at=created if created is not None else received,
        auth_outcome="ok",
        schema_outcome="ok",
        transform_outcome="ok",
        status="accepted",
        published=True,
        raw_payload={"hello": "world"},
    )


async def _ids(sessionmaker_) -> set[str]:
    async with sessionmaker_() as db:
        return set((await db.execute(select(IngestEventLog.id))).scalars().all())


async def _count(sessionmaker_) -> int:
    async with sessionmaker_() as db:
        return int(await db.scalar(select(func.count()).select_from(IngestEventLog)) or 0)


@pytest.mark.asyncio
async def test_prunes_rows_past_the_window(sessionmaker_, monkeypatch):
    monkeypatch.setattr(retention, "RETENTION_DAYS", 30)
    async with sessionmaker_() as db:
        db.add(_log("old", _ago(40)))
        db.add(_log("inside", _ago(29)))
        db.add(_log("fresh", _ago(0.1)))
        await db.commit()

    removed = await retention.prune_once(sessionmaker_)

    assert removed == 1
    assert await _ids(sessionmaker_) == {"inside", "fresh"}


@pytest.mark.asyncio
async def test_predicate_reads_received_at_not_created_at(sessionmaker_, monkeypatch):
    """The one observable difference between the two columns, pinned.

    In production they differ by microseconds, so a normal fixture cannot tell which
    column the sweep filters on. These two rows disagree by a year each way.
    """
    monkeypatch.setattr(retention, "RETENTION_DAYS", 30)
    async with sessionmaker_() as db:
        # Received long ago, row written recently → past the window, must go.
        db.add(_log("received-old", _ago(400), created=_ago(1)))
        # Received a moment ago, created_at backdated → inside the window, must stay.
        db.add(_log("received-new", _ago(1), created=_ago(400)))
        await db.commit()

    removed = await retention.prune_once(sessionmaker_)

    assert removed == 1
    assert await _ids(sessionmaker_) == {"received-new"}


@pytest.mark.asyncio
async def test_sweep_loops_until_the_backlog_is_drained(sessionmaker_, monkeypatch):
    # A first sweep on an appliance that has been running unbounded has to clear more
    # than one batch, and each batch must commit on its own.
    monkeypatch.setattr(retention, "RETENTION_DAYS", 30)
    monkeypatch.setattr(retention, "BATCH", 2)
    async with sessionmaker_() as db:
        for i in range(5):
            db.add(_log(f"old-{i}", _ago(40 + i)))
        db.add(_log("keep", _ago(1)))
        await db.commit()

    removed = await retention.prune_once(sessionmaker_)

    assert removed == 5
    assert await _ids(sessionmaker_) == {"keep"}


@pytest.mark.asyncio
async def test_steady_state_sweep_removes_nothing(sessionmaker_, monkeypatch):
    monkeypatch.setattr(retention, "RETENTION_DAYS", 30)
    async with sessionmaker_() as db:
        db.add(_log("a", _ago(1)))
        db.add(_log("b", _ago(2)))
        await db.commit()

    assert await retention.prune_once(sessionmaker_) == 0
    assert await _count(sessionmaker_) == 2
