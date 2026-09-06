"""Every route, over HTTP, and the public/private split stated rather than assumed.

This service is the platform's inbound trust boundary and it has TWO kinds of
route in one app. The config API is a normal JWT surface. The receiver is not: it
takes no token, it is reachable from the internet, and it authenticates with the
webhook's own secret. A route drifting from one side to the other is the failure
that matters here, and in either direction — a receiver that starts demanding a
JWT silently stops every integration, and a config route that stops demanding one
hands the estate's webhook secrets to anybody.

So the split is a list with reasons, and this asks the service which side each
route is actually on.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.routing import APIRoute

from conftest import PREFIX, _client, auth

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
BODY_METHODS = ("POST", "PUT", "PATCH")

#: Reachable without a JWT, and why. Nothing else may be.
PUBLIC = {
    "/health": "liveness for a load balancer",
    "/readyz": "readiness for an orchestrator, which has no token",
    "/metrics": "Prometheus scrape; counts only, no payloads",
    "/ingest/hooks/{slug}": "THE RECEIVER. A device has no principal — it "
                            "authenticates with the webhook's own secret, and the "
                            "slug is where the tenant comes from.",
    "/openapi.json": "schema",
    "/docs": "swagger",
    "/docs/oauth2-redirect": "swagger",
    "/redoc": "redoc",
}


#: Authenticated, but deliberately requiring no permission. `/whoami` echoes the
#: caller's own claims and holding a token is the whole qualification — it is how
#: an operator checks that a token verifies here at all. It must still refuse an
#: ANONYMOUS caller, so it stays in the 401 check below and is exempt only from
#: the 403 one.
AUTHENTICATED_ONLY = {
    f"{PREFIX}/ingest/whoami": "echoes the caller's own claims; a token is the "
                               "whole qualification",
}


def _walk(routes, prefix: str = ""):
    """Flatten deferred `include_router` wrappers into (full path, route) pairs.

    FastAPI defers an include: `app.routes` holds a wrapper whose `.original_router`
    carries the real routes and whose mount prefix lives on the wrapper's
    `include_context`, not on the route's own `.path`. A naive iteration over
    `app.routes` sees FOUR routes on this service — the three probes and whoami —
    and every assertion built on it would then be about those four. core's
    inventory test carries the same note for the same reason; it found 41 of 216.
    """
    for route in routes:
        original = getattr(route, "original_router", None)
        if original is not None:
            ctx = getattr(route, "include_context", None)
            yield from _walk(original.routes, prefix + (getattr(ctx, "prefix", "") or ""))
            continue
        yield prefix + getattr(route, "path", ""), route


def _routes():
    from app.main import create_app

    out = []
    for path, route in _walk(create_app().routes):
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(set(route.methods) - {"HEAD", "OPTIONS"}):
            out.append((method, path))
    return sorted(set(out))


def _url(path: str) -> str:
    return "/".join(
        str(uuid.uuid4()) if seg.startswith("{") and seg.endswith("}") else seg
        for seg in path.split("/")
    )


ROUTES = _routes()
PRIVATE = [(m, p) for m, p in ROUTES if p not in PUBLIC]


async def test_the_walk_sees_the_whole_surface():
    """A walk that finds nothing makes every assertion below vacuous."""
    assert len(ROUTES) >= 20, len(ROUTES)
    assert len(PRIVATE) >= 18, len(PRIVATE)


@pytest.mark.parametrize("method,path", PRIVATE, ids=lambda v: str(v))
async def test_the_config_api_refuses_an_anonymous_caller(app, method, path):
    async with _client(app) as c:
        r = await c.request(
            method, _url(path), json={} if method in BODY_METHODS else None
        )
    assert r.status_code == 401, f"{method} {path} -> {r.status_code}: {r.text[:200]}"


NEEDS_A_PERMISSION = [(m, p) for m, p in PRIVATE if p not in AUTHENTICATED_ONLY]


@pytest.mark.parametrize("method,path", NEEDS_A_PERMISSION, ids=lambda v: str(v))
async def test_the_config_api_refuses_a_caller_with_no_keys(app, method, path):
    """403, so the refusal is proved to come from the permission gate rather than
    from the route failing before anything looked at the caller."""
    async with _client(app) as c:
        r = await c.request(
            method,
            _url(path),
            headers=auth(tenant_id=TENANT, permissions=[]),
            json={} if method in BODY_METHODS else None,
        )
    assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:200]}"


async def test_the_receiver_stays_open(app):
    """The other direction, and the one that would take every integration down
    silently. An unknown slug must be REFUSED, not challenged: 401 from the
    webhook secret check, never a JWT challenge, and never a 500."""
    async with _client(app) as c:
        r = await c.post(f"/ingest/hooks/{uuid.uuid4().hex}", json={"a": 1})
    assert r.status_code in (401, 404), r.text
    assert "WWW-Authenticate" not in r.headers, (
        "the receiver is challenging for a credential a device does not have"
    )


async def test_every_public_route_is_accounted_for():
    """A route that loses its gate must not quietly join the public set."""
    from app.main import create_app

    unlisted = []
    for path, route in _walk(create_app().routes):
        if not isinstance(route, APIRoute) or path in PUBLIC:
            continue
        names = set()

        def visit(dep):
            for sub in dep.dependencies:
                names.add(getattr(sub.call, "__qualname__", "") or type(sub.call).__name__)
                visit(sub)

        visit(route.dependant)
        if not any("require_permission" in n or "get_principal" in n or "get_scope" in n
                   for n in names):
            unlisted.append(f"{sorted(route.methods)[0]} {path}")
    assert not unlisted, (
        "these routes resolve no caller and are not in PUBLIC. Add the gate, or "
        "add the route with the reason it does not need one:\n  " + "\n  ".join(unlisted)
    )
