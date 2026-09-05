"""The login brute-force cap has to mean the same number on every worker.

There was no test for rate limiting at all, which is how the module went years
with a window that lived in one process's memory. That is not a bug you can see in
a single-process test: every assertion you would naturally write — "the 11th login
is refused" — passes perfectly against an implementation that gives each of four
workers its own set of eleven.

So the load-bearing test in this file is `test_two_processes_share_one_window`.
Everything else here is a guard against the ways a shared limiter can be wrong in
the easy direction (refusing too much, never forgiving, mixing up callers); that
one is the only assertion the old implementation could not satisfy, and it is the
reason the module changed.

The suite is offline (`run-tests.sh --network none`), so there is no Redis. The
double below implements the four REDIS commands the limiter uses plus MULTI/EXEC —
sorted sets, scores, key expiry — and nothing about rate limiting. The sliding
window lives entirely in `RedisRateLimiter`, so these tests exercise the real
algorithm; if the double contained the decision they would only be testing itself.
Injection follows tests/test_stream_authorization.py: the module ATTRIBUTE is
substituted (`ratelimit._limiter`), not a name some other module already imported.
"""

from __future__ import annotations

import asyncio
import logging
import time

import pytest

from app.core import ratelimit
from app.core.ratelimit import MemoryRateLimiter, RateLimitError, RedisRateLimiter

pytestmark = pytest.mark.asyncio


def _fail_opens() -> float:
    """The fail-open counter as a scrape would see it, not via a private field."""
    from prometheus_client import REGISTRY

    return REGISTRY.get_sample_value("edge_rate_limit_fail_open_total") or 0.0

# Short enough that "wait for the window to pass" is a real wait and not a slow
# test, long enough that scheduling jitter cannot expire it early.
WINDOW = 0.4


class _Down(Exception):
    """Stands in for redis.exceptions.ConnectionError.

    Deliberately not the real class: the limiter's contract is "ANY failure of the
    store is a fail-open", and asserting that with the one exception type we happen
    to expect would let a DNS error, a timeout or a decode error through as a 500.
    """


class FakeRedis:
    """An in-process Redis: sorted sets, score ranges, TTLs, MULTI/EXEC.

    Faithful to Redis where it matters to this limiter and to nothing else. It
    knows how ZADD, ZREMRANGEBYSCORE, ZCARD and PEXPIRE behave; it does not know
    what a rate limit is. `fail` makes every EXEC raise, which is how the
    store-unreachable case is reached without a network.
    """

    def __init__(self) -> None:
        self.zsets: dict[str, dict[str, float]] = {}
        self.expires_at: dict[str, float] = {}
        self.fail = False
        self.execs = 0

    # --- expiry -----------------------------------------------------------
    def _reap(self, key: str) -> None:
        deadline = self.expires_at.get(key)
        if deadline is not None and time.monotonic() >= deadline:
            self.zsets.pop(key, None)
            self.expires_at.pop(key, None)

    # --- commands ---------------------------------------------------------
    def _zremrangebyscore(self, key, lo, hi):
        self._reap(key)
        bucket = self.zsets.get(key, {})
        lo = float("-inf") if lo == "-inf" else float(lo)
        hi = float("inf") if hi == "+inf" else float(hi)
        doomed = [m for m, score in bucket.items() if lo <= score <= hi]
        for m in doomed:
            del bucket[m]
        return len(doomed)

    def _zadd(self, key, mapping):
        self._reap(key)
        bucket = self.zsets.setdefault(key, {})
        added = sum(1 for m in mapping if m not in bucket)
        bucket.update(mapping)
        return added

    def _zcard(self, key):
        self._reap(key)
        return len(self.zsets.get(key, {}))

    def _pexpire(self, key, ms):
        self._reap(key)
        if key not in self.zsets:
            return 0
        self.expires_at[key] = time.monotonic() + ms / 1000.0
        return 1

    def pipeline(self, transaction: bool = True):
        assert transaction, "the limiter must queue its commands in MULTI/EXEC"
        return _FakePipeline(self)


