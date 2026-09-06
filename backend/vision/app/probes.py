"""Liveness and readiness for the vision service.

There was no `/readyz` at all. `/health` answers 200 while the process is up and
touches nothing, so an orchestrator watching it cannot tell a working service from
one whose database is gone — and this is the service that holds every camera,
recording and evidence lock.

The two are separate on purpose. `/health` is LIVENESS: it never touches a
dependency, so a database outage cannot trigger a restart loop that will not fix
it. `/readyz` is READINESS: it checks the dependencies and answers 503 naming the
one that failed, so a load balancer stops sending traffic while the process stays
up and recovers.

WHAT IS DELIBERATELY NOT IN READINESS
-------------------------------------
Cameras and recorders. A camera on a customer LAN going offline is routine and is
not this service failing; making it part of readiness would take the whole VMS API
down for a fault it cannot fix. Same reasoning access applies to its SignalR
listeners. Camera health has its own surface and its own alerting.

The media node is not in it either, for the same reason with more force: a
standalone recorder is a separate deployment, and the VMS is still able to serve
its catalogue, ACLs and configuration when the recorder is unreachable.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import Response
from sqlalchemy import text

log = logging.getLogger("vision.probes")

#: A dependency that accepts the socket and never answers is a different failure
#: from one that refuses it, and both must end as 503 rather than a hung request.
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
        return f"database did not answer within {CHECK_TIMEOUT_SEC:g}s"
    except Exception as exc:  # noqa: BLE001 — every failure is the same verdict
        return f"database unavailable: {type(exc).__name__}"
    return None


def check_events() -> str | None:
    """The event bus, from the bus object rather than by probing it.

    An UNSET `VE_NATS_URL` is not a fault: a standalone deployment runs with no
    spine and the service is fully able to serve its API. Only a configured bus
    that is not connected is.
    """
    from kernel.config import get_settings

    if not (getattr(get_settings(), "nats_url", "") or ""):
        return None
    try:
        from app.vms.common.events import bus
    except Exception:  # noqa: BLE001 — no bus module is not a readiness fault
        return None
    if getattr(bus, "_nc", None) is None:
        return "event bus configured but not connected"
    return None


async def readyz() -> Response:
    """503 naming the dependency that failed; 200 with the checks when none did."""
    database = await check_database()
    events = check_events()
    reasons = [r for r in (database, events) if r]
    body = {
        "status": "ok" if not reasons else "not_ready",
        "service": "vision",
        "checks": {
            "database": "ok" if database is None else database,
            "events": "ok" if events is None else events,
        },
    }
    return Response(
        content=json.dumps(body),
        status_code=200 if not reasons else 503,
        media_type="application/json",
    )
