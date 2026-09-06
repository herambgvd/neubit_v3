"""Liveness and readiness answer different questions, and readiness must fail.

The service had a static /health, no /readyz, and no healthcheck consuming
either — so "access is up" was a statement about nothing.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app import probes
from conftest import _client

pytestmark = pytest.mark.asyncio


async def _get(app, path: str) -> httpx.Response:
    async with _client(app) as c:
        return await c.get(path)


async def test_readyz_is_503_and_names_the_broken_dependency(app, monkeypatch):
    async def _down() -> str:
        return "database: ConnectionRefusedError"

    monkeypatch.setattr(probes, "check_database", _down)
    monkeypatch.setattr(probes, "check_events", lambda: None)
    r = await _get(app, "/readyz")
    assert r.status_code == 503
    body = json.loads(r.text)
    assert body["status"] == "not_ready"
    assert body["checks"]["database"].startswith("database:")
    # A 503 that only says "not ready" sends an operator looking at two systems.
    assert body["checks"]["events"] == "ok"


async def test_a_dead_event_bus_is_a_readiness_failure(app, monkeypatch):
    """Access events feed workflow's SOP triggering. A dead bus means door and
    alarm events silently stop reaching it."""

    async def _ok() -> None:
        return None

    monkeypatch.setattr(probes, "check_database", _ok)
    monkeypatch.setattr(probes, "check_events", lambda: "events: NATS not connected")
    r = await _get(app, "/readyz")
    assert r.status_code == 503
    assert "NATS" in json.loads(r.text)["checks"]["events"]


async def test_readyz_is_200_when_everything_answers(app, monkeypatch):
    async def _ok() -> None:
        return None

    monkeypatch.setattr(probes, "check_database", _ok)
    monkeypatch.setattr(probes, "check_events", lambda: None)
    r = await _get(app, "/readyz")
    assert r.status_code == 200
    assert json.loads(r.text)["status"] == "ok"


async def test_health_says_nothing_about_dependencies(app, monkeypatch):
    """A deliberate split. Nobody should 'fix' /health by giving it a database
    check: an instance that is alive but not ready has to stay distinguishable
    from one that is dead, or a restart loop and a dependency outage look the same
    to the orchestrator."""

    async def _down() -> str:
        return "database: down"

    monkeypatch.setattr(probes, "check_database", _down)
    r = await _get(app, "/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_offline_listeners_do_not_fail_readiness(app, monkeypatch):
    """A controller on a customer LAN goes offline routinely. Failing the whole
    access API for that would take it down for a fault it cannot fix."""

    async def _ok() -> None:
        return None

    monkeypatch.setattr(probes, "check_database", _ok)
    monkeypatch.setattr(probes, "check_events", lambda: None)
    monkeypatch.setattr(probes, "listener_count", lambda: 0)
    r = await _get(app, "/readyz")
    assert r.status_code == 200
    assert json.loads(r.text)["listeners"] == 0


async def test_an_unset_nats_url_is_not_a_fault(monkeypatch):
    """A deployment without NATS runs fine; only 'configured but disconnected' is
    a fault."""
    from kernel import config

    monkeypatch.setenv("VE_NATS_URL", "")
    config.get_settings.cache_clear()
    try:
        assert probes.check_events() is None
    finally:
        config.get_settings.cache_clear()


async def test_the_deployment_actually_probes_readiness():
    """The code was never the problem here either — the service had no healthcheck.
    Without this, /readyz can silently become unconsumed again."""
    import os
    import pathlib

    root = pathlib.Path(os.environ.get("VE_REPO_ROOT") or pathlib.Path(__file__).resolve().parents[3])
    compose = root / "deploy" / "docker-compose.yml"
    # Deliberately not skip-if-absent: a test that quietly skips is how /readyz
    # went unconsumed in the first place.
    assert compose.is_file(), f"cannot read {compose} — check run-tests.sh mounts deploy/"
    text = compose.read_text()
    block = text[text.index("\n  access:"):]
    block = block[: block.index("\n  vision:")]
    assert "http://localhost:8000/readyz" in block, "access has no healthcheck on /readyz"
