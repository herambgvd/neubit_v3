"""What the writer knows about itself, and how it says so.

Contract §6: "backpressure must be visible ... silent data loss is the worst
outcome available here". This module is that visibility. Everything the writer
can get wrong has a counter, and the two that mean *loss* — malformed messages
and failed batches — are separated from the two that mean *slow* — queue depth
and consumer lag — because the responses differ.

Exposed three ways:
  * ``GET /health``   liveness. 200 while the process is alive.
  * ``GET /readyz``   readiness. 503 when the database is down, the bus is
                      disconnected, or lag is over ``VE_READINGS_LAG_WARN``.
  * ``GET /metrics``  Prometheus text, hand-rolled (no new dependency).

``consumer_pending`` is THE lag number: messages in the stream this durable
consumer has not delivered yet, read straight from JetStream. It is the one that
tells you the writer is behind the gateway.

It is also the most treacherous number here, which is why ``consuming`` exists
next to it. ``consumer_pending`` reads 0 for a writer that is perfectly caught up
AND for a writer that has stopped asking altogether — a wedged fetch loop never
moves it, and neither does a fetch loop whose task is dead. ``consuming`` answers
the different question: is the loop still getting ANSWERS from the server. See
the field for why an idle estate answers yes.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field


@dataclass
class Metrics:
    started_at: float = field(default_factory=time.time)

    # ── volume ────────────────────────────────────────────────────────────────
    messages_received: int = 0
    rows_inserted: int = 0      # rows the database actually stored
    rows_duplicate: int = 0     # ON CONFLICT DO NOTHING skipped them — replay, normal
    batches_written: int = 0
    points_upserted: int = 0

    # ── loss / error ──────────────────────────────────────────────────────────
    messages_malformed: int = 0             # can never become a row; term'd
    messages_dead_lettered: int = 0         # ...whose body was parked in EVENTS_DLQ
    malformed_reasons: dict = field(default_factory=dict)
    batch_write_failures: int = 0           # NOT acked → NATS redelivers
    batches_nakd: int = 0
    unmapped_tenant_keys: int = 0           # distinct gateway keys with no mapping

    # ── liveness of the pipeline ──────────────────────────────────────────────
    last_write_at: float | None = None
    last_error: str | None = None
    last_error_at: float | None = None

    # ── backpressure ──────────────────────────────────────────────────────────
    queue_depth: int = 0            # batches waiting between fetcher and writer
    queue_capacity: int = 0
    consumer_pending: int = 0       # JetStream: undelivered messages (THE lag)
    consumer_ack_pending: int = 0
    consumer_redelivered: int = 0

    # ── connections ───────────────────────────────────────────────────────────
    nats_connected: bool = False
    db_healthy: bool = True

    # ── stuck writes ──────────────────────────────────────────────────────────
    # `db_healthy` only ever answers "did the last write FAIL". A write that
    # neither succeeds nor fails — a lock wait, or a Postgres that has been
    # SIGSTOPped, where even the server-side statement_timeout is frozen — leaves
    # it TRUE forever while nothing is being written. This is the monotonic clock
    # start of the batch currently in flight (None = nothing in flight), and it is
    # the only thing that can tell a hang from an idle feed.
    write_started_mono: float | None = None
    writes_timed_out: int = 0     # statement_timeout / stall abandonments

    # ── liveness of the FETCH loop ────────────────────────────────────────────
    # The blind spot everything above leaves open. `nats_connected` says the
    # client holds a TCP session, `db_healthy` says the last write did not fail,
    # and `consumer_pending` says how far behind the durable is — and all three
    # read healthy for a process that is consuming NOTHING. Three real states
    # live in that gap:
    #
    #   * the durable was deleted or taken over out of band, and every pull comes
    #     back looking like an idle timeout (see the second proof below) while
    #     the connection stays up and `consumer_pending`, read from a consumer
    #     that is no longer there, keeps whatever value it last had;
    #   * the fetch task raised outside the `try` and died, taking no other task
    #     and not the process with it;
    #   * the loop is parked in a branch it never leaves.
    #
    # `consumer_pending == 0` cannot distinguish any of them from a caught-up
    # writer on a quiet night, and 0 is exactly what all four look like.
    #
    # So this is the monotonic instant the loop last got an ANSWER — messages, or
    # a clean idle timeout. The second is the important half: nats-py expires a
    # pull server-side every `batch_ms` (1s), so a LIVE loop stamps this about
    # once a second whether or not a single reading was published. Silence on the
    # wire is still an answer, which is how a quiet estate stays green.
    last_fetch_answer_mono: float | None = None
    fetch_failures: int = 0       # failed pulls; idle timeouts are NOT failures
    consumer_rebinds: int = 0     # times the loop recreated its own consumer

    # ── and the second, independent proof, because the first is not enough ────
    # An expired pull is NOT evidence that the durable still exists. nats-py
    # folds the server's 409 into `nats.errors.TimeoutError`
    # (`JetStreamContext._is_temporary_error`: NO_MESSAGES, CONFLICT and
    # REQUEST_TIMEOUT are all "temporary", and CONFLICT is what the server
    # answers a pull against a deleted or push-based consumer with). So a durable
    # deleted out of band produces a fetch loop that looks perfectly idle — same
    # exception, same code path, same silence — while it consumes nothing. The
    # heartbeat above cannot see that and neither can `consumer_pending`, which
    # is read from the consumer that is gone.
    #
    # So the second proof is asked out of band: `consumer_info` on the durable,
    # already issued by the stats loop every `stats_every_sec` and now checked
    # for SHAPE as well as existence. It runs on its own task, so this costs the
    # write loop nothing, and it answers the one question a pull cannot: is the
    # thing we think we are consuming from still there, still ours, still pull.
    last_consumer_seen_mono: float | None = None
    consumer_missing: str | None = None   # why the last check failed; None = fine
    consumer_checks_failed: int = 0

    # Seconds of silence after which `consuming` goes false — for BOTH proofs.
    # Set from WriterConfig by the Pipeline, so a bare Metrics() (tests, /stats
    # before start) cannot red itself on a check that was never armed. 0 disables.
    silence_limit_sec: float = 0.0

    def note_fetch_answer(self) -> None:
        """Stamp the fetch loop as alive.

        Called from the HOT PATH on every iteration, so it is deliberately one
        store of a float and nothing else: no lock, no allocation, no I/O, no
        branch, and no exception it could raise into the loop it is supposed to
        be watching. A liveness signal that can fail is a liveness signal that
        takes the thing it watches down with it.
        """
        self.last_fetch_answer_mono = time.monotonic()

    def note_consumer_seen(self) -> None:
        """Record that the durable was found, and found to be ours."""
        self.last_consumer_seen_mono = time.monotonic()
        self.consumer_missing = None

    def note_consumer_missing(self, why: str) -> None:
        """Record that the durable is absent or is not the consumer we bound.

        Deliberately does NOT clear the timestamp: a single failed API call
        during a NATS blip should not red the service, and letting the clock run
        is what makes the limit apply to this proof as well as to the heartbeat.
        """
        self.consumer_missing = why
        self.consumer_checks_failed += 1

    def fetch_silence_sec(self) -> float:
        """Seconds since the fetch loop last got an answer. 0.0 before it starts."""
        last = self.last_fetch_answer_mono
        return 0.0 if last is None else round(time.monotonic() - last, 1)

    def consumer_unconfirmed_sec(self) -> float:
        """Seconds since the durable was last confirmed present and ours."""
        last = self.last_consumer_seen_mono
        return 0.0 if last is None else round(time.monotonic() - last, 1)

    @property
    def fetch_loop_alive(self) -> bool:
        """The loop is still going round. False = pulls failing, or the task is gone."""
        if self.silence_limit_sec <= 0:
            return True
        return self.fetch_silence_sec() < self.silence_limit_sec

    @property
    def consumer_confirmed(self) -> bool:
        """The durable exists and is the pull consumer we bound."""
        if self.silence_limit_sec <= 0:
            return True
        return self.consumer_unconfirmed_sec() < self.silence_limit_sec

    @property
    def consuming(self) -> bool:
        """Both proofs, ANDed. Either alone reads green through a real wedge.

        DERIVED, not assigned. The projections half sets its flag from the
        failure branch of its own fetch loop, so the flag depends on that loop
        still running in order to ever be wrong, and it inherits the 409 problem
        described on `last_consumer_seen_mono`. Reading two clocks instead costs
        the hot path one float store and covers what an assigned flag cannot: a
        fetch task that died, and a durable that vanished without a single pull
        raising.
        """
        return self.fetch_loop_alive and self.consumer_confirmed

    def begin_write(self) -> None:
        self.write_started_mono = time.monotonic()

    def end_write(self) -> None:
        self.write_started_mono = None

    def write_stalled_sec(self) -> float:
        """How long the in-flight batch write has been running. 0.0 when idle."""
        started = self.write_started_mono
        return 0.0 if started is None else round(time.monotonic() - started, 1)

    def note_malformed(self, reason: str) -> None:
        self.messages_malformed += 1
        self.malformed_reasons[reason] = self.malformed_reasons.get(reason, 0) + 1

    def note_error(self, exc: BaseException) -> None:
        self.last_error = f"{type(exc).__name__}: {exc}"[:500]
        self.last_error_at = time.time()

    def snapshot(self) -> dict:
        d = asdict(self)
        d["uptime_sec"] = round(time.time() - self.started_at, 1)
        d.pop("write_started_mono", None)  # a monotonic clock means nothing outside
        d.pop("last_fetch_answer_mono", None)  # ditto
        d.pop("last_consumer_seen_mono", None)  # ditto
        d["write_stalled_sec"] = self.write_stalled_sec()
        d["fetch_silence_sec"] = self.fetch_silence_sec()
        d["consumer_unconfirmed_sec"] = self.consumer_unconfirmed_sec()
        d["consuming"] = self.consuming
        return d

    # ── Prometheus text exposition ────────────────────────────────────────────
    def prometheus(self) -> str:
        p = "reading_writer_"
        lines: list[str] = []

        def m(name: str, value, typ: str, help_: str) -> None:
            lines.append(f"# HELP {p}{name} {help_}")
            lines.append(f"# TYPE {p}{name} {typ}")
            lines.append(f"{p}{name} {value}")

        m("messages_received_total", self.messages_received, "counter",
          "Reading messages taken off the bus.")
        m("rows_inserted_total", self.rows_inserted, "counter",
          "Reading rows durably stored.")
        m("rows_duplicate_total", self.rows_duplicate, "counter",
          "Rows skipped by ON CONFLICT DO NOTHING (replay — expected, not an error).")
        m("batches_written_total", self.batches_written, "counter", "Batches committed.")
        m("points_upserted_total", self.points_upserted, "counter",
          "Dimension rows created or refreshed.")
        m("messages_malformed_total", self.messages_malformed, "counter",
          "Messages refused because they can never become a row. Parked in EVENTS_DLQ "
          "then terminated — recoverable there for 30 days.")
        m("messages_dead_lettered_total", self.messages_dead_lettered, "counter",
          "Refused messages whose body reached EVENTS_DLQ. LESS THAN malformed_total "
          "means a DLQ write failed and those bodies are gone.")
        m("batch_write_failures_total", self.batch_write_failures, "counter",
          "Batches that failed to commit. Nothing was acked; NATS redelivers them.")
        m("batches_nakd_total", self.batches_nakd, "counter",
          "Batches handed back to NATS for redelivery.")
        m("unmapped_tenant_keys", self.unmapped_tenant_keys, "gauge",
          "Distinct gateway tenant keys with no VE_READINGS_TENANT_MAP entry.")
        m("queue_depth", self.queue_depth, "gauge",
          "Batches buffered between the fetcher and the writer.")
        m("queue_capacity", self.queue_capacity, "gauge", "Buffer size in batches.")
        m("consumer_pending", self.consumer_pending, "gauge",
          "JetStream messages not yet delivered to this consumer. This is the lag.")
        m("consumer_ack_pending", self.consumer_ack_pending, "gauge",
          "Delivered but unacked.")
        m("consumer_redelivered", self.consumer_redelivered, "gauge", "Redelivered messages.")
        m("nats_connected", int(self.nats_connected), "gauge", "1 when connected to NATS.")
        m("db_healthy", int(self.db_healthy), "gauge",
          "1 when the last batch write succeeded AND no in-flight write is stalled.")
        m("write_stalled_sec", self.write_stalled_sec(), "gauge",
          "Seconds the in-flight batch write has been running. 0 = idle. "
          "A rising value with db_healthy=1 is the hung-database signature.")
        m("writes_timed_out_total", self.writes_timed_out, "counter",
          "Batch writes abandoned by statement_timeout or the stall watchdog.")
        m("consuming", int(self.consuming), "gauge",
          "1 while the READINGS fetch loop is still getting answers from JetStream "
          "(messages, or a clean idle timeout). 0 = it has gone silent past "
          "VE_READINGS_FETCH_SILENCE_SEC: pulls failing, or the task is gone. NOT a "
          "traffic gauge \u2014 an idle estate reads 1. The projections half has its own "
          "projector_consuming{projection=\"...\"}; neither stands in for the other.")
        m("fetch_silence_sec", self.fetch_silence_sec(), "gauge",
          "Seconds since the readings fetch loop last got an answer. A live loop "
          "resets this about once a second even with nothing to consume.")
        m("consumer_unconfirmed_sec", self.consumer_unconfirmed_sec(), "gauge",
          "Seconds since the durable was last confirmed to exist and to be OUR pull "
          "consumer. The half of `consuming` a pull cannot supply: nats-py reports the "
          "server's 409 for a deleted consumer as a plain TimeoutError, so a vanished "
          "durable is indistinguishable from an idle feed at the fetch call.")
        m("consumer_checks_failed_total", self.consumer_checks_failed, "counter",
          "consumer_info calls that found the durable absent or not ours.")
        m("fetch_failures_total", self.fetch_failures, "counter",
          "Failed pulls, excluding clean idle timeouts.")
        m("consumer_rebinds_total", self.consumer_rebinds, "counter",
          "Times the fetch loop recreated its durable after a failure streak. "
          "NON-ZERO MEANS THE DURABLE WENT MISSING and the stream was replayed.")
        m("last_write_age_sec",
          round(time.time() - self.last_write_at, 1) if self.last_write_at else -1,
          "gauge", "Seconds since the last committed batch. -1 = never.")
        m("uptime_sec", round(time.time() - self.started_at, 1), "gauge", "Process uptime.")
        for reason, count in sorted(self.malformed_reasons.items()):
            safe = reason.replace('"', "")
            lines.append(f'{p}malformed_by_reason{{reason="{safe}"}} {count}')
        return "\n".join(lines) + "\n"
