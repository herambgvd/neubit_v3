"""Reading-writer configuration — every knob, and why it has the value it has.

Read from the environment (``VE_`` prefix, like every other service). Set in
``deploy/docker-compose.yml``; override per deployment in ``deploy/.env``.

The two that matter most:

``VE_READINGS_BATCH_ROWS`` / ``VE_READINGS_BATCH_MS``
    Flush on N rows or T milliseconds, WHICHEVER COMES FIRST. That pair is the
    whole reason this service has one code path at 10 readings/min and at 10,000
    readings/sec: at a trickle the timer fires and the batch is small; under load
    the row count fires and the batch is full. Nothing switches modes.

``VE_READINGS_TENANT_MAP`` / ``VE_READINGS_DEFAULT_TENANT_ID``
    The gateway publishes ITS OWN tenant key in the subject and the envelope, and
    that key is not necessarily a platform tenant UUID — the live aeon feed
    publishes the literal string ``default``. ``readings.tenant_id`` is a
    ``uuid NOT NULL``, so the key has to be resolved to one. See
    ``app.tenants``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int((os.getenv(name) or "").strip() or default)
    except ValueError:
        return default


def _str(name: str, default: str) -> str:
    return (os.getenv(name) or "").strip() or default


@dataclass(frozen=True)
class WriterConfig:
    # ── bus ───────────────────────────────────────────────────────────────────
    stream: str = field(default_factory=lambda: _str("VE_READINGS_STREAM", "IOT_READINGS"))
    # READINGS ONLY. `tenant.{t}.iot.alert.{conn}` is an EVENT, not a measurement:
    # it already reaches the realtime relays and has no row in `readings`.
    subject: str = field(
        default_factory=lambda: _str("VE_READINGS_SUBJECT", "tenant.*.iot.reading.>")
    )
    # One durable name shared by every replica → NATS distributes work between
    # them. That is the redundancy story: no leader election, nothing per-replica.
    durable: str = field(default_factory=lambda: _str("VE_READINGS_DURABLE", "reading-writer"))

    # ── stream limits (contract §4 — the stream this service OWNS) ────────────
    # EVENTS is `max_msgs=-1, max_bytes=-1, max_age=0` on file storage: unbounded.
    # A sensor feed on an unbounded stream is a disk leak, so IOT_READINGS is
    # bounded on BOTH size and age, and whichever binds first wins.
    #
    # Sizing, from measurement rather than taste. One idle 313-point Modbus/MQTT
    # broker produces ~37 msg/min ≈ 53k msg/day ≈ 21 MB/day (envelopes are ~450 B).
    #   max_age  7 days  — the stream is a REPLAY BUFFER, not the archive. The
    #                      archive is the `readings` hypertable, whose own
    #                      retention (VE_READINGS_RETENTION, 90 days) is the real
    #                      history. Seven days covers a long weekend of writer
    #                      downtime, which is far more than the outage this is
    #                      meant to survive.
    #   max_bytes 8 GiB  — ~380 MB/day against the 7-day age limit, i.e. ~18x the
    #                      measured single-broker rate. So age is the binding
    #                      limit until roughly 18 brokers, and past that size
    #                      takes over and caps the disk instead of the history.
    # discard=old: when full, the OLDEST messages go. The newest data always
    # survives and a full stream never becomes backpressure on the gateway.
    stream_max_bytes: int = field(
        default_factory=lambda: _int("VE_IOT_STREAM_MAX_BYTES", 8 * 1024**3)
    )
    stream_max_age_sec: int = field(
        default_factory=lambda: _int("VE_IOT_STREAM_MAX_AGE_SEC", 7 * 24 * 3600)
    )
    # Set to 0 to bind an EXISTING stream without creating or converging it. Two
    # uses: pointing a one-off drain at another stream (e.g. backfilling the iot
    # messages that landed in EVENTS before this stream existed), and running in a
    # deployment where stream topology is managed outside this service.
    ensure_stream: bool = field(
        default_factory=lambda: _int("VE_READINGS_ENSURE_STREAM", 1) != 0
    )
    # A reading envelope is ~450 bytes. A megabyte is already pathological, and
    # this stops one runaway payload from eating the whole budget.
    stream_max_msg_size: int = field(
        default_factory=lambda: _int("VE_IOT_STREAM_MAX_MSG_SIZE", 1024 * 1024)
    )

    # ── batching ──────────────────────────────────────────────────────────────
    batch_rows: int = field(default_factory=lambda: _int("VE_READINGS_BATCH_ROWS", 500))
    batch_ms: int = field(default_factory=lambda: _int("VE_READINGS_BATCH_MS", 1000))
    # How many full batches may sit between the fetcher and the writer. This is
    # the "accept, buffer, write" buffer: the fetcher keeps pulling while the
    # previous batch is still committing, so one slow write does not stall
    # reception. When it fills, the fetcher STOPS FETCHING — it never drops. The
    # backlog then sits in JetStream (bounded, sized for it) and shows up as
    # consumer lag, which is visible. Backpressure, not loss.
    queue_batches: int = field(default_factory=lambda: _int("VE_READINGS_QUEUE_BATCHES", 4))

    # ── ack ───────────────────────────────────────────────────────────────────
    # Must comfortably exceed (time to fill the queue + time to write a batch), or
    # NATS redelivers messages this process is still legitimately working on.
    ack_wait_sec: int = field(default_factory=lambda: _int("VE_READINGS_ACK_WAIT_SEC", 120))
    # Ceiling on unacked messages held by the consumer, across all replicas. Keep
    # it above batch_rows * (queue_batches + 1) or the consumer starves itself.
    max_ack_pending: int = field(
        default_factory=lambda: _int("VE_READINGS_MAX_ACK_PENDING", 5000)
    )

    # ── database ──────────────────────────────────────────────────────────────
    # Re-touching `points.last_seen_at` on every reading would make the dimension
    # table as hot as the fact table. Once per point per interval is plenty.
    point_touch_sec: int = field(default_factory=lambda: _int("VE_READINGS_POINT_TOUCH_SEC", 60))
    # How long to wait before re-trying a batch in place. After
    # `db_retry_attempts` the batch is NAK'd and NATS redelivers it — nothing is
    # acked, so nothing is lost.
    db_retry_attempts: int = field(default_factory=lambda: _int("VE_READINGS_DB_RETRIES", 2))
    db_retry_sec: float = field(default_factory=lambda: float(_int("VE_READINGS_DB_RETRY_SEC", 2)))
    # How long an in-flight batch write may run before the pipeline declares the
    # database stuck and turns /readyz red.
    #
    # `db_healthy` alone only answers "did the last write FAIL". A write that
    # HANGS — a lock wait, or `docker compose pause postgres`, which SIGSTOPs the
    # server so even its own statement_timeout is frozen and never fires — never
    # fails, so the flag stays true and /readyz stays green while nothing at all
    # is being written. Nothing is lost (no ack happens, the batch is still in
    # JetStream) but nothing says so either, and that silence is the bug.
    #
    # The watchdog does NOT cancel the write. Cancelling an asyncpg query means
    # opening a SECOND connection to send the cancel request, which against a
    # frozen server hangs exactly like the first. It only OBSERVES: health goes
    # red now, and when the database comes back the write finishes on its own and
    # health returns to green. Deliberately shorter than the statement timeout so
    # the alarm fires before the query dies of its own accord.
    write_stall_sec: float = field(
        default_factory=lambda: float(_int("VE_READINGS_WRITE_STALL_SEC", 20))
    )

    # ── observability ─────────────────────────────────────────────────────────
    # Consumer lag above this is logged as a warning and turns /readyz degraded.
    lag_warn: int = field(default_factory=lambda: _int("VE_READINGS_LAG_WARN", 10000))
    # How long the fetch loop may go without an ANSWER from JetStream — messages
    # OR a clean idle timeout — before /readyz calls the readings consumer wedged.
    #
    # THIS IS NOT A "NO READINGS ARRIVED" THRESHOLD and must never be tuned as
    # one. A pull that expires server-side is an answer, and nats-py expires one
    # every `batch_ms` (1s), so a live loop refreshes this about once a second on
    # a completely silent bus. This estate polls roughly every five minutes and
    # lands in bursts; a quiet night is normal operation and reads green here,
    # because what is being measured is the loop asking, not the estate talking.
    # A flag that reds on an idle window is worse than no flag — somebody turns
    # it off, and then the real wedge is invisible too.
    #
    # 60s is therefore ~60 consecutive missed heartbeats. It also governs the
    # SECOND proof — `consumer_unconfirmed_sec`, refreshed by the stats loop
    # every `stats_every_sec` (15s), so four consecutive checks must fail before
    # a missing durable reds. One window for both, because an operator tuning
    # "how long may this look wedged before I am paged" is asking one question.
    #
    # It buys immunity to a single failed pull, a NATS reconnect, and a container
    # that lost the CPU for a while, and it costs at most a minute of detection
    # latency on a signal whose remedy (a rebind, or a human) takes longer than
    # that anyway. Set to 0 to disable the check.
    fetch_silence_sec: float = field(
        default_factory=lambda: float(_int("VE_READINGS_FETCH_SILENCE_SEC", 60))
    )
    stats_every_sec: int = field(default_factory=lambda: _int("VE_READINGS_STATS_SEC", 15))

    def __post_init__(self) -> None:
        need = self.batch_rows * (self.queue_batches + 1)
        if self.max_ack_pending < need:
            # Not fatal — but say so, because the symptom (throughput mysteriously
            # capped) looks nothing like the cause.
            import logging

            logging.getLogger("reading-writer").warning(
                "VE_READINGS_MAX_ACK_PENDING=%s is below batch_rows*(queue_batches+1)=%s; "
                "the consumer will throttle itself",
                self.max_ack_pending, need,
            )
