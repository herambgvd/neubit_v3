"""Who a request is attributed to — for rate limiting, and for the session record.

Two places needed the caller's address and they disagreed, both wrongly:

  * `_client_ip` (session records) read `X-Forwarded-For` and believed it
    unconditionally, taking the LEFTMOST hop. Core's port 8000 is published in dev,
    so a request reaching the app directly could set that header to anything — the
    IP shown on "your active sessions" was a field the attacker filled in.
  * `login_rate_limit` used `request.client.host` with no forwarding at all. Behind
    Traefik that is the GATEWAY, so `10/min per IP` was 10/min for the whole
    deployment: one office locks out everyone, and ten requests a minute denies
    login to every user in the estate.

Fixing the second by copying the first would have been worse than either — a caller
who can set the header freely gets a fresh bucket per request, which removes the cap
instead of sharing it. So the header is trusted only from a configured proxy, and
the hop taken is the rightmost untrusted one, because a trusted proxy APPENDS the
peer it saw rather than replacing what the client sent.
"""

from __future__ import annotations

import pytest

from app.core import config
from app.core.client_ip import UNKNOWN, client_ip


class _Req:
    """The two things `client_ip` reads, and nothing else."""

    def __init__(self, peer: str | None, xff: str | None = None) -> None:
        self.client = type("C", (), {"host": peer})() if peer else None
        self.headers = {"x-forwarded-for": xff} if xff else {}


@pytest.fixture
def trusting(monkeypatch):
    monkeypatch.setenv("VE_TRUSTED_PROXY_CIDRS", '["10.0.0.0/8"]')
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.fixture
def trusting_nobody(monkeypatch):
    monkeypatch.setenv("VE_TRUSTED_PROXY_CIDRS", "[]")
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def test_an_untrusted_peer_cannot_forge_its_address(trusting_nobody):
    """The default. Nothing is trusted, so the header is ignored entirely — which is
    correct for a core exposed directly, and is what makes the setting safe to ship
    empty."""
    assert client_ip(_Req("203.0.113.9", xff="1.2.3.4")) == "203.0.113.9"


def test_a_forwarded_address_is_used_when_the_proxy_is_trusted(trusting):
    assert client_ip(_Req("10.0.0.5", xff="203.0.113.9")) == "203.0.113.9"


def test_a_client_supplied_hop_is_not_believed_over_the_one_the_proxy_saw(trusting):
    """THE ONE THAT MATTERS. A client sends its own X-Forwarded-For; the proxy
    APPENDS the peer it actually saw. Taking the leftmost hop — which is what the
    session recorder used to do — returns the attacker's value, and every request
    can carry a different one."""
    forged = "9.9.9.9"
    real = "203.0.113.9"
    assert client_ip(_Req("10.0.0.5", xff=f"{forged}, {real}")) == real


def test_a_chain_of_trusted_proxies_is_walked_through(trusting):
    """Two hops inside the trusted network; the first untrusted one from the right
    is the caller."""
    assert client_ip(_Req("10.0.0.5", xff="203.0.113.9, 10.0.0.7, 10.0.0.6")) == "203.0.113.9"


def test_an_all_trusted_chain_falls_back_to_the_peer(trusting):
    """Nothing in the chain is a real client, so there is nothing to believe."""
    assert client_ip(_Req("10.0.0.5", xff="10.0.0.7, 10.0.0.6")) == "10.0.0.5"


def test_garbage_in_the_header_does_not_become_a_bucket_key(trusting):
    """A non-address hop falls back to the peer. This value becomes a rate-limit
    bucket key, and a key built from arbitrary text is a way to grow the store
    without bound."""
    assert client_ip(_Req("10.0.0.5", xff="not-an-ip")) == "10.0.0.5"
    assert client_ip(_Req("10.0.0.5", xff="")) == "10.0.0.5"


def test_no_peer_at_all_is_a_named_placeholder(trusting_nobody):
    assert client_ip(_Req(None)) == UNKNOWN


