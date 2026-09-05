"""The consumer: bus → parse → buffer → batch write → ack. In that order.

SHAPE
-----
Two tasks and a bounded queue between them::

    JetStream ──fetch(N, T)──► fetcher ──queue(maxsize=B)──► writer ──commit──► ack

* **The fetcher** pulls up to ``batch_rows`` messages, waiting at most
  ``batch_ms`` — so a batch closes on N rows or T milliseconds, whichever comes
  first, and the code path is identical at 10 readings/min and 10,000/sec.
* **The queue** is the buffer. It lets the fetcher keep pulling while the
  previous batch is still committing, so one slow write does not stall reception.
* **The writer** commits one transaction, and only then acks.

WHY THIS NEVER BLOCKS THE BUS ON THE DATABASE
---------------------------------------------
The gateway's ``js.Publish`` is acked by the NATS *server* the moment the message
is persisted to the stream. Nothing this service does can delay that. If the
database is slow the queue fills, the fetcher stops asking for more, and the
backlog sits in JetStream — where it is bounded, sized for it, and visible as
``consumer_pending``. Slow is slow; it never becomes backpressure on the gateway
and it never becomes a drop.

ACK SEMANTICS, AND WHAT A FAILED BATCH DOES
-------------------------------------------
Messages are acked ONLY after the batch is committed. A batch is one transaction
(``app.store.write_batch``), so a failure mid-write leaves nothing behind — there
is no half-written batch to reason about. On failure the writer retries in place
a couple of times (a two-second blip is not worth a redelivery storm) and then
**NAKs the whole batch with a delay**. Nothing was acked, so JetStream redelivers
it: the readings are still in the stream and still get written. The redelivered
batch may re-insert rows a successful retry already stored, and
``ON CONFLICT DO NOTHING`` makes that a no-op.

The alternative — ack first, write later — is faster and loses data on every
crash. It is not on the table.

WHEN THE DATABASE IS DOWN
-------------------------
After a batch exhausts its retries the writer marks the database unhealthy and
the fetcher PAUSES rather than spinning: pulling messages it cannot write just
burns ack_wait timers and inflates redelivery counts. A prober runs ``SELECT 1``
every couple of seconds and un-pauses the fetcher when the database answers. The
consumer's backlog drains from wherever it stopped.

MALFORMED MESSAGES
------------------
A message that can never become a row (no ``point_id``, unparseable ``ts``) is
copied to the ``EVENTS_DLQ`` stream — body intact, refusal reason in ``Nbt-Dlq-*``
headers, same subject scheme and header names as the kernel and Go buses — and
then ``term()``'d, all on its FIRST delivery. Redelivering it forever would block
the batch behind it, and this consumer runs ``max_deliver=-1``, so JetStream's
own dead-letter trigger can never fire: without the explicit copy there would be
no DLQ path at all. It used to be ``ack()``'d instead, which was a PERMANENT
SILENT DROP — counted and logged, but the body was nowhere and nothing could
replay it (contract §18). Now it is parked for 30 days and counted twice:
``messages_malformed_total`` (refused) and ``messages_dead_lettered_total``
(parked; the two differing means a DLQ write failed and the body really is gone).

Only a *shape* refusal takes this path. A transient failure (database down) keeps
its retry/NAK behaviour above — terminating on an outage would turn every blip
into data loss.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

import nats
from nats.errors import TimeoutError as NatsTimeoutError
from kernel.events import dead_letter, ensure_dlq_stream
from nats.js.api import (
    AckPolicy,
    ConsumerConfig,
    DiscardPolicy,
    RetentionPolicy,
    StorageType,
    StreamConfig,
)
from reporting.db import database
from sqlalchemy import text

from .config import WriterConfig
from .envelope import Malformed, parse
from .metrics import Metrics
from .store import PointCache, write_batch
from .tenants import TenantResolver


def _is_timeout(exc: BaseException) -> bool:
    """True when the exception is a server-side statement/query cancellation.

    Matched on the class NAME rather than by importing asyncpg: this package only
    ever sees the driver through SQLAlchemy, and the wrapper class differs by
    version. `QueryCanceledError` is what `statement_timeout` raises.
    """
    names = {type(exc).__name__} | {type(c).__name__ for c in (exc.__cause__, exc.__context__) if c}
    return bool(names & {"QueryCanceledError", "CancelledError_", "QueryCanceledError_"}) or (
        "canceling statement due to statement timeout" in str(exc)
    )


def _delivery_count(msg) -> int:
    """This message's JetStream delivery count, defaulting to 1."""
    try:
        return int(msg.metadata.num_delivered)
    except Exception:  # noqa: BLE001 — metadata parse must never block an ack decision
        return 1


