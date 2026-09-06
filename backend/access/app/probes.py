"""Liveness and readiness for the access service.

/health is liveness: it touches nothing outside the process, so a dependency
outage never triggers a restart. /readyz is readiness: it checks the dependencies
and returns 503 naming the one that failed. Keep them separate — a restart does
not fix a database that is down, and restarting on one turns a recoverable outage
into a loop.

The SignalR listeners are deliberately NOT part of readiness. A controller on a
customer LAN goes offline routinely; failing this service for that would take the
whole access API down for a fault it cannot fix. Listener count is reported in the
body as advisory context.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import Response
from sqlalchemy import text

log = logging.getLogger("access.probes")

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
        # A database that accepts the socket and never answers is a different
        # fault from one that is refusing connections.
        return f"database: no answer to SELECT 1 within {CHECK_TIMEOUT_SEC}s"
    except Exception as e:  # noqa: BLE001
        return f"database: {type(e).__name__}: {e}"[:300]
    return None


def check_events() -> str | None:
    """None when the event bus is usable.

    Not configured is not a fault — a deployment without NATS runs fine.
    Configured but disconnected IS: access events feed workflow's SOP triggering,
    so a dead bus means door and alarm events silently stop reaching it.
    """
    from kernel.config import get_settings

    from app.access.events import bus

    if not get_settings().nats_url:
        return None
    if getattr(bus, "_nc", None) is None:
        return "events: NATS is configured but not connected"
    return None


def listener_count() -> int:
    """Live SignalR listeners. Advisory — see the module docstring."""
    from app import main

    supervisor = getattr(main, "_supervisor", None)
    return len(getattr(supervisor, "_tasks", {}) or {})


async def readyz() -> Response:
    import json

    database = await check_database()
    events = check_events()
    reasons = [r for r in (database, events) if r]
    body = {
        "status": "ok" if not reasons else "not_ready",
        "service": "access",
        "checks": {
            "database": "ok" if database is None else database,
            "events": "ok" if events is None else events,
        },
        "listeners": listener_count(),
    }
    return Response(
        content=json.dumps(body),
        status_code=200 if not reasons else 503,
        media_type="application/json",
    )
