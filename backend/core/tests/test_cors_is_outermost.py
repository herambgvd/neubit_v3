"""A REFUSAL AN OPERATOR CANNOT READ IS WORSE THAN THE REFUSAL.

CORSMiddleware was added first, which in Starlette makes it INNERMOST — so any
response produced by a middleware outside it never passed back through it. Hitting
the rate limit from another origin produced a 429 with no
Access-Control-Allow-Origin, the browser blocked it, and the client reported a
CORS failure. That sends whoever is debugging to look at origins and gateways,
which is the one place the problem is not.

The chain is asserted by ORDER rather than by exercising every refusal, because
the rule is about position: whatever is outermost is what stamps the header onto
everything, including responses this test does not know about yet.
"""

from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware

from app.app import create_base_app


def _stack(app) -> list[str]:
    """Middleware classes, OUTERMOST FIRST.

    Read from Starlette rather than assumed, because the direction is easy to get
    backwards and a guard that has it backwards asserts the opposite of what it
    claims: `add_middleware` INSERTS AT 0, and `build_middleware_stack` wraps the
    list in reverse — so index 0 is applied last and therefore sits outermost.
    Which is the same thing as "the last one added wraps everything".
    """
    return [m.cls.__name__ for m in app.user_middleware]


def test_cors_is_the_outermost_middleware():
    names = _stack(create_base_app(title="test"))
    assert names, "no middleware registered — this guard would be vacuous"
    assert names[0] == CORSMiddleware.__name__, (
        "CORS must wrap everything, or a refusal raised by an outer middleware "
        f"reaches a browser without CORS headers. Outermost is {names[0]}. "
        f"Chain, outermost first: {names}"
    )


def test_every_refusing_middleware_sits_inside_cors():
    """The ones that answer on their own — a rate limit, a licence check, a body
    cap — are exactly the responses a cross-origin client cannot read if any of
    them ends up outside CORS."""
    names = _stack(create_base_app(title="test"))
    cors_at = names.index(CORSMiddleware.__name__)
    for refuser in ("GlobalRateLimitMiddleware", "RequestSizeLimitMiddleware"):
        assert refuser in names, f"{refuser} is gone — this guard no longer covers it"
        assert names.index(refuser) > cors_at, (
            f"{refuser} sits outside CORS, so the response it returns carries no "
            "Access-Control-Allow-Origin and a browser reports a CORS failure "
            "instead of the refusal."
        )
