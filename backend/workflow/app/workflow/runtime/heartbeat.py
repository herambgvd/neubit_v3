"""Whether the Celery worker still executes tasks, and beat still sends them.

A wedged Celery worker has no outward symptom: the process is up, the broker is
connected, and ``celery inspect ping`` answers pong from the control consumer on
a broadcast queue — a different queue from the one carrying work. So liveness here
means: at least one task RAN TO COMPLETION within the silence limit.

That works on an idle estate because the queue is never empty — beat publishes two
sweeps every minute forever, and a sweep that matches nothing still completes. It
also proves the whole chain: broker reachable, queue consumed, pool alive, task
body executed.

Beat keeps its own heartbeat so one number cannot accuse the wrong container: beat
fresh + worker silent is a wedged worker, both silent is a dead beat or broker.

The state lives in Redis, not in the process, for two reasons. Celery's prefork
pool fires ``task_postrun`` in a forked child, so an in-process counter is
invisible to the probe thread and separately wrong in every child; HINCRBY makes
it correct without a lock. And the other reader is the API in a different
container. If Redis is gone the heartbeat can be neither written nor read, which
is the right answer — a worker that cannot reach its broker is not consuming.

Keys are ``neubit:workflow:health:*`` with a TTL, so a removed deployment leaves
nothing behind.
"""

from __future__ import annotations

import logging
import os
import time

from kernel.config import get_settings

log = logging.getLogger("workflow.runtime.heartbeat")

KEY_PREFIX = "neubit:workflow:health:"
# Long enough to still show the last thing a dead process said; short enough that
# a decommissioned service leaves nothing behind. Silence limits red long before it.
KEY_TTL_SEC = 3600


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw.strip())
    except ValueError:
        log.warning("%s=%r is not a number — using %s", name, raw, default)
        return default


# Five beat ticks: one missed tick is ordinary (restart, a long sweep, a minute
# boundary); five consecutive silent minutes is not something a live worker does.
WORKER_SILENCE_SEC = _env_float("VE_WORKFLOW_WORKER_SILENCE_SEC", 300.0)
# Beat's own limit. Same reasoning; beat publishes twice a minute.
BEAT_SILENCE_SEC = _env_float("VE_WORKFLOW_BEAT_SILENCE_SEC", 300.0)


def key(role: str) -> str:
    return f"{KEY_PREFIX}{role}"


# ── writer side (worker / beat processes, including forked children) ─────────

_client = None


def _sync_client():
    global _client
    if _client is None:
        import redis  # celery's own dependency, already installed

        _client = redis.Redis.from_url(
            get_settings().redis_url,
            socket_connect_timeout=2, socket_timeout=2, decode_responses=True,
        )
    return _client


def arm(role: str) -> None:
    """Start this role's heartbeat fresh. Called once, in MainProcess, at boot.

    Deletes first so counters mean "since this process started" — a total that
    survives a crash makes a worker that has done nothing look busy.
    """
    try:
        c = _sync_client()
        pipe = c.pipeline()
        pipe.delete(key(role))
        pipe.hset(key(role), mapping={"armed_at": repr(time.time()), "role": role})
        pipe.expire(key(role), KEY_TTL_SEC)
        pipe.execute()
    except Exception as e:  # noqa: BLE001
        log.warning("heartbeat arm failed for %s: %s", role, e)


def note(role: str, name: str, *, failed: bool = False) -> None:
    """Record that this role just did its thing. Never raises.

    Runs from a Celery signal on the path of every task, so it must never be able
    to fail one. A failed write is self-reporting: the field goes stale.

    HINCRBY, not read-modify-write, because prefork children stamp it concurrently.
    """
    try:
        c = _sync_client()
        pipe = c.pipeline()
        pipe.hset(key(role), mapping={
            "last_event_at": repr(time.time()), "last_event_name": name[:200],
        })
        pipe.hincrby(key(role), "events_total", 1)
        if failed:
            pipe.hincrby(key(role), "failures_total", 1)
            pipe.hset(key(role), "last_error", name[:300])
        pipe.expire(key(role), KEY_TTL_SEC)
        pipe.execute()
    except Exception as e:  # noqa: BLE001
        log.warning("heartbeat note failed for %s: %s", role, e)


# ── reader side ──────────────────────────────────────────────────────────────


def _parse(raw: dict | None) -> dict | None:
    if not raw:
        return None
    def f(k):
        try:
            return float(raw[k])
        except (KeyError, TypeError, ValueError):
            return None
    return {
        "role": raw.get("role"),
        "armed_at": f("armed_at"),
        "last_event_at": f("last_event_at"),
        "last_event_name": raw.get("last_event_name"),
        "events_total": int(raw.get("events_total") or 0),
        "failures_total": int(raw.get("failures_total") or 0),
        "last_error": raw.get("last_error"),
    }


def read_sync(role: str) -> tuple[dict | None, str | None]:
    """(payload, error). For the worker's own probe thread — no event loop there.

    The error is returned separately because "Redis unreachable" and "never
    published" send an operator to different places.
    """
    try:
        return _parse(_sync_client().hgetall(key(role))), None
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"[:200]


_aclient = None


async def read(role: str) -> tuple[dict | None, str | None]:
    """Async twin of :func:`read_sync`, for the API process."""
    global _aclient
    try:
        if _aclient is None:
            import redis.asyncio as aredis

            _aclient = aredis.Redis.from_url(
                get_settings().redis_url,
                socket_connect_timeout=2, socket_timeout=2, decode_responses=True,
            )
        return _parse(await _aclient.hgetall(key(role))), None
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"[:200]


def age_of(payload: dict | None) -> float | None:
    """Seconds since that role last did its thing. None = nothing to go on.

    Falls back to ``armed_at`` so a freshly booted worker gets a grace period
    instead of reading as infinitely silent before anything is scheduled.
    """
    if not payload:
        return None
    when = payload.get("last_event_at") or payload.get("armed_at")
    return None if not when else round(time.time() - float(when), 1)


async def close_reader() -> None:
    global _aclient
    if _aclient is not None:
        try:
            await _aclient.aclose()
        except Exception:  # noqa: BLE001
            pass
        _aclient = None
