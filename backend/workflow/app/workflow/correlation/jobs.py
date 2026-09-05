"""Scheduled job over the correlation dedup slots — the expiry cleanup, and the
runner that keeps the event→incident consumer alive.

``dedup_cleanup`` is housekeeping for the idempotency table this package owns:
a slot's only job is to make a firing decision once inside its window, so past
``expires_at`` it is dead weight. Deleting it can never resurrect an incident —
the window has already closed.
"""

from __future__ import annotations

import logging

from sqlalchemy import delete

from ..core.primitives import utcnow
from ..runtime.session import task_session as _task_session
from .models import CorrelationDedup

log = logging.getLogger("workflow.correlation.jobs")


# ── Dedup cleanup ──────────────────────────────────────────────────────


async def dedup_cleanup() -> int:
    """Delete expired correlation-dedup slots (``expires_at`` < now)."""
    now = utcnow()
    async with _task_session() as session:
        result = await session.execute(
            delete(CorrelationDedup).where(
                CorrelationDedup.expires_at.is_not(None),
                CorrelationDedup.expires_at < now,
            )
        )
        await session.commit()
    deleted = int(result.rowcount or 0)
    if deleted:
        log.info("dedup cleanup: removed %d expired slot(s)", deleted)
    return deleted


# ── Correlation consumer (long-running) ────────────────────────────────


async def run_correlation_consumer() -> None:
    """Start the correlation engine and block forever (Celery long-running task)."""
    import asyncio

    from .engine import CorrelationEngine

    engine = CorrelationEngine()
    await engine.start()
    log.info("correlation consumer running")
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await engine.close()

