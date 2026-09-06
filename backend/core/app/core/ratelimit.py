"""Per-key sliding-window rate limiting, backed by Redis.

Used to throttle login attempts (brute-force protection), the API-key exchange,
and — coarsely, per IP — the whole API (`core/api.GlobalRateLimitMiddleware`).

The window must be SHARED, not per-process: a per-worker dict silently multiplies
the configured cap by the number of workers while the setting keeps saying 10.
Redis is already a hard dependency here, so the shared counter costs nothing new.

Sliding window, sorted set, one MULTI/EXEC
------------------------------------------
Each key is a sorted set with one member per hit, scored by wall-clock ms. A hit
prunes, appends, counts and re-arms the TTL as four commands in one transaction —
the atomicity is the point, since a read-then-write across two round trips is a
race two simultaneous logins both win.

A fixed window (`INCR` + `EXPIRE`) is cheaper but allows 2x the limit across a
window boundary. A Lua `EVAL` would let the count be checked before writing, but
needs `NOSCRIPT` retry handling and no in-process test double can run Lua.

A refused hit still consumes budget, because that is what one transaction can do:
a client that keeps hammering stays refused until it has been quiet for a full
window. Good behaviour for a brute-force control, and noted because it is a choice.

Scores are `time.time`, not `time.monotonic`: monotonic clocks have a per-process
epoch, so four workers would write four unrelated number lines into one key.

When Redis is down: fail open, loudly
-------------------------------------
Failing closed turns a Redis blip into a total authentication outage, including for
the operator trying to log in and look at it. This is not the control that stops
credential guessing — the per-account lockout in `auth/services/sessions.py` is,
and it lives in Postgres. This is a per-IP flood ceiling on top.

"Loudly" is what makes that defensible: every fail-open bumps
`edge_rate_limit_fail_open_total` and logs at ERROR, throttled to one line per 30s
per process so an outage under the global middleware does not bury itself.

The in-memory backend
---------------------
`MemoryRateLimiter` is for the test suite (which runs `--network none`) and for a
single-process deployment with no Redis. Selected only by
`VE_RATE_LIMIT_BACKEND=memory` or an empty `redis_url`, both decided at startup and
logged. A connection failure must never demote to it — that would restore the
per-worker defect exactly when someone is attacking.

`hit` and the two dependencies are coroutines: the global middleware runs on every
request, and a synchronous round trip there would block the event loop.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from typing import Protocol

from fastapi import Request
from prometheus_client import Counter

from .client_ip import client_ip
from .config import Settings, get_settings
from .errors import AppError
from .logging import get_logger

log = get_logger("edge.ratelimit")

#: Requests allowed through because the store was unreachable. Alert on any
#: non-zero rate: it means the per-IP ceiling is off.
FAIL_OPEN = Counter(
    "edge_rate_limit_fail_open_total",
    "Requests allowed without a rate-limit check because the limiter store failed",
)

#: How often one process may log the fail-open ERROR.
_OUTAGE_LOG_INTERVAL = 30.0

#: The in-memory fallback's state. Module-level, not instance state: "one bucket
#: store per process" is what this backend is, and a test that resets between
#: cases has one thing to clear.
_hits: dict[str, deque] = defaultdict(deque)


class RateLimitError(AppError):
    code = "RATE_LIMITED"
    status_code = 429


def _now_ms() -> int:
    """Wall-clock milliseconds. Monotonic would be per-process; see module docs."""
    return int(time.time() * 1000)


class RateLimiter(Protocol):
    """What a backend has to do: record a hit, or raise RateLimitError."""

    async def hit(self, key: str, limit: int, window: float) -> None: ...


class MemoryRateLimiter:
    """Per-process sliding window. Correct for exactly one worker, and no more.

    Only ever selected explicitly, never reached as a failure mode. `time.monotonic`
    is right here, unlike in the Redis backend: the window never leaves this
    process, and it cannot be dragged backwards by an NTP step mid-lockout.
    """

    name = "memory"

    async def hit(self, key: str, limit: int, window: float = 60.0) -> None:
        now = time.monotonic()
        bucket = _hits[key]
        cutoff = now - window
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            raise RateLimitError("too many requests — please try again shortly")
        bucket.append(now)


class RedisRateLimiter:
    """Sliding window in a shared Redis sorted set.

    The client is injected, not constructed here, so the suite can drive the real
    algorithm against an in-process double and point two instances at one store to
    prove the window really is shared.
    """

    name = "redis"

    def __init__(self, client, *, namespace: str = "rl") -> None:
        self._client = client
        self._namespace = namespace
        self._last_outage_log = 0.0
        self._suppressed = 0

    async def hit(self, key: str, limit: int, window: float = 60.0) -> None:
        now = _now_ms()
        window_ms = int(window * 1000)
        redis_key = f"{self._namespace}:{key}"
        # A unique member per hit: two hits can share a millisecond, and ZADD would
        # overwrite, under-counting exactly when traffic is heaviest.
        member = f"{now}-{uuid.uuid4().hex}"
        try:
            async with self._client.pipeline(transaction=True) as pipe:
                pipe.zremrangebyscore(redis_key, "-inf", now - window_ms)
                pipe.zadd(redis_key, {member: now})
                pipe.zcard(redis_key)
                # Re-armed each hit so an idle key expires. The window itself comes
                # from the prune above; this only stops Redis accumulating a key per
                # IP that ever touched the service.
                pipe.pexpire(redis_key, window_ms)
                _, _, count, _ = await pipe.execute()
        except Exception as exc:  # noqa: BLE001 — any store failure, one policy
            # Every exception, not just ConnectionError: DNS failures, timeouts, an
            # OOM'd Redis and a cluster MOVED are all "the store did not answer",
            # and the one left off the list becomes a 500 on login. A bug in here
            # would fail open too, which is why it is counted and logged.
            self._fail_open(exc)
            return
        if count > limit:
            raise RateLimitError("too many requests — please try again shortly")

    def _fail_open(self, exc: Exception) -> None:
        """Allow the request, but never quietly."""
        FAIL_OPEN.inc()
        now = time.monotonic()
        if now - self._last_outage_log < _OUTAGE_LOG_INTERVAL:
            self._suppressed += 1
            return
        suppressed = self._suppressed
        self._last_outage_log = now
        self._suppressed = 0
        log.error(
            "rate limiter FAILING OPEN — the Redis store is unreachable, so the "
            "per-IP request cap is NOT being enforced (%s: %s)%s. Per-account "
            "lockout is unaffected.",
            type(exc).__name__,
            exc,
            f"; {suppressed} further request(s) suppressed from this log" if suppressed else "",
        )


#: The process-wide limiter. Resolved once, by name, and logged.
_limiter: RateLimiter | None = None


def configure_rate_limiter(settings: Settings | None = None) -> RateLimiter:
    """Choose the backend from config, announce it, and install it process-wide.

    Called from `create_app` so the choice appears in the startup log. Calling it
    again just re-resolves and re-announces.
    """
    settings = settings or get_settings()
    global _limiter
    backend = (settings.rate_limit_backend or "redis").strip().lower()

    if backend == "memory":
        log.warning(
            "rate limiter backend=memory — the window is PER PROCESS. With more than "
            "one worker or replica the effective cap is multiplied by the number of "
            "them. Set VE_RATE_LIMIT_BACKEND=redis for any multi-worker deployment."
        )
        _limiter = MemoryRateLimiter()
        return _limiter

    if backend != "redis":
        raise RuntimeError(
            f"VE_RATE_LIMIT_BACKEND={backend!r} is not a backend; use 'redis' or 'memory'"
        )

    if not settings.redis_url:
        # Configured for Redis with nowhere to reach it. A misconfiguration, named
        # in the log — distinct from a runtime connection failure, which is an
        # outage and gets the fail-open path instead.
        log.warning(
            "rate limiter backend=redis but VE_REDIS_URL is empty — falling back to "
            "the PER-PROCESS in-memory window. This is a misconfiguration; the cap "
            "is not shared between workers."
        )
        _limiter = MemoryRateLimiter()
        return _limiter

    import redis.asyncio as aioredis

    log.info("rate limiter backend=redis (%s) — window shared across workers", settings.redis_url)
    _limiter = RedisRateLimiter(aioredis.from_url(settings.redis_url))
    return _limiter


def get_limiter() -> RateLimiter:
    """The process limiter, resolving it on first use if `create_app` never ran."""
    if _limiter is None:
        return configure_rate_limiter()
    return _limiter


async def hit(key: str, limit: int, window: float = 60.0) -> None:
    """Record a hit for ``key``; raise RateLimitError if over ``limit`` per window."""
    await get_limiter().hit(key, limit, window)


async def login_rate_limit(request: Request) -> None:
    """FastAPI dependency: throttle login by client IP.

    `client_ip`, not `request.client.host`: behind a gateway the peer is the
    gateway, so the cap would apply to the whole deployment at once.
    """
    ip = client_ip(request)
    await hit(f"login:{ip}", get_settings().rate_limit_login_per_minute, 60.0)


async def api_key_rate_limit(request: Request) -> None:
    """FastAPI dependency: throttle the API-key exchange by client IP.

    A separate bucket from login on purpose: sharing one budget makes them each
    other's denial of service, with a scheduled integration eating the login
    allowance for everyone behind the same egress IP.

    The allowance is higher than login's because the secret is 256 bits of
    ``secrets.token_urlsafe``, so this only has to stop a flood, not make guessing
    infeasible.
    """
    # `client_ip` for the same reason as login_rate_limit.
    ip = client_ip(request)
    await hit(f"apikey:{ip}", get_settings().rate_limit_api_key_per_minute, 60.0)
