"""The project whitelist, and the two things that made /containers unusable."""

from __future__ import annotations

import pytest

from conftest import auth

OUTSIDE = "someone-elses-db"


async def test_only_project_containers_are_listed(client):
    r = await client.get("/containers", headers=auth())
    assert r.status_code == 200
    names = [c["name"] for c in r.json()]
    assert "neubit-v3-core-1" in names
    assert OUTSIDE not in names


@pytest.mark.parametrize(
    "method,path",
    [("GET", f"/containers/{OUTSIDE}/logs"),
     ("POST", f"/containers/{OUTSIDE}/restart"),
     ("POST", f"/containers/{OUTSIDE}/stop"),
     ("POST", f"/containers/{OUTSIDE}/start")],
)
async def test_a_container_outside_the_project_is_404_not_403(client, method, path):
    """404, so an unrelated host container's existence is not disclosed."""
    r = await client.request(method, path, headers=auth())
    assert r.status_code == 404


async def test_an_outside_container_is_never_acted_on(client, containers):
    await client.post(f"/containers/{OUTSIDE}/restart", headers=auth())
    outside = next(c for c in containers if c.name == OUTSIDE)
    assert outside.actions == [], "the whitelist let an action through"


async def test_a_project_container_is_acted_on(client, containers):
    """The whitelist must not be 'refuse everything'."""
    r = await client.post("/containers/neubit-v3-core-1/restart", headers=auth())
    assert r.status_code == 200
    core = next(c for c in containers if c.name == "neubit-v3-core-1")
    assert core.actions == ["restart"]


async def test_a_missing_container_is_404(client):
    r = await client.post("/containers/neubit-v3-nope-1/restart", headers=auth())
    assert r.status_code == 404


async def test_stats_are_gathered_concurrently(client, containers, monkeypatch):
    """Sequentially this measured 35.3s for 20 containers against core's 30s client
    timeout, so a super-admin's container list always failed. Asserted by timing a
    deliberately slow stats call: serial would be 3 x the delay."""
    import time

    delay = 0.15

    def slow_stats(self, stream=False):
        time.sleep(delay)
        return {}

    for c in containers:
        monkeypatch.setattr(type(c), "stats", slow_stats, raising=False)

    started = time.monotonic()
    r = await client.get("/containers", headers=auth())
    elapsed = time.monotonic() - started
    assert r.status_code == 200
    assert elapsed < delay * 2, f"stats look sequential ({elapsed:.2f}s)"


async def test_the_log_tail_is_clamped(client):
    """Do not let a caller pull gigabytes through the agent."""
    r = await client.get("/containers/neubit-v3-core-1/logs?tail=999999", headers=auth())
    assert r.status_code == 200
    assert r.json()["lines"] == ["line one", "line two"]


async def test_scale_is_501_not_a_false_success(client):
    """It used to answer 200 with ok=false, so core audit-logged the scale as
    though it had happened."""
    r = await client.post("/services/core/scale", headers=auth(), json={"replicas": 3})
    assert r.status_code == 501


async def test_readyz_fails_when_the_daemon_is_unreachable(client, docker_client):
    """The agent's whole purpose is the socket. Without this the container reported
    running while every request 502'd."""
    assert (await client.get("/readyz")).status_code == 200
    docker_client.ping_fails = True
    r = await client.get("/readyz")
    assert r.status_code == 503
    assert r.json()["checks"]["docker"] == "unreachable"


async def test_health_stays_up_when_the_daemon_is_down(client, docker_client):
    """Liveness and readiness are different questions — restarting the agent does
    not fix a dead daemon."""
    docker_client.ping_fails = True
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


async def test_health_does_not_disclose_the_project(client):
    """It is unauthenticated; it used to echo COMPOSE_PROJECT."""
    assert "project" not in (await client.get("/health")).json()
