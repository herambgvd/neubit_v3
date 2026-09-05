"""Per-key sliding-window rate limiting, backed by Redis.

Used to throttle login attempts (brute-force protection), the API-key exchange,
and — coarsely, per IP — the whole API (`core/api.GlobalRateLimitMiddleware`).

WHY THIS IS NOT A DICT ANY MORE.

    This module used to be a `dict[str, deque]` in the worker's own memory, with a
    docstring that said "SINGLE-PROCESS only". That was honest and it was still a
    latent security defect: the cap is a NUMBER IN A SETTING that an operator reads
    as "10 login attempts per minute per IP", and the moment core runs with
    `--workers 4` or a second replica the real cap becomes 40, silently. Nothing
    errors, nothing logs, and `VE_RATE_LIMIT_LOGIN_PER_MINUTE=10` keeps saying 10.
    A control that quietly multiplies when you scale is worse than an absent one,
    because the absent one does not appear in a design review as satisfied.

    Redis is already a hard dependency of this stack (Celery broker, realtime
    pub/sub, `/ready` pings it), so the shared counter costs no new infrastructure.

DECISION 1 — SORTED-SET SLIDING WINDOW IN A MULTI/EXEC TRANSACTION.

    Each key is a Redis sorted set of one member per hit, scored by the hit's
    timestamp in milliseconds. A hit prunes everything older than the window,
    appends itself, counts, and re-arms the key's TTL — as FOUR QUEUED COMMANDS IN
    ONE MULTI/EXEC, which Redis runs to completion with nothing interleaved. That
    atomicity is the point: a read-then-write across two round trips ("how many
    hits are there? … ok, add mine") is a race that two simultaneous login attempts
    both win, which would be the same bug this commit removes, rebuilt in Redis.

    The alternative was a fixed window: `INCR` + `EXPIRE key window NX`. It is one
    integer instead of a sorted set, so it is cheaper in memory and marginally
    cheaper in CPU. What it costs is precision at the boundary — a caller who
    spends the whole budget in the last second of one window and the whole budget
    in the first second of the next has made 2x the limit in a two-second span, and
    for a login cap whose entire job is to bound guesses per unit time, a factor of
    two that depends on where the attacker's clock happens to fall is the kind of
    slack you find out about from a pentest report. The sorted set has no boundary;
    at ~600 requests/minute/IP for the global cap the memory is a few tens of KB
    per active IP, which is not a number worth trading correctness for.

    A third option, `EVAL` of a small Lua script, is what you need if you want to
    check the count BEFORE writing (see the semantic note below). It was rejected
    for two reasons: a script has to be re-`SCRIPT LOAD`ed after a Redis restart
    (so every call site needs `NOSCRIPT` retry logic), and — the one that decided
    it — no in-process test double can execute Lua, so the algorithm would only
    ever be exercised against a real server, which this suite deliberately does not
    have. An algorithm nobody can test offline is an algorithm nobody tests.

    ONE SEMANTIC CHANGE, DELIBERATE. The old version checked the count and appended
    only if the hit was allowed, so a REFUSED attempt did not consume budget. Here
    the hit is recorded first and the decision read off the resulting count, because
    that is what a single transaction can do. The effect is that a client who keeps
    hammering while refused keeps their own window full and stays refused until they
    have been quiet for a whole window. For a brute-force control that is the better
    behaviour, not merely an acceptable one; it is written down because it is a
    change, not because it is a regret. The compensating alternative — ZREM the
    member back out when refused — is a second round trip during which another
    caller sees a count that includes a hit that never happened, i.e. a false
    refusal race traded for nothing.

    TIMESTAMPS ARE WALL CLOCK (`time.time`), NOT `time.monotonic`. Monotonic clocks
    have a per-process epoch, so four workers writing monotonic scores into one
    shared sorted set would be writing four unrelated number lines into the same
    key. Wall clocks across a cluster disagree by NTP skew — milliseconds, against
    a 60-second window.

DECISION 2 — WHEN REDIS IS DOWN, FAIL OPEN, LOUDLY.

    A rate limiter whose store is unreachable has exactly two options and both are
    bad. Fail closed and a Redis blip becomes a total authentication outage: nobody
    can log in, INCLUDING the operator who needs to log in to look at why. Fail open
    and the flood cap is gone for the duration, silently, unless you make noise.

    We fail open, and the reason is that this is not the control that stops
    credential guessing. The PER-ACCOUNT lockout is (`lockout_max_attempts` /
    `lockout_minutes`, enforced in `auth/services/sessions.py` against
    `user.failed_login_count` and `user.locked_until`) — it lives in Postgres, it is
    already shared across every worker, and it bounds guesses against any single
    account at five whether or not Redis is up. What this module adds on top is a
    per-IP flood ceiling. Losing a flood ceiling for the length of a Redis restart
    is a smaller, more recoverable harm than refusing every login in the product for
    the same window, and the harm it exposes is bounded by a control that is still
    running.

    "Loudly" is load-bearing and is the half that makes the choice defensible: every
    fail-open bumps `edge_rate_limit_fail_open_total` (so it is visible on the
    existing /metrics scrape and alertable) and logs at ERROR. The log is throttled
    to one line per 30 seconds per process with a suppressed count, because an
    outage under the global middleware would otherwise emit one ERROR per request
    and bury itself; the counter is the lossless record, the log is the human one.

DECISION 3 — THE IN-MEMORY PATH SURVIVES, BUT ONLY WHEN ASKED FOR.

    `MemoryRateLimiter` is still here for the test suite (which runs with
    `--network none`) and for a single-process deployment with no Redis. It is
    selected ONLY by `VE_RATE_LIMIT_BACKEND=memory`, or when the backend is Redis
    and `redis_url` is empty — both decided ONCE at startup and both logged by name.
    It is never reached by a connection failure: a Redis that goes away at runtime
    gets the fail-open path above, not a silent demotion to a per-worker counter
    that would restore the original defect at the exact moment someone is attacking.

ASYNC. `hit` and the two dependencies are coroutines. The client is
`redis.asyncio`, and the global middleware runs on every single request — a
synchronous round trip there would block the event loop for the whole process.
FastAPI awaits async `Depends` transparently; `GlobalRateLimitMiddleware.dispatch`
awaits `hit` explicitly.
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

#: Lossless record of every request that was allowed through because the limiter's
#: store was unreachable. Alert on any non-zero rate: it means the per-IP ceiling
#: is off. Deliberately a counter and not only a log line — see DECISION 2.
FAIL_OPEN = Counter(
    "edge_rate_limit_fail_open_total",
    "Requests allowed without a rate-limit check because the limiter store failed",
)

#: How often one process may log the fail-open ERROR. See DECISION 2.
_OUTAGE_LOG_INTERVAL = 30.0

#: The in-memory fallback's state. Module-level rather than instance state on
#: purpose: "one bucket store per process" is precisely what this backend is, and
#: a test that needs to reset the limiter between cases (tests/test_api_key_
#: credential.py) has one obvious thing to clear.
_hits: dict[str, deque] = defaultdict(deque)


class RateLimitError(AppError):
    code = "RATE_LIMITED"
    status_code = 429


def _now_ms() -> int:
    """Wall-clock milliseconds. See the timestamp note in DECISION 1."""
    return int(time.time() * 1000)


class RateLimiter(Protocol):
    """What a backend has to do: record a hit, or raise RateLimitError."""

    async def hit(self, key: str, limit: int, window: float) -> None: ...


class MemoryRateLimiter:
    """Per-process sliding window. Correct for exactly one worker, and no more.

    Kept as an explicitly-selected backend, never as a failure mode — see
    DECISION 3. `time.monotonic` is right HERE (unlike in the Redis backend) because
    the window never leaves this process, and a monotonic clock cannot be dragged
    backwards by an NTP step in the middle of somebody's lockout.
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
    """Sliding window in a shared Redis sorted set. See DECISION 1.

    The client is injected rather than constructed here so the suite can drive the
    real algorithm against an in-process double, and so two instances can be
    pointed at one store to prove the window is genuinely shared — which is the
    entire property this class exists to provide.
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
        # A unique member per hit: the score alone is not unique (two hits can land
        # in the same millisecond) and ZADD would silently overwrite, under-counting
        # exactly when traffic is heaviest.
        member = f"{now}-{uuid.uuid4().hex}"
        try:
            async with self._client.pipeline(transaction=True) as pipe:
                pipe.zremrangebyscore(redis_key, "-inf", now - window_ms)
                pipe.zadd(redis_key, {member: now})
                pipe.zcard(redis_key)
                # Re-armed on every hit so an idle key disappears on its own. The
                # window itself is enforced by the score-based prune above, not by
                # this TTL; the TTL is only there so Redis does not accumulate a key
                # per IP that ever touched the service.
                pipe.pexpire(redis_key, window_ms)
                _, _, count, _ = await pipe.execute()
        except Exception as exc:  # noqa: BLE001 — any store failure, one policy
            # Deliberately every exception and not just ConnectionError: a DNS
            # failure, a timeout, an OOM'd Redis and a MOVED from a cluster are all
            # "the store did not answer", and enumerating them means the one that
            # was not on the list becomes a 500 on the login endpoint. The cost is
            # that a genuine BUG in this method would also fail open — which is why
            # it is counted and logged rather than passed over, and why the suite
            # drives this code against a double that implements the real command
            # shapes.
            self._fail_open(exc)
            return
        if count > limit:
            raise RateLimitError("too many requests — please try again shortly")

    def _fail_open(self, exc: Exception) -> None:
        """Allow the request, but never quietly. See DECISION 2."""
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


#: The process-wide limiter. Resolved once, by name, and logged — see DECISION 3.
_limiter: RateLimiter | None = None


def configure_rate_limiter(settings: Settings | None = None) -> RateLimiter:
    """Choose the backend from config, announce it, and install it process-wide.

    Called from `create_app` so the choice appears in the startup log next to the
    other things an operator needs to be able to confirm from a log line. Idempotent
    in effect: calling it again re-resolves and re-announces.
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
        # Configured for Redis with nowhere to reach it. Refusing to boot would be
        # defensible; falling back is chosen because this is a MISCONFIGURATION and
        # the log names it, whereas a runtime connection failure is an OUTAGE and
        # gets the fail-open path instead. The two are not the same event and do not
        # get the same answer.
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

    `client_ip`, not `request.client.host`. Behind a gateway the peer is the GATEWAY,
    so this cap applied to the whole deployment at once: one office locked out
    everyone, and ten requests a minute denied login to every user in the estate.
    """
    ip = client_ip(request)
    await hit(f"login:{ip}", get_settings().rate_limit_login_per_minute, 60.0)


async def api_key_rate_limit(request: Request) -> None:
    """FastAPI dependency: throttle the API-key exchange by client IP.

    A SEPARATE BUCKET from login, deliberately. Both endpoints turn a secret into
    a token and both need a brute-force floor, but sharing one budget makes them
    each other's denial of service: a peer product re-exchanging on a schedule
    would eat the login allowance for every human behind the same egress IP, and
    one person fat-fingering their password would start failing a production
    integration. Neither is a failure anyone would attribute to a rate limiter.

    The allowance is higher than login's for the same reason it can be: the secret
    is 256 bits of ``secrets.token_urlsafe`` rather than something a human chose,
    so the limit exists to stop a flood, not to make guessing infeasible — that is
    already true at any rate.
    """
    # Same reasoning as login_rate_limit: the peer is the gateway.
    ip = client_ip(request)
    await hit(f"apikey:{ip}", get_settings().rate_limit_api_key_per_minute, 60.0)
