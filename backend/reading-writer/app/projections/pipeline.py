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
event time) is copied to the `EVENTS_DLQ` stream — body intact, refusal reason in
`Nbt-Dlq-*` headers, the same subject scheme and header names the kernel and Go
buses use — and then `term()`'d, all on its FIRST delivery. Redelivering it
forever would block the batch behind it, and these consumers run
`max_deliver=-1`, so JetStream's own dead-letter trigger can never fire: without
the explicit copy there is no DLQ path at all. It used to be `ack()`'d, which was
a permanent silent drop — counted, logged, body nowhere (contract §18: two alerts
died exactly that way). Now it is parked for 30 days and counted twice:
`messages_malformed_total` (refused) and `messages_dead_lettered_total` (parked;
the two differing means a DLQ write failed and that body really is gone).

Only a *shape* refusal takes this path; a transient failure (database down) keeps
the retry/NAK behaviour above.

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
from kernel.events import dead_letter, ensure_dlq_stream
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import AckPolicy, ConsumerConfig
from sqlalchemy import text

from .config import ProjectorConfig
from .db import projections_db as database
from .ensure import SchemaRefused, ensure
from .extract import Malformed, extract
from .metrics import Metrics
from .registry import load
from .spec import ProjectionRow
from .store import write_batch
from .tenants import TenantResolver


def _is_timeout(exc: BaseException) -> bool:
    """True when the exception is a server-side statement cancellation.

    Matched on the class NAME rather than by importing asyncpg: this package only
    ever sees the driver through SQLAlchemy, and the wrapper class differs by
    version. `QueryCanceledError` is what `statement_timeout` raises.
    """
    names = {type(exc).__name__} | {
        type(c).__name__ for c in (exc.__cause__, exc.__context__) if c
    }
    return bool(names & {"QueryCanceledError", "QueryCanceledError_"}) or (
        "canceling statement due to statement timeout" in str(exc)
    )


def _delivery_count(msg) -> int:
    """This message's JetStream delivery count, defaulting to 1."""
    try:
        return int(msg.metadata.num_delivered)
    except Exception:  # noqa: BLE001 — metadata parse must never block an ack decision
        return 1


log = logging.getLogger("projector.pipeline")

