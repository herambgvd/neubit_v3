"""The consumer: bus → extract → buffer → batch write → ack. In that order.

SHAPE
-----
One worker per projection. Two tasks and a bounded queue inside each::

    JetStream ──fetch(N, T)──► fetcher ──queue(maxsize=B)──► writer ──commit──► ack

* **The fetcher** pulls up to `batch_rows` messages, waiting at most `batch_ms` —
  so a batch closes on N rows or T milliseconds, whichever comes first, and the
  code path is identical at four events an hour and four thousand a second.
* **The queue** is the buffer. The fetcher keeps pulling while the previous batch
  is still committing, so one slow write does not stall reception.
* **The writer** commits one transaction, and ONLY THEN acks.

WHY THIS NEVER BLOCKS THE BUS ON THE DATABASE
---------------------------------------------
A publisher's `js.publish` is acked by the NATS *server* the moment the message is
persisted to the stream. Nothing this service does can delay that. If the database
is slow the queue fills, the fetcher stops asking for more, and the backlog sits
in JetStream — where it is visible as `consumer_pending`. Slow is slow; it never
becomes backpressure on the access service and it never becomes a drop.

ACK SEMANTICS, AND WHAT A FAILED BATCH DOES
-------------------------------------------
Messages are acked ONLY after the batch is committed. A batch is one transaction,
so a failure mid-write leaves nothing behind — there is no half-written batch to
reason about. On failure the writer retries in place a couple of times (a
two-second blip is not worth a redelivery storm) and then **NAKs the whole batch
with a delay**. Nothing was acked, so JetStream redelivers it: the events are
still in the stream and still get written. The redelivered batch may re-insert
rows a successful retry already stored, and `ON CONFLICT DO NOTHING` makes that
a no-op.

The alternative — ack first, write later — is faster and loses data on every
crash. It is not on the table.

WHEN THE DATABASE IS DOWN
-------------------------
After a batch exhausts its retries the writer marks the database unhealthy and
every fetcher PAUSES rather than spinning: pulling messages it cannot write just
burns ack_wait timers and inflates redelivery counts. A prober runs `SELECT 1`
every couple of seconds and un-pauses them when the database answers. Each
consumer's backlog drains from wherever it stopped.

MALFORMED MESSAGES
------------------
A message that can never become a row (missing a required field, an unparseable
event time) is acked and counted under `projector_messages_malformed_total` with
a reason label. Redelivering it forever would block the batch behind it. This is
the one place the projector discards data, and it is counted and logged so it is
never silent.

A NOTE ON THE `EVENTS` STREAM
-----------------------------
This service does NOT create or converge `EVENTS` — `kernel.events` does, and one
owner is the point. If a projection's subject is not captured by its stream, the
durable consumer cannot be created; that is reported by name into `refused` and
turns `/readyz` red, instead of a consumer that silently receives nothing. The
usual cause is a domain missing from `kernel.events.EVENTS_SUBJECTS`.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

import nats
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import AckPolicy, ConsumerConfig
from reporting.db import database
from sqlalchemy import text

from .config import ProjectorConfig
from .ensure import SchemaRefused, ensure
from .extract import Malformed, extract
from .metrics import Metrics
from .registry import load
from .spec import ProjectionRow
from .store import write_batch
from .tenants import TenantResolver

log = logging.getLogger("projector.pipeline")


class Worker:
    """One projection's consumer. Owns its durable, its queue and its two tasks."""

    def __init__(
        self, row: ProjectionRow, cfg: ProjectorConfig, metrics: Metrics, tenants: TenantResolver
    ) -> None:
        self.row = row
        self.cfg = cfg
        self.m = metrics
        self.pm = metrics.projection(row.key)
        self.pm.relation = row.spec.target.relation
        self.pm.subject = row.spec.source.subject
        self.pm.durable = row.spec.source.durable
        self.pm.queue_capacity = cfg.queue_batches
        self.tenants = tenants
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=cfg.queue_batches)
        self._tasks: list[asyncio.Task] = []
        self._psub = None
        self._js = None
        self._running = False

    async def start(self, js) -> None:
        self._js = js
        src = self.row.spec.source
        await self._converge_consumer(js, src)
        cfg = ConsumerConfig(
            durable_name=src.durable,
            filter_subject=src.subject,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=float(self.cfg.ack_wait_sec),
            max_ack_pending=self.cfg.max_ack_pending,
            max_deliver=-1,      # never give up on an event
        )
        # A DURABLE PULL consumer. Every replica of this service binds the SAME
        # durable name per projection, so NATS distributes messages between them.
        # That is the redundancy story: `--scale reporting-projector=2`, no leader
        # election, nothing per-replica.
        self._psub = await js.pull_subscribe(
            src.subject, durable=src.durable, stream=src.stream, config=cfg
        )
        self._running = True
        self.pm.running = True
        self._tasks = [
            asyncio.create_task(self._fetch_loop(), name=f"pj-fetch-{self.row.key}"),
            asyncio.create_task(self._write_loop(), name=f"pj-write-{self.row.key}"),
        ]
        log.info(
            "projection %s: bound durable %s on %s (filter=%s) → %s",
            self.row.key, src.durable, src.stream, src.subject, self.row.spec.target.relation,
        )

    async def _converge_consumer(self, js, src) -> None:
        """Delete a durable whose FILTER no longer matches the spec, so it can be
        recreated on the new one.

        NATS refuses to change a durable consumer's `filter_subject` in place, and
        `pull_subscribe` against a mismatched durable fails with an error that
        reads like a bug in this service rather than a change in the spec. The
        only way through is to drop and recreate.

        What that costs is a REPLAY: the new consumer starts at the beginning of
        the stream and redelivers everything the subject matches. That is safe
        here and nowhere near an accident — every write goes through the natural
        key with `ON CONFLICT DO NOTHING`, so a replay re-inserts nothing and
        shows up only as `rows_duplicate`. It is also the useful behaviour: a
        widened filter BACKFILLS the events the old filter was skipping, instead
        of leaving a hole from the beginning of time to the moment somebody
        edited the row.
        """
        try:
            info = await js.consumer_info(src.stream, src.durable)
        except Exception:  # noqa: BLE001 — no such consumer yet, which is the normal case
            return
        current = getattr(info.config, "filter_subject", None)
        if current == src.subject:
            return
        log.warning(
            "projection %s: durable %s has filter %r but the spec says %r — "
            "recreating it, which REPLAYS the stream (idempotent: duplicates are "
            "absorbed by the natural key)",
            self.row.key, src.durable, current, src.subject,
        )
        with contextlib.suppress(Exception):
            await js.delete_consumer(src.stream, src.durable)

    async def stop(self) -> None:
        self._running = False
        self.pm.running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._tasks = []

    # ── fetcher ───────────────────────────────────────────────────────────────
    async def _fetch_loop(self) -> None:
        timeout = max(self.cfg.batch_ms, 1) / 1000.0
        proj = self.row.spec
        while self._running:
            if not self.m.db_healthy:
                # Nothing to gain from pulling messages we cannot write; the
                # backlog is safe in the stream and the prober will wake us.
                await asyncio.sleep(self.cfg.db_retry_sec)
                continue
            try:
                msgs = await self._psub.fetch(self.cfg.batch_rows, timeout=timeout)
            except (NatsTimeoutError, asyncio.TimeoutError):
                # Idle domain — the T half of "N rows or T ms". BOTH exceptions:
                # nats-py raises its own TimeoutError when the pull request
                # expires server-side and asyncio's when the client-side wait
                # does, and treating the second as an error made an idle feed
                # log a warning every second and park a spurious `last_error` on
                # /stats. A health surface that cries wolf while nothing is wrong
                # is worse than no health surface.
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a bad pull must not kill the loop
                self.m.note_error(exc)
                log.warning("projection %s: fetch failed: %s", self.row.key, exc)
                await asyncio.sleep(1.0)
                continue

            self.pm.messages_received += len(msgs)
            keep, rows = [], []
            for msg in msgs:
                try:
                    rows.append(extract(msg.data, proj, self.tenants.resolve))
                    keep.append(msg)
                except Malformed as bad:
                    # Can never become a row. Ack it — an un-ackable poison
                    # message would be redelivered forever — but COUNT it.
                    self.pm.note_malformed(bad.reason)
                    log.warning(
                        "projection %s: dropping malformed message on %s: %s",
                        self.row.key, msg.subject, bad.reason,
                    )
                    with contextlib.suppress(Exception):
                        await msg.ack()
            self.m.unmapped_tenant_keys = len(self.tenants.unmapped)

            if rows:
                # Blocks when the buffer is full. That block IS the backpressure:
                # we stop pulling, the stream holds the backlog, lag becomes
                # visible. Nothing is dropped.
                await self._queue.put((keep, rows))
                self.pm.queue_depth = self._queue.qsize()

    # ── writer ────────────────────────────────────────────────────────────────
    async def _write_loop(self) -> None:
        sessionmaker = database.get_sessionmaker()
        proj = self.row.spec
        while self._running:
            msgs, rows = await self._queue.get()
            self.pm.queue_depth = self._queue.qsize()

            res = None
            for attempt in range(self.cfg.db_retry_attempts + 1):
                try:
                    async with sessionmaker() as session:
                        res = await write_batch(session, proj, rows)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    self.pm.batch_write_failures += 1
                    self.m.note_error(exc)
                    log.warning(
                        "projection %s: batch write failed (attempt %s/%s, %s rows): %s",
                        self.row.key, attempt + 1, self.cfg.db_retry_attempts + 1,
                        len(rows), exc,
                    )
                    if attempt < self.cfg.db_retry_attempts:
                        await asyncio.sleep(self.cfg.db_retry_sec * (2 ** attempt))

            if res is not None:
                self.m.db_healthy = True
                self.pm.batches_written += 1
                self.pm.rows_inserted += res.rows_inserted
                self.pm.rows_duplicate += res.duplicates
                self.pm.last_write_at = time.time()
                for msg in msgs:
                    try:
                        await msg.ack()
                    except Exception as exc:  # noqa: BLE001
                        # The rows ARE stored; a lost ack only costs a redelivery,
                        # which ON CONFLICT DO NOTHING absorbs.
                        log.warning(
                            "projection %s: ack failed after a successful write: %s",
                            self.row.key, exc,
                        )
            else:
                # NOTHING was acked. The batch goes back to JetStream and comes
                # round again — this is the property the whole design exists for.
                self.m.db_healthy = False
                self.pm.batches_nakd += 1
                log.error(
                    "projection %s: batch of %s events NAK'd for redelivery — "
                    "database unavailable",
                    self.row.key, len(rows),
                )
                for msg in msgs:
                    with contextlib.suppress(Exception):
                        await msg.nak(delay=self.cfg.db_retry_sec)

            self._queue.task_done()

    # ── lag ───────────────────────────────────────────────────────────────────
    async def poll_stats(self) -> None:
        src = self.row.spec.source
        try:
            info = await self._js.consumer_info(src.stream, src.durable)
        except Exception as exc:  # noqa: BLE001
            log.debug("projection %s: consumer_info unavailable: %s", self.row.key, exc)
            return
        self.pm.consumer_pending = info.num_pending or 0
        self.pm.consumer_ack_pending = info.num_ack_pending or 0
        self.pm.consumer_redelivered = info.num_redelivered or 0