log = logging.getLogger("reading-writer.pipeline")

# Consecutive failed pulls before the fetch loop recreates its own consumer.
# Same number as the projections half uses, and for the same reason: two or three
# failures in a row is a hiccup you wait out, a fourth is a durable that is not
# coming back on its own. Deliberately NOT 1 — a rebind can cost a full stream
# replay (see `_rebind`), which is far too expensive to spend on a blip.
REBIND_AFTER_FAILURES = 3


class Pipeline:
    def __init__(self, cfg: WriterConfig, metrics: Metrics) -> None:
        self.cfg = cfg
        self.m = metrics
        self.m.queue_capacity = cfg.queue_batches
        # Arm the fetch-liveness check. Metrics defaults it to 0 (disabled) so
        # that a Metrics object nobody is driving — a test, or /stats before the
        # pipeline has started — cannot report itself wedged.
        self.m.silence_limit_sec = cfg.fetch_silence_sec
        self.tenants = TenantResolver.from_env()
        self.cache = PointCache(cfg.point_touch_sec)
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=cfg.queue_batches)
        self._tasks: list[asyncio.Task] = []
        self._nc = None
        self._js = None
        self._psub = None
        self._running = False
        # Set by the stats loop when `consumer_info` says the durable is gone,
        # and acted on by the FETCH loop. The rebind stays in the one task that
        # owns `_psub`: swapping the subscription out from under a fetch in
        # flight is a race nobody would ever reproduce on purpose.
        self._rebind_requested = False

    # ── lifecycle ─────────────────────────────────────────────────────────────
    async def start(self, nats_url: str) -> None:
        if not nats_url:
            log.warning("VE_NATS_URL is unset — the writer has nothing to consume")
            return

        async def _disconnected() -> None:
            self.m.nats_connected = False
            log.warning("NATS disconnected")

        async def _reconnected() -> None:
            self.m.nats_connected = True
            log.info("NATS reconnected")

        self._nc = await nats.connect(
            nats_url,
            name="neubit-reading-writer",
            max_reconnect_attempts=-1,     # never give up; the backlog is durable
            disconnected_cb=_disconnected,
            reconnected_cb=_reconnected,
        )
        self.m.nats_connected = True
        self._js = self._nc.jetstream()

        await self._ensure_stream()
        # The dead-letter stream poison messages are parked in, so the term()
        # in the fetch loop is "stop redelivering", never "throw away". Python
        # owns this stream's limit convergence (contract §4), and this service
        # can connect before any kernel-bus service has created it. Never raises.
        await ensure_dlq_stream(self._js)
        await self._bind_consumer()

        self._running = True
        self._tasks = [
            asyncio.create_task(self._fetch_loop(), name="rw-fetch"),
            asyncio.create_task(self._write_loop(), name="rw-write"),
            asyncio.create_task(self._stall_loop(), name="rw-stall"),
            asyncio.create_task(self._probe_loop(), name="rw-probe"),
            asyncio.create_task(self._stats_loop(), name="rw-stats"),
        ]

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._tasks = []
        if self._nc is not None:
            with contextlib.suppress(Exception):
                await self._nc.drain()
            self._nc = None

    # ── JetStream setup ───────────────────────────────────────────────────────
    def _stream_config(self) -> StreamConfig:
        c = self.cfg
        return StreamConfig(
            name=c.stream,
            # The WHOLE iot namespace: readings AND alerts. Both are sensor-rate
            # traffic and neither belongs on the unbounded EVENTS stream. This
            # service consumes only the reading half (see WriterConfig.subject).
            subjects=["tenant.*.iot.>"],
            retention=RetentionPolicy.LIMITS,
            discard=DiscardPolicy.OLD,
            storage=StorageType.FILE,
            max_bytes=c.stream_max_bytes,
            max_age=float(c.stream_max_age_sec),
            max_msg_size=c.stream_max_msg_size,
            num_replicas=1,
        )

    async def _ensure_stream(self) -> None:
        """Create IOT_READINGS, or converge an existing one onto the configured limits.

        NOTE: this can only succeed once ``EVENTS`` has stopped claiming
        ``tenant.>`` — NATS refuses overlapping subjects between two streams on
        one account. Core and kernel narrow EVENTS to an explicit domain list on
        connect (``EVENTS_SUBJECTS``); if this raises with an overlap error, that
        narrowing has not happened yet.
        """
        if not self.cfg.ensure_stream:
            log.info("VE_READINGS_ENSURE_STREAM=0 — binding %s as-is", self.cfg.stream)
            return
        want = self._stream_config()
        try:
            info = await self._js.stream_info(self.cfg.stream)
        except Exception:
            await self._js.add_stream(want)
            log.info(
                "created stream %s subjects=%s max_bytes=%s max_age=%ss",
                want.name, want.subjects, want.max_bytes, want.max_age,
            )
            return

        cur = info.config
        drift = (
            sorted(cur.subjects or []) != sorted(want.subjects)
            or cur.max_bytes != want.max_bytes
            or (cur.max_age or 0) != want.max_age
            or cur.max_msg_size != want.max_msg_size
            or cur.discard != want.discard
        )
        if drift:
            await self._js.update_stream(want)
            log.info("converged stream %s onto configured limits", want.name)

    def _consumer_config(self) -> ConsumerConfig:
        c = self.cfg
        # A DURABLE PULL consumer. Every replica binds the SAME durable name, so
        # NATS distributes messages between them — that is the redundancy story
        # with no coordination code, no leader election, nothing per-replica.
        return ConsumerConfig(
            durable_name=c.durable,
            filter_subject=c.subject,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=float(c.ack_wait_sec),
            max_ack_pending=c.max_ack_pending,
            max_deliver=-1,       # never give up on a reading
        )

    async def _bind_consumer(self) -> None:
        c = self.cfg
        self._psub = await self._js.pull_subscribe(
            c.subject, durable=c.durable, stream=c.stream, config=self._consumer_config()
        )
        # START THE CLOCK, then ask. The stamp is not a claim that the consumer is
        # healthy — it is the grace window: `consumer_unconfirmed_sec` measures
        # from here, so a durable that is NEVER confirmed still reds after
        # `fetch_silence_sec` instead of sitting at an unset clock forever. Then
        # ask, because a successful subscribe proves nothing: nats-py's
        # `pull_subscribe` binds happily to whatever holds the durable name,
        # including a PUSH consumer whose every pull comes back as an idle
        # timeout. Measured, not reasoned about — an impostor consumer accepted
        # the subscribe and then answered minutes of pulls with silence.
        log.info(
            "bound durable pull consumer %s on %s (filter=%s, ack_wait=%ss, "
            "max_ack_pending=%s)",
            c.durable, c.stream, c.subject, c.ack_wait_sec, c.max_ack_pending,
        )
        self.m.note_consumer_seen()
        # Ordered AFTER the line above so that when the durable turns out to be
        # someone else's, the ERROR is the last word rather than the reassurance.
        await self._confirm_consumer()

    async def _confirm_consumer(self):
        """Ask JetStream whether our durable exists and is OUR pull consumer.

        The second of the two proofs behind `consuming`, and the only one that
        can see a durable deleted or taken over out of band: nats-py maps the
        server's 409 onto `nats.errors.TimeoutError`
        (`JetStreamContext._is_temporary_error` treats CONFLICT as temporary),
        so at the fetch call a vanished consumer is byte-for-byte an idle feed.

        Runs on the stats task, never on the write path. Returns the ConsumerInfo
        when it is ours, else None — and requests a rebind, because the fetch
        loop will never ask for one on its own.
        """
        c = self.cfg
        try:
            info = await self._js.consumer_info(c.stream, c.durable)
        except Exception as exc:  # noqa: BLE001
            self.m.note_consumer_missing(f"{type(exc).__name__}: {exc}"[:200])
            self._rebind_requested = True
            log.warning(
                "consumer %s/%s could not be read (%s) — the fetch loop cannot see "
                "this, its pulls just look idle; asking it to re-bind",
                c.stream, c.durable, exc,
            )
            return None

        # PRESENT IS NOT ENOUGH. A durable of the right name can be the wrong
        # consumer — push, or pull on a different filter — and then every pull is
        # a 409 the client reports as a timeout. Deliberately NOT auto-repaired by
        # deleting it: this service's filter comes from VE_READINGS_SUBJECT, not
        # from a table an operator edits, so a mismatch means something else is
        # using this durable name and silently destroying its consumer is not a
        # decision this loop should make. Stay red, say exactly what is wrong, let
        # a human choose. (app/projections DOES converge its durables, because
        # there the filter genuinely changes underneath it — `_converge_consumer`.)
        wrong = None
        if getattr(info.config, "deliver_subject", None):
            wrong = "it is a PUSH consumer; this service pulls"
        elif (info.config.filter_subject or "") != c.subject:
            wrong = f"its filter is {info.config.filter_subject!r}, not {c.subject!r}"
        if wrong:
            # No rebind requested, unlike the absent case: `pull_subscribe` would
            # simply bind to the impostor again and report success, so asking for
            # one would spin a counter and fix nothing. Red and loud is the whole
            # remedy this loop is entitled to.
            self.m.note_consumer_missing(wrong)
            log.error(
                "durable %s/%s IS NOT OUR CONSUMER: %s — every pull will read as an "
                "idle timeout while nothing is consumed",
                c.stream, c.durable, wrong,
            )
            return None

        self.m.note_consumer_seen()
        return info

    async def _rebind(self) -> None:
        """Recreate the readings consumer and re-bind the pull subscription.

        The only exit from the deleted-durable wedge: `pull_subscribe` with the
        full ConsumerConfig CREATES the durable when it is missing, exactly as
        the first bind at start does.

        WHAT IT COSTS, because it is not free. A durable that was genuinely
        deleted left no cursor to inherit, so the new one starts at the head of
        IOT_READINGS and REPLAYS it — on this stream that is a week of readings.
        It is correct rather than merely tolerable: every row goes in through the
        natural key with ON CONFLICT DO NOTHING (`app.store.write_batch`), so a
        replay stores nothing twice and shows up only as `rows_duplicate`, and
        anything the deleted durable had not yet delivered is redelivered instead
        of being lost. But it is real work for the writer, which is why nothing
        reaches here on a single bad pull: either REBIND_AFTER_FAILURES
        consecutive pull failures, or `_confirm_consumer` finding the durable
        actually gone.

        Failure here is fine — NATS itself may be down. The loop keeps failing,
        the heartbeat keeps going stale, /readyz stays red, and the next streak
        lands back here.
        """
        c = self.cfg
        if self._psub is not None:
            # Drop the dead subscription's inbox first, or every rebind leaks one
            # core subscription for the life of the process.
            with contextlib.suppress(Exception):
                await self._psub.unsubscribe()
        try:
            self._psub = await self._js.pull_subscribe(
                c.subject, durable=c.durable, stream=c.stream,
                config=self._consumer_config(),
            )
        except Exception as exc:  # noqa: BLE001 — keep failing visibly, retry next streak
            self.m.note_error(exc)
            log.error("could not re-bind durable %s on %s: %s", c.durable, c.stream, exc)
            return
        self.m.consumer_rebinds += 1
        # Deliberately NOT `note_consumer_seen()`. A subscribe that returned
        # without raising is not evidence the right consumer is there — it binds
        # to whatever holds the name. Only `_confirm_consumer` may clear this,
        # and it runs on the next stats tick; a rebind that fixed nothing leaves
        # /readyz red, which is the entire point.
        log.warning(
            "re-bound durable %s on %s after repeated fetch failures — if the durable "
            "had been deleted, %s REPLAYS from the start (idempotent: duplicates are "
            "absorbed by ON CONFLICT DO NOTHING and counted as rows_duplicate)",
            c.durable, c.stream, c.stream,
        )

    # ── fetcher ───────────────────────────────────────────────────────────────
    async def _fetch_loop(self) -> None:
        timeout = max(self.cfg.batch_ms, 1) / 1000.0
        failures = 0  # CONSECUTIVE failed pulls; any answered pull resets it
        self.m.note_fetch_answer()
        while self._running:
            if not self.m.db_healthy:
                # Nothing to gain from pulling messages we cannot write; the
                # backlog is safe in the stream and the prober will wake us.
                #
                # Still a heartbeat, on purpose. The loop is alive and the reason
                # it is not pulling already has its own /readyz line. Letting the
                # silence accumulate here would report a paused Postgres as a
                # SECOND and wrong fault — "the consumer is not consuming" — and
                # send whoever is paged at the bus instead of the database.
                self.m.note_fetch_answer()
                await asyncio.sleep(self.cfg.db_retry_sec)
                continue
            if self._rebind_requested:
                # The stats loop found the durable gone. Nothing here will ever
                # raise to tell us that (see the 409 note below), so this is the
                # only path back.
                self._rebind_requested = False
                await self._rebind()
            try:
                msgs = await self._psub.fetch(self.cfg.batch_rows, timeout=timeout)
            except (NatsTimeoutError, asyncio.TimeoutError):
                # Idle feed — the T half of "N rows or T ms". BOTH exceptions:
                # nats-py raises its own TimeoutError when the pull request
                # expires server-side and asyncio's when the client-side wait
                # does. Only the first was caught, so a quiet gateway logged
                # "fetch failed:" with an empty message every second and left a
                # spurious `last_error` on /stats and /readyz.
                #
                # An expired pull proves the LOOP is alive — it asked and it came
                # back — and that is exactly why a quiet estate, this one polls
                # about every five minutes, keeps `consuming` at 1.
                #
                # It proves NOTHING about the consumer. nats-py's
                # `_is_temporary_error` treats the server's 409 as a timeout, and
                # 409 is what a pull against a DELETED or hijacked durable
                # answers — same exception, same branch, same silence as an idle
                # feed. That is why `consuming` also requires the stats loop's
                # `consumer_info` proof, and why this branch must not be read as
                # "everything is fine".
                failures = 0
                self.m.note_fetch_answer()
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a bad pull must not kill the loop
                # This branch used to log, sleep a second, and retry FOREVER.
                # Delete the `reading-writer` durable out of band and that is a
                # permanent wedge that reports success: every pull raises here,
                # not one reading is consumed, and /readyz answers 200 throughout
                # because the connection is up, the database answers, and
                # `consumer_pending` — last read from a consumer that no longer
                # exists — sits at 0, which is indistinguishable from caught-up.
                #
                # Two changes. The heartbeat is deliberately NOT stamped, so the
                # silence accumulates and `consuming` turns /readyz red on its
                # own. And a streak recreates the consumer, which is the only
                # exit when the durable is really gone.
                self.m.note_error(exc)
                self.m.fetch_failures += 1
                failures += 1
                log.warning("fetch failed (%d in a row): %s", failures, exc)
                if failures >= REBIND_AFTER_FAILURES:
                    await self._rebind()
                await asyncio.sleep(1.0)
                continue

            failures = 0
            self.m.note_fetch_answer()
            self.m.messages_received += len(msgs)
            keep, rows = [], []
            for msg in msgs:
                try:
                    rows.append(parse(msg.data, self.tenants.resolve))
                    keep.append(msg)
                except Malformed as bad:
                    # Can never become a row, and redelivery cannot change that.
                    # Park the body in EVENTS_DLQ with the refusal in headers,
                    # then term() so it stops being redelivered — on the FIRST
                    # delivery, because with max_deliver=-1 there is no budget
                    # that would ever park it for us. (This used to ack(), which
                    # dropped the body permanently and silently — contract §18.)
                    self.m.note_malformed(bad.reason)
                    log.warning(
                        "malformed message on %s: %s — dead-lettering",
                        msg.subject, bad.reason,
                    )
                    if await dead_letter(
                        self._js, msg,
                        consumer=self.cfg.durable,
                        reason=bad.reason,
                        delivery=_delivery_count(msg),
                    ):
                        self.m.messages_dead_lettered += 1
                    with contextlib.suppress(Exception):
                        await msg.term()
            self.m.unmapped_tenant_keys = len(self.tenants.unmapped)

            if rows:
                # Blocks when the buffer is full. That block IS the backpressure:
                # we stop pulling, the stream holds the backlog, lag becomes
                # visible. Nothing is dropped.
                #
                # A block long enough to outlast `fetch_silence_sec` also reads as
                # not consuming, and that is not a false positive: the loop really
                # has stopped taking readings off the bus. In practice the stall
                # watchdog names the real cause first — `write_stall_sec` (20s) is
                # under the silence limit (60s) by design, so the page says
                # "database stuck" before it says "not consuming".
                await self._queue.put((keep, rows))
                self.m.queue_depth = self._queue.qsize()

    # ── writer ────────────────────────────────────────────────────────────────
    async def _write_loop(self) -> None:
        sessionmaker = database.get_sessionmaker()
        while self._running:
            msgs, rows = await self._queue.get()
            self.m.queue_depth = self._queue.qsize()
            now_mono = time.monotonic()

            written = False
            for attempt in range(self.cfg.db_retry_attempts + 1):
                try:
                    # Mark the write in flight so the stall watchdog can see a
                    # write that never returns. `end_write` must run on EVERY exit
                    # path or a completed write would look stuck forever.
                    self.m.begin_write()
                    try:
                        async with sessionmaker() as session:
                            res = await write_batch(session, rows, self.cache, now_mono)
                    finally:
                        self.m.end_write()
                    written = True
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    self.m.batch_write_failures += 1
                    if _is_timeout(exc):
                        # statement_timeout fired: a query that would have hung
                        # forever became an error the retry/NAK path can handle.
                        self.m.writes_timed_out += 1
                    self.m.note_error(exc)
                    # The transaction rolled back, so any dimension row we thought
                    # we had written is gone. Re-upsert it next time.
                    self.cache.forget_all()
                    log.warning(
                        "batch write failed (attempt %s/%s, %s rows): %s",
                        attempt + 1, self.cfg.db_retry_attempts + 1, len(rows), exc,
                    )
                    if attempt < self.cfg.db_retry_attempts:
                        await asyncio.sleep(self.cfg.db_retry_sec * (2 ** attempt))

            if written:
                self.m.db_healthy = True
                self.m.batches_written += 1
                self.m.rows_inserted += res.rows_inserted
                self.m.rows_duplicate += res.duplicates
                self.m.points_upserted += res.points_upserted
                self.m.last_write_at = time.time()
                for msg in msgs:
                    try:
                        await msg.ack()
                    except Exception as exc:  # noqa: BLE001
                        # The rows ARE stored; a lost ack only costs a redelivery,
                        # which ON CONFLICT DO NOTHING absorbs.
                        log.warning("ack failed after a successful write: %s", exc)
            else:
                # NOTHING was acked. The batch goes back to JetStream and comes
                # round again — this is the property the whole design exists for.
                self.m.db_healthy = False
                self.m.batches_nakd += 1
                log.error(
                    "batch of %s readings NAK'd for redelivery — database unavailable",
                    len(rows),
                )
                for msg in msgs:
                    with contextlib.suppress(Exception):
                        await msg.nak(delay=self.cfg.db_retry_sec)

            self._queue.task_done()

    # ── stuck-write watchdog ──────────────────────────────────────────────────
    async def _stall_loop(self) -> None:
        """Turn a write that HANGS into a red health check.

        The failure this exists for: `docker compose pause postgres` freezes the
        server mid-query instead of dropping the connection. The write never
        returns and never raises, `db_healthy` stays true because nothing failed,
        and /readyz stays green while not one row is being written. Nothing is
        lost — no ack happens, the batch is still in the stream — but nothing says
        so, which is the whole problem.

        Observation only, no cancellation: see the note on `write_stall_sec`.
        """
        warned = False
        while self._running:
            await asyncio.sleep(1.0)
            stalled = self.m.write_stalled_sec()
            if stalled >= self.cfg.write_stall_sec:
                if not warned:
                    self.m.writes_timed_out += 1
                    log.error(
                        "DATABASE STUCK: batch write in flight for %ss (threshold %ss) — "
                        "not failing, not returning. Nothing is acked, so nothing is lost, "
                        "but nothing is being written either.",
                        stalled, self.cfg.write_stall_sec,
                    )
                    warned = True
                self.m.db_healthy = False
            elif warned and stalled == 0.0:
                log.info("database write completed after a stall — resuming")
                warned = False

    # ── database health prober ────────────────────────────────────────────────
    async def _probe_loop(self) -> None:
        engine = database.get_engine()
        while self._running:
            await asyncio.sleep(self.cfg.db_retry_sec)
            if self.m.db_healthy:
                continue
            if self.m.write_stalled_sec() > 0:
                # A write is still hanging. A `SELECT 1` on a fresh connection may
                # well succeed against a database that is merely lock-blocked, and
                # calling it healthy while the real write is wedged is precisely
                # the false green this fix removes.
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
            # This call was already here for the lag numbers. It is now also the
            # only thing in the process that can tell a deleted durable from a
            # quiet one, so its failure is no longer a debug line.
            info = await self._confirm_consumer()
            if info is None:
                # Leave the lag numbers at their last values rather than zeroing
                # them: 0 pending is the reading "everything is fine", and this is
                # precisely the moment it would be a lie.
                continue

            self.m.consumer_pending = info.num_pending or 0
            self.m.consumer_ack_pending = info.num_ack_pending or 0
            self.m.consumer_redelivered = info.num_redelivered or 0

            if self.m.consumer_pending > self.cfg.lag_warn:
                log.warning(
                    "FALLING BEHIND: %s messages pending on %s/%s (threshold %s)",
                    self.m.consumer_pending, self.cfg.stream, self.cfg.durable,
                    self.cfg.lag_warn,
                )
            else:
                log.info(
                    "rows=%s dup=%s batches=%s malformed=%s pending=%s queue=%s/%s db=%s",
                    self.m.rows_inserted, self.m.rows_duplicate, self.m.batches_written,
                    self.m.messages_malformed, self.m.consumer_pending,
                    self.m.queue_depth, self.m.queue_capacity,
                    "up" if self.m.db_healthy else "DOWN",
                )
