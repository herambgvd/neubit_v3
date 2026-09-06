"""Every route needs the token, and a refusal is recorded.

There was no test that the agent is authenticated at all, and no log line when a
guess was refused — so an online guessing loop against the container that holds
the docker socket was invisible.
"""

from __future__ import annotations

import logging

import pytest

import main
from conftest import TOKEN, auth

#: Public by design: an orchestrator has no token. Everything else on this app
#: controls the docker socket and must not be reachable without one.
PUBLIC = {"/health", "/readyz", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

#: A concrete URL per privileged route, DERIVED FROM THE APP rather than listed.
#: The list used to be written out by hand, so a new route added to a container
#: that holds the docker socket would simply not have been covered — and nothing
#: would have said so. `test_the_inventory_covers_every_route` is what keeps this
#: honest if the derivation ever stops matching.
def _privileged_routes():
    from fastapi.routing import APIRoute

    out = []
    for route in main.app.routes:
        if not isinstance(route, APIRoute) or route.path in PUBLIC:
            continue
        # A real container name and service, so the request gets past routing and
        # into the auth dependency rather than 404-ing on the project whitelist.
        path = route.path.replace("{name}", "neubit-v3-core-1")
        for method in sorted(set(route.methods) - {"HEAD", "OPTIONS"}):
            out.append((method, path))
    return sorted(set(out))


ROUTES = _privileged_routes()


def test_the_inventory_covers_every_route():
    """A walk that finds nothing makes every test below pass over an empty list,
    and a route that slips out of PUBLIC by accident must be noticed."""
    from fastapi.routing import APIRoute

    all_paths = {r.path for r in main.app.routes if isinstance(r, APIRoute)}
    covered = {p for _, p in ROUTES}
    unaccounted = {
        p for p in all_paths
        if p not in PUBLIC and p.replace("{name}", "neubit-v3-core-1") not in covered
    }
    assert not unaccounted, unaccounted
    assert len(ROUTES) >= 9, ROUTES


@pytest.mark.parametrize("method,path", ROUTES)
@pytest.mark.parametrize("headers", [{}, {"X-Ops-Token": ""}, {"X-Ops-Token": "wrong"}])
async def test_every_privileged_route_refuses_a_bad_token(client, method, path, headers):
    r = await client.request(method, path, headers=headers)
    assert r.status_code == 401, f"{method} {path} -> {r.status_code}"


@pytest.mark.parametrize("path", ["/health", "/readyz"])
async def test_the_probes_are_open(client, path):
    """An orchestrator has no token, and neither answer says anything a caller
    could not learn by being refused."""
    r = await client.get(path)
    assert r.status_code in (200, 503)


async def test_an_unset_token_refuses_everyone(client, monkeypatch):
    """Fail closed. An unauthenticated docker-control endpoint must never exist,
    so a missing config refuses even the 'correct' empty header."""
    monkeypatch.setattr(main, "OPS_AGENT_TOKEN", "")
    assert (await client.get("/containers", headers={"X-Ops-Token": ""})).status_code == 401
    assert (await client.get("/containers", headers=auth())).status_code == 401


async def test_a_refusal_is_logged_with_the_peer(client, caplog):
    with caplog.at_level(logging.WARNING, logger="ops-agent"):
        await client.get("/containers", headers={"X-Ops-Token": "guess"})
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "refused" in text and "/containers" in text


async def test_the_right_token_is_accepted(client):
    """Without this the whole file would pass against an agent that refuses
    everyone."""
    assert (await client.get("/containers", headers=auth(TOKEN))).status_code == 200
