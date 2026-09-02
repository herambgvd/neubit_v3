"""Projector configuration — every knob, and why it has the value it has.

Read from the environment (``VE_`` prefix, like every other service). Set in
``deploy/docker-compose.yml``; override per deployment in ``deploy/.env``.

The batching pair is the same one the reading-writer uses and for the same
reason: flush on N rows or T milliseconds, WHICHEVER COMES FIRST, so there is one
code path at four events an hour and at four thousand a second. Nothing switches
modes.

Domain events are NOT sensor readings and the defaults say so. A building's doors
produce events at human rates, so the row threshold is small and the timer is
what usually fires. Making it 500-like would mean a swipe sits unwritten for a
second longer than it needs to for no gain.
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
class ProjectorConfig:
    # ── batching ──────────────────────────────────────────────────────────────
    batch_rows: int = field(default_factory=lambda: _int("VE_PROJECTOR_BATCH_ROWS", 200))
    batch_ms: int = field(default_factory=lambda: _int("VE_PROJECTOR_BATCH_MS", 1000))
    # Full batches that may sit between the fetcher and the writer, PER
    # PROJECTION. This is the "accept, buffer, write" buffer: the fetcher keeps
    # pulling while the previous batch commits. When it fills, the fetcher STOPS
    # FETCHING — it never drops. The backlog then sits in JetStream and shows up
    # as consumer lag, which is visible. Backpressure, not loss.
    queue_batches: int = field(default_factory=lambda: _int("VE_PROJECTOR_QUEUE_BATCHES", 4))

    # ── ack ───────────────────────────────────────────────────────────────────
    # Must comfortably exceed (time to fill the queue + time to write a batch), or
    # NATS redelivers messages this process is still legitimately working on.
    ack_wait_sec: int = field(default_factory=lambda: _int("VE_PROJECTOR_ACK_WAIT_SEC", 120))
    max_ack_pending: int = field(default_factory=lambda: _int("VE_PROJECTOR_MAX_ACK_PENDING", 2000))

    # ── database ──────────────────────────────────────────────────────────────
    # How long to wait before re-trying a batch in place. After `db_retry_attempts`
    # the batch is NAK'd and NATS redelivers it — nothing was acked, so nothing is
    # lost.
    db_retry_attempts: int = field(default_factory=lambda: _int("VE_PROJECTOR_DB_RETRIES", 2))
    db_retry_sec: float = field(default_factory=lambda: float(_int("VE_PROJECTOR_DB_RETRY_SEC", 2)))
    # How long an in-flight batch write may run before the database is declared
    # stuck and /readyz turns red. See the identical knob on the reading-writer:
    # `db_healthy` only ever answers "did the last write FAIL", and a write that
    # HANGS (a lock wait, or `docker compose pause postgres`, which SIGSTOPs the
    # server so even its own statement_timeout is frozen) never fails. Nothing is
    # lost — no ack happens — but the health check reads green while not one row
    # is being projected. Observation only; the write is never cancelled.
    write_stall_sec: float = field(
        default_factory=lambda: float(_int("VE_PROJECTOR_WRITE_STALL_SEC", 20))
    )

    # ── the projection registry ───────────────────────────────────────────────
    # How often `reporting_projections` is re-read. Registration is DATA: an
    # INSERT must start being projected without a restart, and this interval is
    # how long that takes. Kept short because the read is one small SELECT.
    reload_sec: int = field(default_factory=lambda: _int("VE_PROJECTOR_RELOAD_SEC", 30))
    # Set to 0 to run without creating or converging any relation — for a
    # deployment where DDL is applied out of band. The projector then projects
    # only into relations that already exist, and says so if one is missing.
    ensure_relations: bool = field(
        default_factory=lambda: _int("VE_PROJECTOR_ENSURE_RELATIONS", 1) != 0
    )

    # ── observability ─────────────────────────────────────────────────────────
    lag_warn: int = field(default_factory=lambda: _int("VE_PROJECTOR_LAG_WARN", 5000))
    stats_every_sec: int = field(default_factory=lambda: _int("VE_PROJECTOR_STATS_SEC", 30))

    # ── tenant resolution ─────────────────────────────────────────────────────
    # A subject's tenant segment is `platform` for a system-scoped event, which is
    # not a uuid, and the projected relations declare `tenant_id uuid NOT NULL`.
    # Same three rules as the reading-writer — see `app/tenants.py`.
    #
    # FALLING BACK TO THE READING-WRITER'S MAP IS DELIBERATE, not laziness. Both
    # services resolve keys out of the SAME publisher namespace (the tenant
    # resolver's UUIDv5 namespace constant is shared for exactly that reason), and
    # the projection that made this matter — `iot_alerts` — consumes the very same
    # gateway, on the very same `tenant.default.iot.>` subjects, as the readings
    # the reading-writer already maps. A deployment that has set
    # `VE_READINGS_TENANT_MAP=default=…` and not the projector's twin would
    # otherwise file its alerts under a synthetic tenant the console cannot see,
    # while its readings landed correctly — the two stores disagreeing about who
    # owns the same gateway's data. `VE_PROJECTOR_TENANT_MAP` still wins when set,
    # so a deployment whose domains genuinely need different mappings can say so.
    tenant_map: str = field(
        default_factory=lambda: _str("VE_PROJECTOR_TENANT_MAP", "")
        or _str("VE_READINGS_TENANT_MAP", "")
    )
    default_tenant: str = field(
        default_factory=lambda: _str("VE_PROJECTOR_DEFAULT_TENANT_ID", "")
        or _str("VE_READINGS_DEFAULT_TENANT_ID", "")
    )
