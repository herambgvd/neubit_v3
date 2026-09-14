"""Infrastructure alarms: the signals the appliance already had, delivered.

The platform could SEE all three of these and told nobody. `/admin/infra/host`
carries disk usage, `/admin/infra/containers` carries every container's status,
and reading-writer's `/stats` carries the depth of EVENTS_DLQ — 25 parked
messages on the reference appliance, sitting there since nobody had reason to
open that screen. A number on a dashboard nobody is looking at is not
monitoring; it is a number.

There is a full notification fan-out in `app.messaging` — in-app, email, push,
webhook, per-tenant config, templates — and no infrastructure signal was wired
into it. This module is that wire, and nothing more: it polls the three sources,
decides whether each is in alarm, and calls ``notify``.

WHY IT LIVES IN CORE'S LIFESPAN, not a Celery beat: for the same reason
``app.retention`` does. There is no core worker in the deployment, and core's
Celery app shares a Redis database and the default queue with workflow's — so a
core task would be consumed by ``workflow-worker``, the container that drives
incident escalation. See the header of app/retention.py.

EDGE-TRIGGERED, NOT LEVEL-TRIGGERED. A disk that is 92% full is 92% full on the
next tick too. Alerting every cycle trains an operator to filter the alert, and
an alert that is filtered is worse than no alert because it is believed to be
covering something. So a message is sent when a check CHANGES state — healthy to
alarm, and alarm back to healthy, because "it recovered" is the other half of
the information. A condition that stays in alarm is re-sent once every
``VE_WATCHDOG_REARM_SEC`` (a day by default) so a standing problem is not
forgotten, and never more often than that.

STATE IS IN MEMORY, deliberately. It is "what did we last say", not a record.
Losing it on restart costs one repeated alert about a condition that is still
true, which is the harmless direction; persisting it would mean a schema, a
migration and a row to go stale.

Config (env):
  * ``VE_WATCHDOG_ENABLED``        — "0" turns the whole thing off (default on).
  * ``VE_WATCHDOG_INTERVAL_SEC``   — seconds between polls (default 300).
  * ``VE_WATCHDOG_REARM_SEC``      — re-send a standing alarm after this (default 86400).
  * ``VE_WATCHDOG_DISK_PCT``       — disk-used alarm threshold (default 85).
  * ``VE_WATCHDOG_DLQ_DEPTH``      — EVENTS_DLQ depth alarm threshold (default 1).
  * ``VE_READING_WRITER_URL``      — where to read DLQ depth (default http://reading-writer:8000).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx
from sqlalchemy import select

from .auth.models import User
from .infra.client import OpsAgentClient
from .messaging import notify

log = logging.getLogger("core.watchdog")

ENABLED = os.getenv("VE_WATCHDOG_ENABLED", "1") not in ("0", "false", "False")
INTERVAL_SEC = int(os.getenv("VE_WATCHDOG_INTERVAL_SEC", "300"))
REARM_SEC = int(os.getenv("VE_WATCHDOG_REARM_SEC", "86400"))
DISK_PCT = float(os.getenv("VE_WATCHDOG_DISK_PCT", "85"))
#: One parked message is already a problem: a dead letter is a message the
#: platform decided it can NEVER turn into a row, so the count only goes up until
#: somebody looks. A threshold of "some" would just pick the number at which we
#: stop caring about lost data.
DLQ_DEPTH = int(os.getenv("VE_WATCHDOG_DLQ_DEPTH", "1"))
READING_WRITER_URL = os.getenv("VE_READING_WRITER_URL", "http://reading-writer:8000").rstrip("/")


class Check:
    """One named condition and the last thing we said about it.

    ``key`` is what identifies an alarm across ticks, so it must name the SUBJECT
    and not the reading: "container:vision" stays one alarm while its message
    changes, whereas "vision exited (3 restarts)" would be a new alarm on the
    fourth restart and would alert forever.
    """

    __slots__ = ("firing", "last_sent")

    def __init__(self) -> None:
        self.firing = False
        self.last_sent = 0.0


async def _disk(agent: OpsAgentClient) -> list[tuple[str, str]]:
    """(key, message) for the disk check — empty when healthy."""
    host = await agent.host()
    used = host.get("disk_used_gb")
    total = host.get("disk_total_gb")
    # psutil is optional in the agent and these are absent without it. Absent is
    # not healthy and it is not an alarm either: it is nothing to say.
    if not used or not total:
        return []
    pct = (float(used) / float(total)) * 100.0
    if pct < DISK_PCT:
        return []
    return [(
        "disk",
        f"Disk is {pct:.0f}% full ({used:.0f} GB of {total:.0f} GB used). "
        f"Recordings and database writes stop when it fills.",
    )]


async def _containers(agent: OpsAgentClient) -> list[tuple[str, str]]:
    """(key, message) per unhealthy or crashed container — one alarm each.

    Per container rather than one "3 containers are down" alarm: they recover
    separately, and a combined alarm would clear the moment two of the three came
    back.

    EXITED IS NOT THE SAME AS FAILED. `db-init` and `reporting-migrate` are
    one-shot jobs; they run at boot, exit 0 and stay exited, and that is the
    correct state for them. Alerting on "not running" would fire on both of them
    after every single restart of the stack — the fastest way to teach an
    operator that this alert means nothing. So a stopped container is an alarm
    only when it stopped with a non-zero code.

    RUNNING IS NOT THE SAME AS HEALTHY either, and that is the half a status
    check misses: a container whose healthcheck is failing keeps reporting
    `running` while it serves nothing.
    """
    out = []
    for c in await agent.list_containers():
        name = c.get("name") or c.get("id") or "?"
        status = (c.get("status") or "").lower()
        health = (c.get("health") or "").lower()
        code = c.get("exit_code")
        if health == "unhealthy":
            out.append((f"container:{name}", f"Container {name} is running but unhealthy."))
        elif status in ("restarting", "dead", "paused"):
            out.append((f"container:{name}", f"Container {name} is {status}."))
        elif status == "exited" and code not in (0, None):
            out.append((f"container:{name}", f"Container {name} exited with code {code}."))
    return out


async def _dlq() -> list[tuple[str, str]]:
    """(key, message) for EVENTS_DLQ depth — empty when healthy."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{READING_WRITER_URL}/stats")
        resp.raise_for_status()
        stats = resp.json()
    depth = stats.get("dlq_stream_messages")
    # None means the watch never bound, which the reading-writer's own health
    # reports. Reading "unknown" as zero would turn a blind watchdog into a
    # silent all-clear.
    if depth is None or int(depth) < DLQ_DEPTH:
        return []
    return [(
        "dlq",
        f"{int(depth)} message(s) parked in EVENTS_DLQ. Each is data the platform "
        f"refused and will never turn into a row; they stay until someone drains them.",
    )]