def test_an_unparseable_cidr_does_not_silently_trust_everything(monkeypatch):
    """A typo in the setting must degrade to "trust nothing", not to "trust all" —
    and the difference between those two is the whole control."""
    monkeypatch.setenv("VE_TRUSTED_PROXY_CIDRS", '["not-a-network"]')
    config.get_settings.cache_clear()
    try:
        assert client_ip(_Req("203.0.113.9", xff="1.2.3.4")) == "203.0.113.9"
    finally:
        config.get_settings.cache_clear()


def test_the_rate_limiter_and_the_session_recorder_agree():
    """They disagreed, and each was wrong in a different direction. Asserting they
    share one resolver is what stops them drifting apart again."""
    import inspect

    from app.auth.routes import _shared
    from app.core import ratelimit

    def code(fn: object) -> str:
        """Source with the docstring removed. The fixes QUOTE the old expressions to
        explain what was wrong with them, so matching on raw source would flag the
        explanation — and teach the next person to delete it."""
        import ast
        import textwrap

        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
        fn_node = tree.body[0]
        if (
            fn_node.body
            and isinstance(fn_node.body[0], ast.Expr)
            and isinstance(fn_node.body[0].value, ast.Constant)
        ):
            fn_node.body = fn_node.body[1:]
        return ast.unparse(fn_node)

    for fn in (ratelimit.login_rate_limit, ratelimit.api_key_rate_limit, _shared._client_ip):
        assert "client_ip(request)" in code(fn), fn
    # And neither reaches for the raw peer or the raw header any more.
    assert "request.client.host" not in code(ratelimit.login_rate_limit)
    assert "x-forwarded-for" not in code(_shared._client_ip).lower()


# --- the global middleware counted the whole estate into one bucket ----------
#
# The two rate-limit DEPENDENCIES were fixed to use `client_ip`; the MIDDLEWARE was
# not, and it is on the path of every request. So the coarse cap stayed
# per-deployment after the login cap stopped being. Two of three is the shape of
# fix this codebase keeps producing, which is why this asserts on all three.


def test_the_global_middleware_uses_the_shared_resolver():
    import ast
    import inspect
    import textwrap

    from app.core.api import GlobalRateLimitMiddleware

    tree = ast.parse(textwrap.dedent(inspect.getsource(GlobalRateLimitMiddleware.dispatch)))
    fn = tree.body[0]
    if fn.body and isinstance(fn.body[0], ast.Expr) and isinstance(fn.body[0].value, ast.Constant):
        fn.body = fn.body[1:]
    src = ast.unparse(fn)
    assert "client_ip(request)" in src
    assert "request.client.host" not in src


def test_probes_are_exempt_by_exact_path_not_by_prefix():
    """`startswith` also exempted `/health-bypass` and `/metrics-anything` — a
    prefix match doing the job of a route match. Nothing served those today, which
    is exactly why it would have gone unnoticed."""
    from app.core.api import GlobalRateLimitMiddleware as M

    assert "/health" in M.EXEMPT_PATHS
    assert "/ready" in M.EXEMPT_PATHS
    assert "/metrics" in M.EXEMPT_PATHS
    assert "/health-bypass" not in M.EXEMPT_PATHS
    # And the exemption set must not have quietly grown to cover the API.
    assert not any(p.startswith("/api") for p in M.EXEMPT_PATHS)


def test_files_and_docs_are_no_longer_uncapped():
    """`/files` is the highest-bandwidth route in the product and served blobs with
    no cap at all; `/docs` and `/openapi.json` are what an attacker enumerates
    first. Neither exemption had an upside that a bigger budget does not cover."""
    from app.core.api import GlobalRateLimitMiddleware as M

    for path in ("/files", "/files/avatars/x.png", "/docs", "/redoc", "/openapi.json"):
        assert path not in M.EXEMPT_PATHS, path
    # /files still gets room to load a page full of images — a budget, not a ban.
    assert M.FILES_MULTIPLIER > 1
