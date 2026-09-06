"""The periodic reconcile — v2's per-instance cron, as one ticker.

v2 ran a cron per instance. v3 kept the COLUMN (`access_instances.reconciler_cron`,
default "0 3 * * *") and shipped a stub entrypoint, so the schedule was recorded
on every controller and nothing ever fired: an operator who set a nightly sync got
one only when somebody pressed the button.

WHAT THIS IS CAREFUL ABOUT
--------------------------
A reconcile calls OUT to a customer's access controller and pulls every mirrored
collection. Three things follow, and each is why a piece of this looks the way it
does.

**Off by default.** `VE_ACCESS_RECONCILE_SCHEDULER` is opt-in. A background writer
that talks to building hardware is not something a deployment should acquire by
upgrading.

**Two replicas must not both fire.** `docker compose up --scale access=2` is a
supported thing to do, and two replicas each running a nightly reconcile means two
full pulls against one controller at the same time. The claim is a Postgres
ADVISORY LOCK keyed on the instance id, held for the run on the same session the
reconcile uses: whoever gets it runs, the other skips this tick and finds the job
already recorded on the next one. No schema change, and nothing to clean up if a
replica dies — the lock goes with its session.

On a database that has no advisory locks (SQLite, in tests) the claim is a no-op
and `lock_available()` says so, so a test asserts the DUE decision rather than
pretending to assert the claim.

**One instance's failure is not the tick's failure.** Each runs in its own
try/except. `InstanceService.reconcile` already promises never to raise on an
unreachable controller — it records a degraded job — but "already promises" is not
a reason to let an unexpected error stop every other instance from syncing.

WHAT "DUE" MEANS
----------------
The cron is evaluated FROM THE LAST RUN, not from the clock: the next fire after
the most recent job's `started_at`. So a controller that has never reconciled is
due immediately, one that ran an hour ago under "0 3 * * *" is not due until 03:00
tomorrow, and a deployment that was down over its window catches up on the next
tick instead of skipping the night. `due_instances` is pure and takes the clock as
an argument, which is what makes all of that testable without waiting for 3am.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone

log = logging.getLogger("access.scheduler")

#: How often to look for due instances. The cron resolution is a minute, so
#: anything finer only costs queries.
TICK_SEC = int(os.getenv("VE_ACCESS_RECONCILE_TICK_SEC", "60"))


def enabled() -> bool:
    return os.getenv("VE_ACCESS_RECONCILE_SCHEDULER", "").lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Candidate:
    """What the due decision needs, and nothing else — so it can be built from a
    query in production and from a literal in a test."""

    instance_id: str
    cron: str | None
    #: The most recent job's `started_at`, or the instance's `created_at` when it
    #: has never run. Never None: an instance always has a creation time.
    last_run: datetime


def _next_fire(cron: str, after: datetime) -> datetime | None:
    """The first time this cron fires strictly after ``after``. None if it will not
    parse — a malformed cron must skip that instance, not stop the tick.

    FIVE FIELDS ONLY, and that restriction is load-bearing. croniter also accepts
    six- and seven-field forms, where the EXTRA LEADING FIELD IS SECONDS: a value
    of `* * * * * *` saved in this column parses happily and means "every second",
    which would be a full pull against a customer's controller once a second, for
    as long as the row exists. The column documents a five-field cron and its
    default is one; anything else is refused rather than silently reinterpreted.
    """
    fields = cron.split()
    if len(fields) != 5:
        log.warning(
            "ignoring reconciler_cron %r: expected 5 fields, got %d "
            "(a 6-field cron means SECONDS and is not what this column is for)",
            cron, len(fields),
        )
        return None
    try:
        from croniter import croniter
    except ImportError:  # pragma: no cover - the dependency is declared
        log.error("croniter is not installed; the reconcile scheduler cannot run")
        return None
    try:
        return croniter(cron, after).get_next(datetime)
    except (ValueError, KeyError, AttributeError) as exc:
        log.warning("ignoring unparseable reconciler_cron %r: %s", cron, exc)
        return None


def due_instances(candidates: list[Candidate], now: datetime) -> list[str]:
    """Which instances should reconcile at ``now``. Pure.

    An instance with no cron is not scheduled — that is how an operator turns the
    schedule off for one controller without disabling the controller.
    """
    due: list[str] = []
    for c in candidates:
        if not (c.cron or "").strip():
            continue
        last = c.last_run
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        nxt = _next_fire(c.cron.strip(), last)
        if nxt is not None and nxt <= now:
            due.append(c.instance_id)
    return due


# ── the claim ────────────────────────────────────────────────────────────────

def _lock_key(instance_id: str) -> int:
    """A stable 63-bit key for `pg_try_advisory_lock`. The instance id is a uuid
    string, so hash it here rather than relying on the database's `hashtext`,
    which is not a documented-stable function."""
    import hashlib

    digest = hashlib.sha256(instance_id.encode()).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFF_FFFF_FFFF_FFFF


def lock_available(database_url: str) -> bool:
    """Whether this database can hold the claim. False on SQLite, where the
    scheduler still works but two replicas would both fire — which is why the
    lifespan says so out loud rather than assuming one replica."""
    return "postgresql" in database_url


async def try_claim(session, instance_id: str, *, database_url: str) -> bool:
    """Take the per-instance lock on ``session``, for as long as it stays open."""
    if not lock_available(database_url):
        return True
    from sqlalchemy import text

    got = await session.execute(
        text("SELECT pg_try_advisory_lock(:k)").bindparams(k=_lock_key(instance_id))
    )
    return bool(got.scalar())


# ── the ticker ───────────────────────────────────────────────────────────────

_CANDIDATES_SQL = """
    SELECT i.id AS instance_id,
           i.reconciler_cron AS cron,
           COALESCE(
               (SELECT max(j.started_at) FROM access_sync_jobs j
                 WHERE j.instance_id = i.id),
               i.created_at
           ) AS last_run
      FROM access_instances i
     WHERE i.is_active