class Projector:
    """Supervises one worker per registered projection, and re-reads the registry."""

    def __init__(self, cfg: ProjectorConfig, metrics: Metrics) -> None:
        self.cfg = cfg
        self.m = metrics
        self.tenants = TenantResolver(cfg.tenant_map, cfg.default_tenant)
        self._workers: dict[str, Worker] = {}
        self._specs: dict[str, str] = {}   # key -> serialized spec, to spot a change
        self._nc = None
        self._js = None
        self._tasks: list[asyncio.Task] = []
        self._running = False

    async def start(self, nats_url: str) -> None:
        if not nats_url:
            log.warning("VE_NATS_URL is unset — the projector has nothing to consume")
            return

        async def _disconnected() -> None:
            self.m.nats_connected = False
            log.warning("NATS disconnected")

        async def _reconnected() -> None:
            self.m.nats_connected = True
            log.info("NATS reconnected")

        self._nc = await nats.connect(
            nats_url,
            name="neubit-reporting-projector",
            max_reconnect_attempts=-1,     # never give up; the backlog is durable
            disconnected_cb=_disconnected,
            reconnected_cb=_reconnected,
        )
        self.m.nats_connected = True
        self._js = self._nc.jetstream()

        self._running = True
        await self.reload()
        self._tasks = [
            asyncio.create_task(self._reload_loop(), name="pj-reload"),
            asyncio.create_task(self._probe_loop(), name="pj-probe"),
            asyncio.create_task(self._stats_loop(), name="pj-stats"),
        ]

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._tasks = []
        for w in list(self._workers.values()):
            await w.stop()
        self._workers.clear()
        if self._nc is not None:
            with contextlib.suppress(Exception):
                await self._nc.drain()
            self._nc = None

    # ── registry reconciliation ───────────────────────────────────────────────
    async def reload(self) -> None:
        """Bring the running workers in line with the registry table."""
        sessionmaker = database.get_sessionmaker()
        try:
            async with sessionmaker() as session:
                rows, bad = await load(session)
        except Exception as exc:  # noqa: BLE001 — a registry read failure is not fatal
            self.m.db_healthy = False
            self.m.note_error(exc)
            log.warning("could not read the projection registry: %s", exc)
            return

        self.m.db_healthy = True
        self.m.last_reload_at = time.time()
        refused = dict(bad)

        # Stop workers whose projection was removed, disabled, or CHANGED. A spec
        # change has to restart the worker: its columns, its natural key and its
        # subject are all baked into the consumer and the statement.
        for key in list(self._workers):
            serialized = rows[key].spec.model_dump_json() if key in rows else None
            if serialized is None or serialized != self._specs.get(key):
                log.info("projection %s: stopping (removed or changed)", key)
                await self._workers.pop(key).stop()
                self._specs.pop(key, None)

        for key, row in rows.items():
            if key in self._workers:
                continue
            try:
                await self._start_one(row)
            except SchemaRefused as exc:
                refused[key] = str(exc)
                log.error("projection %s refused: %s", key, exc)
            except Exception as exc:  # noqa: BLE001
                refused[key] = f"{type(exc).__name__}: {exc}"[:400]
                self.m.note_error(exc)
                log.exception("projection %s could not be started", key)

        self.m.refused = refused

    async def _start_one(self, row: ProjectionRow) -> None:
        if self.cfg.ensure_relations:
            engine = database.get_engine()
            # AUTOCOMMIT: `CREATE MATERIALIZED VIEW ... WITH
            # (timescaledb.continuous)` cannot run inside a transaction block, and
            # neither can several of the policy functions.
            async with engine.connect() as conn:
                await conn.execution_options(isolation_level="AUTOCOMMIT")
                await ensure(conn, row)
        worker = Worker(row, self.cfg, self.m, self.tenants)
        await worker.start(self._js)
        self._workers[row.key] = worker
        self._specs[row.key] = row.spec.model_dump_json()

    async def _reload_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.cfg.reload_sec)
            with contextlib.suppress(asyncio.CancelledError):
                try:
                    await self.reload()
                except Exception as exc:  # noqa: BLE001
                    self.m.note_error(exc)
                    log.warning("registry reload failed: %s", exc)

    # ── database health prober ────────────────────────────────────────────────
    async def _probe_loop(self) -> None:
        engine = database.get_engine()
        while self._running:
            await asyncio.sleep(self.cfg.db_retry_sec)
            if self.m.db_healthy:
                continue
            try:
                async with engine.connect() as conn:
                    await conn.execute(text("SELECT 1"))
                self.m.db_healthy = True
                log.info("database is back — resuming consumption")
            except Exception:  # noqa: BLE001 — still down, keep waiting quietly
                pass

    # ── lag reporting ─────────────────────────────────────────────────────────
    async def _stats_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.cfg.stats_every_sec)
            for worker in list(self._workers.values()):
                await worker.poll_stats()
            for key, pm in sorted(self.m.projections.items()):
                if not pm.running:
                    continue
                if pm.consumer_pending > self.cfg.lag_warn:
                    log.warning(
                        "FALLING BEHIND: projection %s has %s messages pending "
                        "(threshold %s)", key, pm.consumer_pending, self.cfg.lag_warn,
                    )
                else:
                    log.info(
                        "%s: rows=%s dup=%s batches=%s malformed=%s pending=%s "
                        "queue=%s/%s db=%s",
                        key, pm.rows_inserted, pm.rows_duplicate, pm.batches_written,
                        pm.messages_malformed, pm.consumer_pending, pm.queue_depth,
                        pm.queue_capacity, "up" if self.m.db_healthy else "DOWN",
                    )