# Consecutive fetch failures before the worker assumes its consumer is gone and
# recreates it. Small on purpose: three is enough to rule out a single flake,
# and every second spent "retrying" a deleted durable is a second the projection
# consumes nothing while looking alive.
REBIND_AFTER_FAILURES = 3


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

    def _consumer_config(self) -> ConsumerConfig:
        src = self.row.spec.source
        return ConsumerConfig(
            durable_name=src.durable,
            filter_subject=src.subject,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=float(self.cfg.ack_wait_sec),
            max_ack_pending=self.cfg.max_ack_pending,
            max_deliver=-1,      # never give up on an event
        )

    async def start(self, js) -> None:
        self._js = js
        src = self.row.spec.source
        await self._converge_consumer(js, src)
        # A DURABLE PULL consumer. Every replica of this service binds the SAME
        # durable name per projection, so NATS distributes messages between them.
        # That is the redundancy story: `--scale reading-writer=2`, no leader
        # election, nothing per-replica. Unchanged by the fold-in: the durable
        # names live in `reporting_projections` rows, not in this code, and they
        # still read `reporting-projector-*`. Renaming them would abandon a live
        # cursor and replay the stream to rediscover rows that are already there.
        self._psub = await js.pull_subscribe(
            src.subject, durable=src.durable, stream=src.stream,
            config=self._consumer_config(),
        )
        self._running = True
        self.pm.running = True
        self.pm.consuming = True
        # Arm the second proof and START ITS CLOCK. The stamp is not a claim the
        # consumer is healthy — `pull_subscribe` binds to whatever holds the
        # durable name, impostors included — it is the grace window, so a durable
        # that is NEVER confirmed still reds instead of sitting at an unset clock.
        self.pm.silence_limit_sec = self.cfg.fetch_silence_sec
        self.pm.note_consumer_seen()
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

    async def _rebind(self) -> None:
        """Recreate this projection's consumer and re-bind the pull subscription.

        The exit from the deleted-durable wedge: `pull_subscribe` with the full
        ConsumerConfig CREATES the durable when it is missing, exactly like the
        first bind at start. When the durable was genuinely deleted, the new one
        starts at the beginning of the stream and REPLAYS it — safe and correct
        here for the same reason `_converge_consumer` relies on: every write
        goes through the natural key, so a replay re-inserts nothing and shows
        up only as `rows_duplicate` while the projection catches back up.

        Failure is fine (NATS itself may be down): the fetch loop keeps failing,
        `consuming` stays False, /readyz stays red, and the next streak lands
        back here.
        """
        src = self.row.spec.source
        if self._psub is not None:
            # Drop the old subscription's inbox first; a dead psub held forever
            # would leak one core subscription per rebind.
            with contextlib.suppress(Exception):
                await self._psub.unsubscribe()
        try:
            self._psub = await self._js.pull_subscribe(
                src.subject, durable=src.durable, stream=src.stream,
                config=self._consumer_config(),
            )
        except Exception as exc:  # noqa: BLE001 — keep failing visibly, retry next streak
            self.m.note_error(exc)
            log.error(
                "projection %s: could not re-bind durable %s on %s: %s",
                self.row.key, src.durable, src.stream, exc,
            )
            return
        log.warning(
            "projection %s: re-bound durable %s on %s after repeated fetch failures — "
            "if the durable had been deleted, the stream REPLAYS from the start "
            "(idempotent: duplicates are absorbed by the natural key)",
            self.row.key, src.durable, src.stream,
        )

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
        failures = 0  # CONSECUTIVE failed pulls; any answered pull resets it
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
                #
                # An idle timeout is an ANSWER from a live consumer, so it also
                # resets the failure streak below.
                failures = 0
                self.pm.consuming = True
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a bad pull must not kill the loop
                # This branch used to sleep 1s and retry FOREVER — which, when
                # the durable had been deleted out of band, meant every pull
                # failed identically (ServiceUnavailableError), the projection
                # consumed nothing, and /readyz stayed green throughout. Now a
                # streak of failures (i) turns `consuming` off, which turns
                # /readyz red, and (ii) recreates the consumer, which is the
                # only exit when the durable is gone.
                self.m.note_error(exc)
                self.pm.fetch_failures += 1
                failures += 1
                log.warning(
                    "projection %s: fetch failed (%d in a row): %s",
                    self.row.key, failures, exc,
                )
                if failures >= REBIND_AFTER_FAILURES:
                    self.pm.consuming = False
                    await self._rebind()
                await asyncio.sleep(1.0)
                continue

            failures = 0
            self.pm.consuming = True
            self.pm.messages_received += len(msgs)
            keep, rows = [], []
            for msg in msgs:
                try:
                    rows.append(extract(msg.data, proj, self.tenants.resolve))
                    keep.append(msg)
                except Malformed as bad:
                    # Can never become a row, and redelivery cannot change that.
                    # Park the body in EVENTS_DLQ with the refusal in headers,
                    # then term() so it stops being redelivered — on the FIRST
                    # delivery, because with max_deliver=-1 there is no budget
                    # that would ever park it for us. (This used to ack(), which
                    # dropped the body permanently and silently — contract §18.)
                    self.pm.note_malformed(bad.reason)
                    log.warning(
                        "projection %s: malformed message on %s: %s — dead-lettering",
                        self.row.key, msg.subject, bad.reason,
                    )
                    if await dead_letter(
                        self._js, msg,
                        consumer=proj.source.durable,
                        reason=bad.reason,
                        delivery=_delivery_count(msg),
                    ):
                        self.pm.messages_dead_lettered += 1
                    with contextlib.suppress(Exception):
                        await msg.term()
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
                    # Mark the write in flight so the stall watchdog can see a
                    # write that never returns. `end_write` must run on EVERY exit
                    # path or a completed write would look stuck forever.
                    self.m.begin_write(self.row.key)
                    try:
                        async with sessionmaker() as session:
                            res = await write_batch(session, proj, rows)
                    finally:
                        self.m.end_write(self.row.key)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    self.pm.batch_write_failures += 1
                    if _is_timeout(exc):
                        # statement_timeout fired: a query that would have hung
                        # forever became an error the retry/NAK path can handle.
                        self.m.writes_timed_out += 1
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
                self.pm.rows_enriched += res.rows_enriched
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
        """Lag numbers, and the second liveness proof riding on the same call.

        The `consumer_info` here was always about lag. It is now also the only
        thing that can see a durable whose NAME is held by the wrong consumer:
        nats-py maps the server's 409 onto `nats.errors.TimeoutError`
        (`JetStreamContext._is_temporary_error` treats CONFLICT as temporary), so
        at the fetch call that wedge is byte-for-byte an idle domain. Measured,
        not argued: a push consumer put on `reporting-projector-access` held
        `projector_consuming` at 1 and `fetch_failures` at 0 for three minutes.

        Runs on the projector's own stats task, so it costs no consumer anything.
        """
        src = self.row.spec.source
        try:
            info = await self._js.consumer_info(src.stream, src.durable)
        except Exception as exc:  # noqa: BLE001
            # Deliberately NOT a rebind request. The fetch loop already handles a
            # DELETED durable on its own — pulls raise ServiceUnavailableError,
            # the failure streak fires and it re-binds in about three seconds,
            # verified on the live stack — so all this has to do is stop the gap
            # between the deletion and that recovery reading green.
            self.pm.note_consumer_missing(f"{type(exc).__name__}: {exc}"[:200])
            log.warning(
                "projection %s: consumer %s/%s could not be read: %s",
                self.row.key, src.stream, src.durable, exc,
            )
            return

        # PRESENT IS NOT ENOUGH — that is the whole finding. Deliberately not
        # auto-repaired here: `pull_subscribe` would bind to the impostor again
        # and report success, so a retry fixes nothing and only spins a counter.
        # `_converge_consumer` at worker start is still the repair path for a
        # filter that legitimately changed, and a restart applies it; a name taken
        # by somebody ELSE'S consumer is a human's decision, not this loop's.
        wrong = None
        if getattr(info.config, "deliver_subject", None):
            wrong = "it is a PUSH consumer; this projection pulls"
        elif (info.config.filter_subject or "") != src.subject:
            wrong = f"its filter is {info.config.filter_subject!r}, not {src.subject!r}"
        if wrong:
            self.pm.note_consumer_missing(wrong)
            log.error(
                "projection %s: durable %s/%s IS NOT OUR CONSUMER: %s — every pull will "
                "read as an idle timeout while nothing is projected",
                self.row.key, src.stream, src.durable, wrong,
            )
        else:
            self.pm.note_consumer_seen()

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
            # Its OWN connection, named apart from the readings one so two
            # consumers in one process stay two lines in `nats server report
            # connections` — see app/main.py on why they must not share.
            name="neubit-reading-writer-projections",
            max_reconnect_attempts=-1,     # never give up; the backlog is durable
            disconnected_cb=_disconnected,
            reconnected_cb=_reconnected,
        )
        self.m.nats_connected = True
        self._js = self._nc.jetstream()

        # The dead-letter stream poison messages are parked in, so the workers'
        # term() is "stop redelivering", never "throw away". Python owns this
        # stream's limit convergence (contract §4). Never raises.
        await ensure_dlq_stream(self._js)

        self._running = True
        await self.reload()
        self._tasks = [
            asyncio.create_task(self._reload_loop(), name="pj-reload"),
            asyncio.create_task(self._stall_loop(), name="pj-stall"),
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

    # ── stuck-write watchdog ──────────────────────────────────────────────────
    async def _stall_loop(self) -> None:
        """Turn a projection write that HANGS into a red health check.

        Same failure as the reading-writer's: a frozen Postgres does not drop the
        connection, so the write neither returns nor raises, `db_healthy` stays
        true and /readyz stays green while nothing is being projected. Nothing is
        lost (no ack happens) but nothing says so. Observation only — cancelling
        an asyncpg query needs a SECOND connection to send the cancel request,
        which against a frozen server hangs exactly like the first.
        """
        warned = False
        while self._running:
            await asyncio.sleep(1.0)
            stalled = self.m.write_stalled_sec()
            if stalled >= self.cfg.write_stall_sec:
                if not warned:
                    self.m.writes_timed_out += 1
                    log.error(
                        "DATABASE STUCK: a projection batch write has been in flight for "
                        "%ss (threshold %ss) — not failing, not returning. Nothing is "
                        "acked, so nothing is lost, but nothing is being written either.",
                        stalled, self.cfg.write_stall_sec,
                    )
                    warned = True
                self.m.db_healthy = False
            elif warned and stalled == 0.0:
                log.info("projection write completed after a stall — resuming")
                warned = False

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
                        "%s: rows=%s enriched=%s dup=%s batches=%s malformed=%s "
                        "pending=%s queue=%s/%s db=%s",
                        key, pm.rows_inserted, pm.rows_enriched, pm.rows_duplicate,
                        pm.batches_written,
                        pm.messages_malformed, pm.consumer_pending, pm.queue_depth,
                        pm.queue_capacity, "up" if self.m.db_healthy else "DOWN",
                    )
