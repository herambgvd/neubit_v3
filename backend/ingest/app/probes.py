"""Liveness and readiness for ingest.

/health is liveness: it touches nothing, so a dependency outage never triggers a
restart — restarting does not fix a database that is down.

/readyz is readiness: it checks what this service cannot work without and returns
503 naming the failure.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import Response
from sqlalchemy import text

log = logging.getLogger("ingest.probes")

CHECK_TIMEOUT_SEC = 3.0


async def check_database() -> str | None:
    """None when the database answers, otherwise the reason for the 503 body."""
    from app.db import get_engine

    try:

        async def _ping() -> None:
            async with get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(_ping(), timeout=CHECK_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        return f"database: no answer to SELECT 1 within {CHECK_TIMEOUT_SEC}s"
    except Exception as e:  # noqa: BLE001
        return f"database: {type(e).__name__}: {e}"[:300]
    return None


def check_events() -> str | None:
    """None when the event bus is usable.

    Not configured is not a fault. Configured but disconnected is: an accepted
    webhook that never reaches the bus is an event the platform silently lost.
    """
    from kernel.config import get_settings

    from app.main import bus

    if not get_settings().nats_url:
        return None
    if getattr(bus, "_nc", None) is None:
        return "events: NATS is configured but not connected"
    return None


async def readyz() -> Response:
    import json

    database = await check_database()
    events = check_events()
    reasons = [r for r in (database, events) if r]
    return Response(
        content=json.dumps({
            "status": "ok" if not reasons else "not_ready",
            "service": "ingest",
            "checks": {
                "database": "ok" if database is None else database,
                "events": "ok" if events is None else events,
            },
        }),
        status_code=200 if not reasons else 503,
        media_type="application/json",
    )
