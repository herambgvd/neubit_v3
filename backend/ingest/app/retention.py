"""Prune old ingest event logs.

`ingest_event_logs` grows one row per delivery and nothing ever removed them.
Unbounded growth is a slow outage on an appliance, and the rows hold verbatim
customer payloads — keeping them forever is a data-protection problem as much as a
disk one.

A background sweep rather than a database policy, because this table is plain
Postgres (the Timescale retention policies live in `reporting`).
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete

from app.ingest.models import IngestEventLog

log = logging.getLogger("ingest.retention")

#: How long a delivery log is kept. Long enough to debug an integration that broke
#: last week, short enough that the table has a ceiling.
RETENTION_DAYS = int(os.getenv("VE_INGEST_LOG_RETENTION_DAYS", "30"))

#: How often to sweep. Hourly — the table is not hot enough to need more, and a
#: sweep that runs too often is just load.
SWEEP_INTERVAL_SEC = int(os.getenv("VE_INGEST_RETENTION_SWEEP_SEC", "3600"))

#: Rows per statement, so one sweep cannot hold a long lock on a busy table.
BATCH = 5_000


async def prune_once(sessionmaker) -> int:
    """Delete logs older than the retention window. Returns rows removed."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    removed = 0
    while True:
        async with sessionmaker() as db:
            # ``received_at``, not ``created_at``. The table carries ten indexes and
            # none of them is on ``created_at``, so the old predicate planned as a
            # Seq Scan — and because the sweep loops until a batch comes back empty,
            # steady state meant scanning the WHOLE retained table every hour to
            # return zero rows. The purge that exists to bound the table was the
            # table's heaviest recurring reader, over rows holding verbatim customer
            # JSON.
            #
            # The two columns are interchangeable here: both are Python-side
            # ``default=_utcnow`` on the same INSERT and no writer sets either
            # explicitly, so they differ by the microseconds between two
            # ``datetime.now()`` calls (measured on live data: 1–7 µs, always
            # received_at ≤ created_at). Against a window measured in days that is
            # not a difference. ``received_at`` is also the column the operator's
            # own since/until filters use — "how long is a delivery kept" is a
            # question about when it was received.
            #
            # Indexing ``created_at`` instead would buy the same plan at the cost of
            # an ELEVENTH index on a write-hot table, to order a column nothing else
            # reads.
            ids = (
                await db.execute(
                    IngestEventLog.__table__.select()
                    .with_only_columns(IngestEventLog.id)
                    .where(IngestEventLog.received_at < cutoff)
                    .limit(BATCH)
                )
            ).scalars().all()
            if not ids:
                return removed
            await db.execute(delete(IngestEventLog).where(IngestEventLog.id.in_(ids)))
            await db.commit()
            removed += len(ids)
        if len(ids) < BATCH:
            return removed


async def sweep_forever(sessionmaker) -> None:
    """Prune on a loop. Never raises — a failed sweep must not stop the service."""
    while True:
        try:
            removed = await prune_once(sessionmaker)
            if removed:
                log.info("retention: pruned %d event logs older than %dd", removed, RETENTION_DAYS)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("retention sweep failed; retrying next interval")
        await asyncio.sleep(SWEEP_INTERVAL_SEC)