async def collect(agent: OpsAgentClient) -> list[tuple[str, str]]:
    """Every firing condition right now, as (key, message).

    Each source is tried independently: an unreachable ops-agent must not hide a
    DLQ that is filling, which is exactly the correlation a single try/except
    around the three of them would create.
    """
    firing: list[tuple[str, str]] = []
    for name, coro in (
        ("disk", _disk(agent)),
        ("containers", _containers(agent)),
        ("dlq", _dlq()),
    ):
        try:
            firing.extend(await coro)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a source being down is not an alarm
            log.warning("watchdog: %s check unavailable: %s", name, exc)
    return firing


async def _recipients(db) -> tuple[list, list[str]]:
    """Platform super-admins: (user ids, email addresses).

    Super-admins rather than every admin: these are appliance-level facts — a
    disk, a container, a queue — that belong to whoever runs the box, not to a
    tenant whose own data is unaffected.
    """
    rows = (await db.execute(
        select(User).where(User.is_superadmin.is_(True), User.is_active.is_(True))
    )).scalars().all()
    return [u.id for u in rows], [u.email for u in rows if u.email]


async def tick(sessionmaker, state: dict, agent: OpsAgentClient | None = None) -> list[str]:
    """One poll. Returns the keys actually notified about, for the log and tests."""
    agent = agent or OpsAgentClient()
    firing = {key: msg for key, msg in await collect(agent)}
    now = time.time()
    notified: list[str] = []

    # RAISED and STILL-RAISED, then cleared, in that order — a check that goes
    # away between two ticks must not be reported as both.
    to_send: list[tuple[str, str, str]] = []
    for key, msg in firing.items():
        check = state.setdefault(key, Check())
        if not check.firing:
            to_send.append((key, "Infrastructure alarm", msg))
        elif now - check.last_sent >= REARM_SEC:
            to_send.append((key, "Infrastructure alarm (still open)", msg))
        else:
            continue
        check.firing = True
        check.last_sent = now

    for key, check in list(state.items()):
        if key in firing or not check.firing:
            continue
        check.firing = False
        check.last_sent = now
        to_send.append((key, "Infrastructure alarm cleared", f"{key} is healthy again."))

    if not to_send:
        return notified

    async with sessionmaker() as db:
        user_ids, emails = await _recipients(db)
        if not user_ids and not emails:
            # Nothing to do about it, and saying so every five minutes is its own
            # noise — so this is a warning, once per tick that had something.
            log.warning("watchdog: %d alarm(s) and no super-admin to tell", len(to_send))
            return notified
        for key, title, body in to_send:
            try:
                await notify(
                    db,
                    user_ids=user_ids,
                    title=title,
                    body=body,
                    channels=["email"],
                    email_to=emails,
                )
                notified.append(key)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                # Losing the delivery must not lose the state change, or the next
                # tick treats a raised alarm as newly raised and alerts again.
                log.exception("watchdog: could not deliver alarm %s", key)
    return notified


async def watch_forever(sessionmaker) -> None:
    """Poll on a loop. Never raises — a failed poll must not stop the service."""
    if not ENABLED:
        log.info("watchdog: disabled by VE_WATCHDOG_ENABLED")
        return
    state: dict = {}
    # One interval before the first poll: at startup the stack's own containers
    # are still coming up, and a watchdog whose first act is to report its
    # siblings as down is a watchdog operators turn off.
    await asyncio.sleep(INTERVAL_SEC)
    while True:
        try:
            sent = await tick(sessionmaker, state)
            if sent:
                log.info("watchdog: notified on %s", ", ".join(sent))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("watchdog poll failed; retrying next interval")
        await asyncio.sleep(INTERVAL_SEC)
