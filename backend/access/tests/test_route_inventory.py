"""Every route, over HTTP, refuses an anonymous caller and a caller with no keys.

WHY THIS AND NOT THE STATIC CHECK
----------------------------------
`test_permission_split.py::test_every_route_is_still_gated` walks the dependency
tree and asserts a `require_permission` is present. That is the right check for
"somebody added a route and forgot the gate", and it is not the same question as
"the gate answers". A dependency can be declared and still not be reached — an
earlier dependency that raises something else, a router mounted without its
gates, a path that 500s before any of it runs. This asks the service, over the
wire, one route at a time.

It also puts 31 routes under a test for the first time. The suite exercised
instances and doors thoroughly and had never issued a single request to
access-groups, schedules, cards, sync-jobs, the scheduled/hardware mirrors, or
most of the command surface — so a 500 in any of them was something only a
customer would find.

WHAT THE TWO CASES MEAN
-----------------------
  * no Authorization header  → 401. Not 403, and never 200.
  * a valid token with an empty permission list → 403.

The second is the one worth having. A 401 is also what a broken route returns
when it blows up before authentication, so 401 alone cannot tell "refused"
from "did not get that far". A 403 is proof the request reached the permission
gate with an identity in hand.

A 500 from either is a failure. So is a 2xx: none of these paths should be
reachable without a key.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.routing import APIRoute

from conftest import PREFIX, _client, auth

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()


def _routes():
    from app.access.router import router

    out = []
    for r in router.routes:
        if not isinstance(r, APIRoute):
            continue
        for method in sorted(set(r.methods) - {"HEAD", "OPTIONS"}):
            out.append((method, r.path))
    return sorted(out)


def _url(path: str) -> str:
    """A concrete URL. Every path parameter on this router is a uuid or a free
    string, so one uuid substitutes for all of them."""
    parts = []
    for seg in path.split("/"):
        parts.append(str(uuid.uuid4()) if seg.startswith("{") and seg.endswith("}") else seg)
    return PREFIX + "/".join(parts)


ROUTES = _routes()


async def test_the_inventory_is_not_empty():
    """A walk that finds nothing makes every test below pass over an empty list."""
    assert len(ROUTES) >= 55, ROUTES


@pytest.mark.parametrize("method,path", ROUTES, ids=lambda v: str(v))
async def test_anonymous_is_refused(app, method, path):
    async with _client(app) as c:
        r = await c.request(method, _url(path), json={} if method in ("POST", "PATCH", "PUT") else None)
    assert r.status_code == 401, f"{method} {path} -> {r.status_code}: {r.text[:200]}"


@pytest.mark.parametrize("method,path", ROUTES, ids=lambda v: str(v))
async def test_a_caller_with_no_keys_is_refused(app, method, path):
    """403, so the refusal is proved to come from the permission gate rather than
    from the route failing before anything looked at the caller."""
    async with _client(app) as c:
        r = await c.request(
            method,
            _url(path),
            headers=auth(tenant_id=TENANT, permissions=[]),
            json={} if method in ("POST", "PATCH", "PUT") else None,
        )
    assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:200]}"