"""


class ReconcileScheduler:
    """One asyncio task. Start it in the lifespan; stop it on shutdown."""

    def __init__(self, sessionmaker, database_url: str) -> None:
        self._sm = sessionmaker
        self._url = database_url
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None:
            return
        if not lock_available(self._url):
            log.warning(
                "reconcile scheduler: this database has no advisory locks, so two "
                "replicas would both fire. Run ONE access replica, or use Postgres."
            )
        self._task = asyncio.create_task(self._run(), name="access-reconcile-scheduler")
        log.info("reconcile scheduler started (tick=%ss)", TICK_SEC)

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 — a bad tick must not end the loop
                log.exception("reconcile scheduler tick failed")
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=TICK_SEC)
            except asyncio.TimeoutError:
                pass

    async def tick(self) -> list[str]:
        """One pass. Returns the instances actually reconciled by THIS replica."""
        from sqlalchemy import text

        now = datetime.now(timezone.utc)
        async with self._sm() as session:
            rows = (await session.execute(text(_CANDIDATES_SQL))).mappings().all()
        candidates = [
            Candidate(str(r["instance_id"]), r["cron"], r["last_run"]) for r in rows
        ]
        ran: list[str] = []
        for instance_id in due_instances(candidates, now):
            try:
                if await self._reconcile_one(instance_id):
                    ran.append(instance_id)
            except Exception:  # noqa: BLE001 — one controller is not all of them
                log.exception("scheduled reconcile failed for instance %s", instance_id)
        return ran

    async def _reconcile_one(self, instance_id: str) -> bool:
        from kernel.auth import Scope

        from .service import InstanceService

        # One session for the claim AND the run: an advisory lock lives on the
        # session that took it, so a lock taken on a session that is then returned
        # to the pool protects nothing.
        async with self._sm() as session:
            if not await try_claim(session, instance_id, database_url=self._url):
                log.debug("instance %s is being reconciled elsewhere", instance_id)
                return False
            # Platform scope: the scheduler acts for the system, not for a user,
            # and every instance it was handed came from this database.
            svc = InstanceService(session, Scope(tenant_id=None, is_superadmin=True))
            job = await svc.reconcile(instance_id, trigger="schedule")
            log.info(
                "scheduled reconcile %s: %s (created=%s updated=%s deleted=%s errors=%s)",
                instance_id, job.status, job.created_count, job.updated_count,
                job.deleted_count, job.error_count,
            )
            return True
