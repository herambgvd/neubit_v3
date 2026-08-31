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
        d["write_stalled_sec"] = self.write_stalled_sec()
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
        m("last_write_age_sec",
          round(time.time() - self.last_write_at, 1) if self.last_write_at else -1,
          "gauge", "Seconds since the last committed batch. -1 = never.")
        m("uptime_sec", round(time.time() - self.started_at, 1), "gauge", "Process uptime.")
        for reason, count in sorted(self.malformed_reasons.items()):
            safe = reason.replace('"', "")
            lines.append(f'{p}malformed_by_reason{{reason="{safe}"}} {count}')
        return "\n".join(lines) + "\n"
