"""Every route, over HTTP, refuses an anonymous caller and a caller with no keys.

`test_route_permissions.py` walks `route.dependant` and asserts a
`require_permission` is present. That is the right check for "somebody added a
route and forgot the gate", and it is a DIFFERENT question from "the gate
answers". A dependency can be declared and never reached — an earlier dependency
that raises something else, a router mounted without its gates, a path that 500s
before any of it runs. Nothing here had ever asked the service itself: this suite
was entirely pure, and not one of the 55 routes had been CALLED.

WHAT THE TWO CASES MEAN
-----------------------
  * no Authorization header               -> 401. Not 403, and never 200.
  * a valid token with no permissions     -> 403.

The second is the one worth having. A 401 is also what a broken route returns when
it blows up before authentication, so 401 alone cannot tell "refused" from "did
not get that far". A 403 is proof the request reached the permission gate with an
identity in hand.

A 500 from either is a failure. So is a 2xx: none of these paths should be
reachable without a key.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.routing import APIRoute

from conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
BODY_METHODS = ("POST", "PUT", "PATCH")


def _routes():
    from app.workflow.router import routers

    out = []
    for router in routers:
        for route in router.routes:
            if not isinstance(route, APIRoute):
                continue
            for method in sorted(set(route.methods) - {"HEAD", "OPTIONS"}):
                out.append((method, route.path))
    return sorted(set(out))


def _url(path: str) -> str:
    """A concrete URL. Every path parameter on these routers is an id, and a uuid
    is accepted wherever one is (str params take it too)."""
    parts = [
        str(uuid.uuid4()) if seg.startswith("{") and seg.endswith("}") else seg
        for seg in path.split("/")
    ]
    return PREFIX + "/".join(parts)


ROUTES = _routes()


async def test_the_inventory_is_not_empty():
    """A walk that finds nothing makes every test below pass over an empty list."""
    assert len(ROUTES) >= 55, ROUTES


@pytest.mark.parametrize("method,path", ROUTES, ids=lambda v: str(v))
async def test_anonymous_is_refused(app, method, path):
    async with client(app) as c:
        r = await c.request(
            method, _url(path), json={} if method in BODY_METHODS else None
        )
    assert r.status_code == 401, f"{method} {path} -> {r.status_code}: {r.text[:200]}"


@pytest.mark.parametrize("method,path", ROUTES, ids=lambda v: str(v))
async def test_a_caller_with_no_keys_is_refused(app, method, path):
    """403, so the refusal is proved to come from the permission gate rather than
    from the route failing before anything looked at the caller."""
    async with client(app) as c:
        r = await c.request(
            method,
            _url(path),
            headers=auth(tenant_id=TENANT, permissions=[]),
            json={} if method in BODY_METHODS else None,
        )
    assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:200]}"
