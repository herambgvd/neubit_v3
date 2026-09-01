"""What the projector knows about itself, and how it says so.

The pipeline contract's rule — "backpressure must be visible ... silent data loss
is the worst outcome available here" — is not about IoT, it is about durable
consumers, so it applies here unchanged. Everything that can go wrong has a
counter, and the ones that mean LOSS (malformed messages, failed batches) are
separate from the ones that mean SLOW (queue depth, consumer lag), because the
response to each is different.

Counters are PER PROJECTION. A single aggregate number would let a healthy access
projection hide a fire projection that has been failing every batch for an hour,
which is precisely the kind of silence this exists to prevent.

Three surfaces:
  * `GET /health`   liveness. 200 while the process is alive.
  * `GET /readyz`   readiness. 503 when the database is down, the bus is
                    disconnected, a projection was refused, or lag is over
                    `VE_PROJECTOR_LAG_WARN`.
  * `GET /metrics`  Prometheus text, hand-rolled (no new dependency).
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field


@dataclass
class ProjectionMetrics:
    key: str = ""
    relation: str = ""
    subject: str = ""
    durable: str = ""

    messages_received: int = 0
    rows_inserted: int = 0        # rows the database actually stored
    rows_duplicate: int = 0       # the conflict action changed nothing — replay, normal
    rows_enriched: int = 0        # an existing row gained a value it did not have
    batches_written: int = 0

    messages_malformed: int = 0        # can never become a row; term'd
    messages_dead_lettered: int = 0    # ...whose body was parked in EVENTS_DLQ
    malformed_reasons: dict = field(default_factory=dict)
    batch_write_failures: int = 0
    batches_nakd: int = 0

    queue_depth: int = 0
    queue_capacity: int = 0
    consumer_pending: int = 0     # JetStream: undelivered. THE lag number.
    consumer_ack_pending: int = 0
    consumer_redelivered: int = 0

    last_write_at: float | None = None
    running: bool = False
    # False while the fetch loop is failing repeatedly — e.g. the durable was
    # deleted out of band, where every pull errors while the projection quietly
    # consumes NOTHING. The loop rebinds itself; this flag is what stops /readyz
    # reading green in the meantime. Only a fetch that gets an ANSWER (messages,
    # or a clean idle timeout) sets it back to True.
    consuming: bool = True
    fetch_failures: int = 0

    def note_malformed(self, reason: str) -> None:
        self.messages_malformed += 1
        self.malformed_reasons[reason] = self.malformed_reasons.get(reason, 0) + 1


@dataclass
class Metrics:
    started_at: float = field(default_factory=time.time)

    projections: dict = field(default_factory=dict)   # key -> ProjectionMetrics
    # Projections in the table that could not be started, and why. Non-empty
    # turns /readyz red: a domain that believes it is being collected and is not
    # is the worst failure this service has.
    refused: dict = field(default_factory=dict)

    unmapped_tenant_keys: int = 0
    nats_connected: bool = False
    db_healthy: bool = True
    # Monotonic start of the batch write currently in flight, per projection key
    # (absent = nothing in flight). The only thing that can tell a HUNG write from
    # an idle feed — `db_healthy` cannot, because a hang never fails.
    writes_in_flight: dict = field(default_factory=dict)
    writes_timed_out: int = 0
    last_error: str | None = None
    last_error_at: float | None = None
    last_reload_at: float | None = None

    def projection(self, key: str) -> ProjectionMetrics:
        m = self.projections.get(key)
        if m is None:
            m = ProjectionMetrics(key=key)
            self.projections[key] = m
        return m

    def note_error(self, exc: BaseException) -> None:
        self.last_error = f"{type(exc).__name__}: {exc}"[:500]
        self.last_error_at = time.time()

    def begin_write(self, key: str) -> None:
        self.writes_in_flight[key] = time.monotonic()

    def end_write(self, key: str) -> None:
        self.writes_in_flight.pop(key, None)

    def write_stalled_sec(self) -> float:
        """Age of the OLDEST in-flight batch write across every projection. 0 = idle."""
        if not self.writes_in_flight:
            return 0.0
        return round(time.monotonic() - min(self.writes_in_flight.values()), 1)

    @property
    def max_pending(self) -> int:
        return max((p.consumer_pending for p in self.projections.values()), default=0)

    @property
    def not_consuming(self) -> list:
        """Projections that are supposed to be running but whose fetch loop is
        failing — a consumer that receives nothing while /readyz would otherwise
        stay green, which is the silence this flag exists to break."""
        return sorted(k for k, p in self.projections.items() if p.running and not p.consuming)

    def snapshot(self) -> dict:
        return {
            "uptime_sec": round(time.time() - self.started_at, 1),
            "nats_connected": self.nats_connected,
            "db_healthy": self.db_healthy,
            "write_stalled_sec": self.write_stalled_sec(),
            "writes_timed_out": self.writes_timed_out,
            "unmapped_tenant_keys": self.unmapped_tenant_keys,
            "last_error": self.last_error,
            "last_error_at": self.last_error_at,
            "last_reload_at": self.last_reload_at,
            "refused": dict(self.refused),
            "projections": {k: asdict(v) for k, v in sorted(self.projections.items())},
        }

    def prometheus(self) -> str:
        p = "projector_"
        lines: list[str] = []

        def g(name: str, value, typ: str, help_: str) -> None:
            lines.append(f"# HELP {p}{name} {help_}")
            lines.append(f"# TYPE {p}{name} {typ}")
            lines.append(f"{p}{name} {value}")

        g("nats_connected", int(self.nats_connected), "gauge", "1 when connected to NATS.")
        g("db_healthy", int(self.db_healthy), "gauge",
          "1 when the last batch write succeeded AND no in-flight write is stalled.")
        g("write_stalled_sec", self.write_stalled_sec(), "gauge",
          "Age of the oldest in-flight batch write. 0 = idle. A rising value with "
          "db_healthy=1 is the hung-database signature.")
        g("writes_timed_out_total", self.writes_timed_out, "counter",
          "Batch writes abandoned by statement_timeout or the stall watchdog.")
        g("projections_running", sum(1 for x in self.projections.values() if x.running),
          "gauge", "Projections with a live consumer.")
        g("projections_refused", len(self.refused), "gauge",
          "Projections in the registry that could not be started. NON-ZERO MEANS A "
          "DOMAIN BELIEVES IT IS BEING COLLECTED AND IS NOT.")
        g("unmapped_tenant_keys", self.unmapped_tenant_keys, "gauge",
          "Distinct publisher tenant keys with no VE_PROJECTOR_TENANT_MAP entry.")
        g("uptime_sec", round(time.time() - self.started_at, 1), "gauge", "Process uptime.")

        def per(name: str, typ: str, help_: str, pick) -> None:
            lines.append(f"# HELP {p}{name} {help_}")
            lines.append(f"# TYPE {p}{name} {typ}")
            for key, m in sorted(self.projections.items()):
                lines.append(f'{p}{name}{{projection="{key}"}} {pick(m)}')

        per("messages_received_total", "counter", "Events taken off the bus.",
            lambda m: m.messages_received)
        per("rows_inserted_total", "counter", "Event rows durably stored.",
            lambda m: m.rows_inserted)
        per("rows_duplicate_total", "counter",
            "Rows a conflict left untouched (replay — expected, not an error).",
            lambda m: m.rows_duplicate)
        per("rows_enriched_total", "counter",
            "Existing rows that gained a value they did not have "
            "(on_conflict: enrich — a widened wire reaching older rows).",
            lambda m: m.rows_enriched)
        per("batches_written_total", "counter", "Batches committed.", lambda m: m.batches_written)
        per("messages_malformed_total", "counter",
            "Messages refused because they can never become a row. Parked in "
            "EVENTS_DLQ then terminated — recoverable there for 30 days.",
            lambda m: m.messages_malformed)
        per("messages_dead_lettered_total", "counter",
            "Refused messages whose body reached EVENTS_DLQ. LESS THAN "
            "malformed_total means a DLQ write failed and those bodies are gone.",
            lambda m: m.messages_dead_lettered)
        per("batch_write_failures_total", "counter",
            "Batches that failed to commit. Nothing was acked; NATS redelivers them.",
            lambda m: m.batch_write_failures)
        per("batches_nakd_total", "counter", "Batches handed back to NATS for redelivery.",
            lambda m: m.batches_nakd)
        per("queue_depth", "gauge", "Batches buffered between the fetcher and the writer.",
            lambda m: m.queue_depth)
        per("consumer_pending", "gauge",
            "JetStream messages not yet delivered to this consumer. This is the lag.",
            lambda m: m.consumer_pending)
        per("consumer_ack_pending", "gauge", "Delivered but unacked.",
            lambda m: m.consumer_ack_pending)
        per("consumer_redelivered", "gauge", "Redelivered messages.",
            lambda m: m.consumer_redelivered)
        per("consuming", "gauge",
            "1 while the fetch loop is getting answers. 0 = pulls are failing "
            "(e.g. the durable was deleted out of band); the loop rebinds itself "
            "and /readyz is red until it does.",
            lambda m: int(m.consuming))
        per("fetch_failures_total", "counter",
            "Failed pulls (excluding clean idle timeouts).",
            lambda m: m.fetch_failures)
        per("last_write_age_sec", "gauge",
            "Seconds since this projection's last committed batch. -1 = never.",
            lambda m: round(time.time() - m.last_write_at, 1) if m.last_write_at else -1)

        for key, m in sorted(self.projections.items()):
            for reason, count in sorted(m.malformed_reasons.items()):
                safe = reason.replace('"', "")
                lines.append(
                    f'{p}malformed_by_reason{{projection="{key}",reason="{safe}"}} {count}'
                )
        return "\n".join(lines) + "\n"