class _FakePipeline:
    """MULTI/EXEC: commands are queued, then applied with nothing interleaved.

    `execute` performs every queued command before it yields control, which is the
    guarantee Redis gives a transaction — and the guarantee the limiter depends on.
    A double that awaited between commands would let the concurrency test pass
    against a racy implementation.
    """

    def __init__(self, store: FakeRedis) -> None:
        self._store = store
        self._queued: list[tuple[str, tuple]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def zremrangebyscore(self, key, lo, hi):
        self._queued.append(("_zremrangebyscore", (key, lo, hi)))
        return self

    def zadd(self, key, mapping):
        self._queued.append(("_zadd", (key, mapping)))
        return self

    def zcard(self, key):
        self._queued.append(("_zcard", (key,)))
        return self

    def pexpire(self, key, ms):
        self._queued.append(("_pexpire", (key, ms)))
        return self

    async def execute(self):
        if self._store.fail:
            raise _Down("connection refused")
        self._store.execs += 1
        return [getattr(self._store, op)(*args) for op, args in self._queued]


@pytest.fixture(autouse=True)
def _restore_process_limiter():
    """`configure_rate_limiter` installs a process-wide limiter. Tests that call it
    must not leak that choice into the next test — or into the rest of the suite,
    which conftest deliberately pins to the in-memory backend."""
    saved = ratelimit._limiter
    yield
    ratelimit._limiter = saved


@pytest.fixture
def store() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
def limiter(store) -> RedisRateLimiter:
    return RedisRateLimiter(store)


# --- the window itself -------------------------------------------------------


async def test_the_limit_is_spent_exactly_and_the_next_request_is_refused(limiter):
    for i in range(3):
        await limiter.hit("ip:1.2.3.4", 3, WINDOW)  # must not raise
    with pytest.raises(RateLimitError):
        await limiter.hit("ip:1.2.3.4", 3, WINDOW)


async def test_a_request_after_the_window_has_passed_is_allowed(limiter):
    """Without this, "refuse everything" would pass every other test in the file."""
    await limiter.hit("ip:5.6.7.8", 1, WINDOW)
    with pytest.raises(RateLimitError):
        await limiter.hit("ip:5.6.7.8", 1, WINDOW)
    await asyncio.sleep(WINDOW * 1.5)
    await limiter.hit("ip:5.6.7.8", 1, WINDOW)  # forgiven


async def test_two_different_keys_do_not_share_a_bucket(limiter):
    """One IP exhausting its budget must not lock out an unrelated one — otherwise
    a single attacker denies the whole product to everybody else, which is a worse
    outcome than the attack."""
    await limiter.hit("ip:10.0.0.1", 1, WINDOW)
    with pytest.raises(RateLimitError):
        await limiter.hit("ip:10.0.0.1", 1, WINDOW)
    await limiter.hit("ip:10.0.0.2", 1, WINDOW)  # a different caller, untouched


# --- THE ONE THAT MATTERS ----------------------------------------------------


async def test_two_processes_share_one_window(store):
    """THE POINT OF THE CHANGE.

    Two limiter instances against one store stand in for two uvicorn workers, or
    two replicas behind the gateway, sharing one Redis. Between them they get
    `limit` attempts IN TOTAL — not `limit` each.

    The old implementation cannot pass this. Its window was a dict in the module,
    so "two instances" was one bucket only by accident of being one process; give
    it two processes and the cap silently becomes 2x. That is the defect, and this
    is the assertion that names it.
    """
    worker_a = RedisRateLimiter(store)
    worker_b = RedisRateLimiter(store)

    await worker_a.hit("login:198.51.100.7", 4, WINDOW)
    await worker_b.hit("login:198.51.100.7", 4, WINDOW)
    await worker_a.hit("login:198.51.100.7", 4, WINDOW)
    await worker_b.hit("login:198.51.100.7", 4, WINDOW)

    # Four spent between them. The FIFTH is refused whichever worker it lands on.
    with pytest.raises(RateLimitError):
        await worker_b.hit("login:198.51.100.7", 4, WINDOW)
    with pytest.raises(RateLimitError):
        await worker_a.hit("login:198.51.100.7", 4, WINDOW)


async def test_concurrent_hits_cannot_both_win(store):
    """A read-then-write limiter passes every sequential test above and still lets
    two simultaneous requests through on the same last slot. Fire the whole budget
    plus one at once, from separate instances, and count the refusals."""
    workers = [RedisRateLimiter(store) for _ in range(8)]
    results = await asyncio.gather(
        *(w.hit("login:203.0.113.9", 5, WINDOW) for w in workers),
        return_exceptions=True,
    )
    allowed = [r for r in results if not isinstance(r, Exception)]
    refused = [r for r in results if isinstance(r, RateLimitError)]
    assert len(allowed) == 5, f"expected exactly 5 through, got {len(allowed)}"
    assert len(refused) == 3


# --- the store is down -------------------------------------------------------


async def test_a_dead_store_fails_open_and_says_so(store, caplog):
    """DECISION 2: allow the request, bump a counter, log at ERROR.

    Failing closed would turn a Redis restart into "nobody can log in", including
    the operator who has to log in to fix it. The per-account lockout in Postgres
    still bounds credential guessing while this is happening; what is lost is the
    per-IP flood ceiling, and losing it must be visible.
    """
    limiter = RedisRateLimiter(store)
    store.fail = True
    before = _fail_opens()

    with caplog.at_level(logging.ERROR, logger="edge.ratelimit"):
        for _ in range(3):
            await limiter.hit("login:192.0.2.1", 1, WINDOW)  # must NOT raise

    assert _fail_opens() == before + 3, "every fail-open must count"
    assert caplog.records, "a rate limiter that stops limiting must not do it silently"
    assert "FAILING OPEN" in caplog.records[0].message


async def test_the_fail_open_log_is_throttled_but_the_counter_is_not(store, caplog):
    """Under the global middleware an outage is one failure per request. The log is
    throttled so it does not bury itself; the counter is the lossless record."""
    limiter = RedisRateLimiter(store)
    store.fail = True
    before = _fail_opens()
    with caplog.at_level(logging.ERROR, logger="edge.ratelimit"):
        for _ in range(50):
            await limiter.hit("login:192.0.2.2", 1, WINDOW)
    assert len(caplog.records) == 1
    assert _fail_opens() == before + 50


async def test_a_dead_store_does_not_quietly_become_a_per_process_window(store):
    """The fallback must never engage on a connection failure.

    Demoting to the in-memory window when Redis blinks would restore the original
    defect — a per-worker cap — at the exact moment somebody may be attacking, and
    it would look like the limiter was working. Fail open is a decision; silent
    demotion is the bug wearing a disguise.
    """
    limiter = RedisRateLimiter(store)
    store.fail = True
    _hits_before = dict(ratelimit._hits)
    for _ in range(5):
        await limiter.hit("login:192.0.2.3", 1, WINDOW)
    assert dict(ratelimit._hits) == _hits_before


# --- backend selection is explicit -------------------------------------------


async def test_the_backend_is_chosen_by_configuration_and_announced(caplog):
    """DECISION 3: the in-memory window is reachable only by asking for it, and
    saying so at startup. A per-process cap is fine for one worker and a silent
    security downgrade for anything else; nobody should have to read the code to
    find out which one is running."""
    from app.core.config import Settings

    with caplog.at_level(logging.WARNING, logger="edge.ratelimit"):
        chosen = ratelimit.configure_rate_limiter(
            Settings(rate_limit_backend="memory", redis_url="redis://x:6379/0")
        )
    assert isinstance(chosen, MemoryRateLimiter)
    assert any("PER PROCESS" in r.message for r in caplog.records)


async def test_redis_with_no_url_is_a_named_misconfiguration_not_a_shrug(caplog):
    from app.core.config import Settings

    with caplog.at_level(logging.WARNING, logger="edge.ratelimit"):
        chosen = ratelimit.configure_rate_limiter(
            Settings(rate_limit_backend="redis", redis_url="")
        )
    assert isinstance(chosen, MemoryRateLimiter)
    assert any("VE_REDIS_URL is empty" in r.message for r in caplog.records)


async def test_an_unknown_backend_refuses_to_boot():
    """A typo in VE_RATE_LIMIT_BACKEND must not be answered by picking one."""
    from app.core.config import Settings

    with pytest.raises(RuntimeError):
        ratelimit.configure_rate_limiter(Settings(rate_limit_backend="redsi"))


# --- the call sites still work ------------------------------------------------


class _Req:
    """Just enough Request for the two dependencies."""

    def __init__(self, host: str) -> None:
        self.client = type("C", (), {"host": host})()


async def test_the_login_dependency_goes_through_the_process_limiter(store, monkeypatch):
    """`hit` reads `_limiter` at call time, so substituting the module attribute is
    enough — the same reason test_stream_authorization patches `get_sessionmaker`
    rather than a name the route already imported."""
    monkeypatch.setattr(ratelimit, "_limiter", RedisRateLimiter(store))
    monkeypatch.setattr(
        ratelimit, "get_settings", lambda: type("S", (), {"rate_limit_login_per_minute": 2})()
    )
    await ratelimit.login_rate_limit(_Req("1.1.1.1"))
    await ratelimit.login_rate_limit(_Req("1.1.1.1"))
    with pytest.raises(RateLimitError):
        await ratelimit.login_rate_limit(_Req("1.1.1.1"))
    assert store.execs == 3


async def test_login_and_api_key_do_not_share_a_budget(store, monkeypatch):
    """The separate-bucket promise in api_key_rate_limit's docstring, asserted.

    It was only ever a comment; a refactor that merged the two keys would have been
    invisible. A machine re-exchanging its API key on a schedule must not eat the
    login allowance of every human behind the same egress IP.
    """
    monkeypatch.setattr(ratelimit, "_limiter", RedisRateLimiter(store))
    monkeypatch.setattr(
        ratelimit,
        "get_settings",
        lambda: type(
            "S", (), {"rate_limit_login_per_minute": 1, "rate_limit_api_key_per_minute": 1}
        )(),
    )
    await ratelimit.login_rate_limit(_Req("2.2.2.2"))
    with pytest.raises(RateLimitError):
        await ratelimit.login_rate_limit(_Req("2.2.2.2"))
    await ratelimit.api_key_rate_limit(_Req("2.2.2.2"))  # its own budget, untouched


async def test_the_global_middleware_awaits_the_limiter(store, monkeypatch):
    """`hit` is a coroutine now. A middleware that forgot to await it would never
    raise, never refuse, and never fail a test that only checks 200s — the cap
    would just be gone. So the refusal is asserted through the middleware itself.
    """
    from starlette.responses import Response

    from app.core.api import GlobalRateLimitMiddleware

    monkeypatch.setattr(ratelimit, "_limiter", RedisRateLimiter(store))
    mw = GlobalRateLimitMiddleware(app=None, limit=2, skip_prefixes=("/health",))

    class _Url:
        path = "/api/v1/auth/login"

    request = _Req("9.9.9.9")
    request.method = "POST"
    request.url = _Url()

    async def _next(_):
        return Response(status_code=200)

    assert (await mw.dispatch(request, _next)).status_code == 200
    assert (await mw.dispatch(request, _next)).status_code == 200
    refused = await mw.dispatch(request, _next)
    assert refused.status_code == 429


async def test_the_memory_backend_still_works():
    """It is a supported backend, not dead code — a single-process install with no
    Redis selects it deliberately, so it stays under test. Its bucket store is the
    module-level `_hits`, which is what tests/test_api_key_credential.py clears."""
    ratelimit._hits.clear()
    mem = MemoryRateLimiter()
    await mem.hit("k", 2, WINDOW)
    await mem.hit("k", 2, WINDOW)
    with pytest.raises(RateLimitError):
        await mem.hit("k", 2, WINDOW)
    await mem.hit("other", 2, WINDOW)  # a separate bucket
    ratelimit._hits.clear()
