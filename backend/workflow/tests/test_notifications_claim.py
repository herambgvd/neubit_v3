"""Two workers, one outbox: a notification is claimed by exactly one of them.

THE BUG THIS PINS. ``dispatch_notifications`` selected pending rows with
``WHERE status = 'pending' ... ORDER BY created_at LIMIT n`` and then updated them.
No ``FOR UPDATE SKIP LOCKED``, no claim state. With one worker replica that is
invisible. With two — which is what an operator adds when the outbox is backing up
— both replicas select the same rows and the same alert is delivered twice. In a
system adjacent to life-safety that is an incident, and the fix for a slow outbox
was the thing that caused it.

WHY THIS TEST RUNS AGAINST REAL POSTGRES AND NOT SQLITE. The entire mechanism is
row-level locking. SQLite has none, so a SQLite version of this test would pass
against the broken code and prove nothing; and an assertion that the compiled SQL
string contains "SKIP LOCKED" tests the ORM, not the exclusion. So: two claimers,
two connections, one table, genuinely overlapping transactions.

WHY IT DOES NOT TOUCH THE LIVE ``notifications`` TABLE. It creates a throwaway
SCHEMA and points the connection's ``search_path`` at it, so the production queries
run verbatim against an isolated copy of the table — same DDL from the same model,
no live row read or written, and nothing for the running beat schedule to race. The
schema is dropped in a finally.

THE GUARD IS SHOWN FAILING. ``test_the_old_shape_double_claims`` runs the exact
pre-fix statement through the same harness and asserts it DOES hand both claimers
the same rows. A guard nobody has seen fail is not known to work.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from conftest import run_async

from app.db import Base
from app.workflow.notifications.jobs import (
    NOTIFY_CLAIM_LEASE_SECONDS,
    _claim_batch,
    _reclaim_expired,
)
from app.workflow.notifications.models import Notification
from app.workflow.core.primitives import utcnow

_URL = os.getenv("VE_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(
    "postgresql" not in _URL,
    reason="row-level locking is the mechanism under test; needs the real Postgres "
           "(VE_DATABASE_URL). SQLite would pass against the broken code.",
)

ROWS = 20


class _Sandbox:
    """A throwaway schema holding only ``notifications``, plus engines onto it."""

    def __init__(self) -> None:
        self.name = "claimtest_" + uuid.uuid4().hex[:12]
        self.admin = create_async_engine(_URL, poolclass=NullPool)
        # search_path is what makes the UNQUALIFIED production queries land here.
        self.engine = create_async_engine(
            _URL, poolclass=NullPool,
            connect_args={"server_settings": {"search_path": self.name}},
        )
        self.sm = async_sessionmaker(self.engine, expire_on_commit=False, class_=AsyncSession)

    async def __aenter__(self):
        async with self.admin.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{self.name}"'))
        async with self.engine.begin() as conn:
            await conn.run_sync(
                lambda c: Base.metadata.create_all(c, tables=[Notification.__table__])
            )
        return self

    async def __aexit__(self, *exc):
        await self.engine.dispose()
        async with self.admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{self.name}" CASCADE'))
        await self.admin.dispose()

    async def seed(self, n: int = ROWS) -> list[str]:
        async with self.sm() as s:
            rows = [Notification(tenant_id=uuid.uuid4(), channel_type="webhook",
                                 recipient=f"https://example.test/{i}", body="x",
                                 status="pending", attempts=0) for i in range(n)]
            for r in rows:
                s.add(r)
            await s.commit()   # the primary key default is applied on flush, not on __init__
            return [r.notification_id for r in rows]


async def _legacy_claim(session, limit, now):
    """The pre-fix statement, verbatim: no FOR UPDATE, no claim state.

    In the old code the SELECT *was* the claim — everything after it was in-memory
    mutation of the rows it returned, so two workers returning the same rows is two
    workers sending the same message.
    """
    due = or_(Notification.next_attempt_at.is_(None), Notification.next_attempt_at <= now)
    stmt = (select(Notification.notification_id)
            .where(Notification.status == "pending", due)
            .order_by(Notification.created_at.asc()).limit(limit))
    return list((await session.execute(stmt)).scalars().all())


async def _race(sandbox, claimer, limit):
    """Run two claimers with their transactions genuinely overlapping.

    A claims and HOLDS its transaction open; only then does B claim. That ordering
    is the whole point: it is the interleaving where the two workers are inside the
    outbox at the same instant, which is the one a sequential test never reaches.
    """
    a_claimed, b_claimed = asyncio.Event(), asyncio.Event()
    now = utcnow()
    out = {}

    async def worker_a():
        async with sandbox.sm() as s:
            out["a"] = await claimer(s, limit, now)
            a_claimed.set()
            await b_claimed.wait()      # B works while A still holds its locks
            await s.commit()

    async def worker_b():
        async with sandbox.sm() as s:
            await a_claimed.wait()
            out["b"] = await claimer(s, limit, now)
            b_claimed.set()
            await s.commit()

    await asyncio.wait_for(asyncio.gather(worker_a(), worker_b()), timeout=30)
    return out["a"], out["b"]


def test_two_concurrent_claimers_split_the_outbox_exactly():
    async def go():
        async with _Sandbox() as sb:
            all_ids = await sb.seed()

            async def claim(s, limit, now):
                return await _claim_batch(s, limit, now, worker="test")

            # limit == the whole outbox for BOTH, so any row either worker can see
            # it will take. Only the exclusion can keep them apart.
            a, b = await _race(sb, claim, limit=ROWS)

            assert not (set(a) & set(b)), (
                f"{len(set(a) & set(b))} notification(s) claimed by BOTH workers — "
                f"every one of those is an alert delivered twice")
            assert sorted(a + b) == sorted(all_ids), (
                f"claimed {len(a) + len(b)} of {len(all_ids)} rows — the exclusion "
                f"dropped work instead of dividing it")

            async with sb.sm() as s:
                left = (await s.execute(
                    select(Notification.notification_id)
                    .where(Notification.status == "pending"))).scalars().all()
                assert not left
                claimed = (await s.execute(
                    select(Notification).where(Notification.status == "claimed"))).scalars().all()
                # The claim is committed BEFORE any provider is contacted, so the
                # counter cannot be lost by a crash mid-send.
                assert all(n.attempts == 1 and n.claimed_at is not None for n in claimed)
    run_async(go())


def test_the_old_shape_double_claims():
    """The same harness against the pre-fix statement. It must fail the property."""
    async def go():
        async with _Sandbox() as sb:
            all_ids = await sb.seed()
            a, b = await _race(sb, _legacy_claim, limit=ROWS)
            overlap = set(a) & set(b)
            assert overlap, "the old SELECT was expected to hand both workers the same rows"
            assert len(overlap) == len(all_ids)
            assert sorted(set(a) | set(b)) == sorted(all_ids)
    run_async(go())


def test_a_row_whose_worker_died_comes_back_after_the_lease():
    """SIGKILL between claim and outcome: the row must not be stranded in ``claimed``."""
    async def go():
        async with _Sandbox() as sb:
            ids = await sb.seed(3)
            async with sb.sm() as s:
                await _claim_batch(s, 3, utcnow(), worker="doomed-worker")
                await s.commit()          # ...and the process dies here

            # Before the lease expires the row is nobody else's to take.
            async with sb.sm() as s:
                assert await _claim_batch(s, 3, utcnow(), worker="other") == []
                await s.rollback()
                assert await _reclaim_expired(s, utcnow()) == 0
                await s.rollback()

            async with sb.sm() as s:
                later = utcnow() + timedelta(seconds=NOTIFY_CLAIM_LEASE_SECONDS + 1)
                assert await _reclaim_expired(s, later) == 3
                await s.commit()
                rows = (await s.execute(
                    select(Notification).where(
                        Notification.notification_id.in_(ids)))).scalars().all()
                for n in rows:
                    assert n.status == "pending"
                    assert n.claimed_at is None and n.claimed_by is None
                    # NOT reset: the dead worker may have reached the provider, and
                    # forgiving the attempt is how a row that kills the worker
                    # retries forever.
                    assert n.attempts == 1

            # And now another worker can have it.
            async with sb.sm() as s:
                assert len(await _claim_batch(s, 3, utcnow(), worker="other")) == 3
                await s.commit()
    run_async(go())
