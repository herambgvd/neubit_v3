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

ROUTES = [
    ("GET", "/containers"),
    ("GET", "/containers/neubit-v3-core-1/logs"),
    ("POST", "/containers/neubit-v3-core-1/restart"),
    ("POST", "/containers/neubit-v3-core-1/stop"),
    ("POST", "/containers/neubit-v3-core-1/start"),
    ("POST", "/services/core/scale"),
    ("GET", "/host"),
    ("GET", "/db/export"),
    ("POST", "/db/import"),
]


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
