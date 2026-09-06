"""Liveness and readiness are different questions, and this service had only one.

`/health` answered 200 while the process was up and touched nothing. There was no
`/readyz`, so an orchestrator could not tell a working vision service from one
whose database had gone — on the service holding every camera, recording and
evidence lock.

The separation is the point. Liveness must never touch a dependency: a restart
does not fix a database that is down, and restarting on it turns a recoverable
outage into a loop. Readiness must, and must say which one failed.
"""

from __future__ import annotations

import pytest

from app import probes

from .conftest import client


async def test_health_touches_no_dependency(app, monkeypatch):
    """If it did, a database outage would restart this container in a loop."""

    async def _boom():
        raise AssertionError("liveness must not check the database")

    monkeypatch.setattr(probes, "check_database", _boom)
    async with client(app) as c:
        r = await c.get("/health")
    assert r.status_code == 200, r.text
    assert r.json()["service"] == "vision"


async def test_readyz_is_green_when_the_dependencies_answer(app, monkeypatch):
    monkeypatch.setattr(probes, "check_database", _none)
    monkeypatch.setattr(probes, "check_events", lambda: None)
    async with client(app) as c:
        r = await c.get("/readyz")
    assert r.status_code == 200, r.text
    assert r.json()["checks"] == {"database": "ok", "events": "ok"}


async def test_readyz_names_the_dependency_that_failed(app, monkeypatch):
    """A 503 that does not say which one sends an operator to read logs."""

    async def _down():
        return "database unavailable: OSError"

    monkeypatch.setattr(probes, "check_database", _down)
    monkeypatch.setattr(probes, "check_events", lambda: None)
    async with client(app) as c:
        r = await c.get("/readyz")
    assert r.status_code == 503, r.text
    assert r.json()["checks"]["database"] == "database unavailable: OSError"
    assert r.json()["checks"]["events"] == "ok"


async def test_an_unset_event_bus_is_not_a_fault(monkeypatch):
    """A standalone deployment runs with no spine and serves its API perfectly.
    Failing readiness for that would take the VMS down for a choice."""
    from kernel import config

    monkeypatch.setenv("VE_NATS_URL", "")
    config.get_settings.cache_clear()
    try:
        assert probes.check_events() is None
    finally:
        config.get_settings.cache_clear()


async def test_a_configured_bus_that_is_not_connected_is_a_fault(monkeypatch):
    """The other half: a spine that was asked for and is not there IS a fault,
    because events this service publishes are silently going nowhere."""
    from kernel import config

    from app.vms.common import events as ev

    monkeypatch.setenv("VE_NATS_URL", "nats://nats:4222")
    config.get_settings.cache_clear()
    monkeypatch.setattr(ev.bus, "_nc", None, raising=False)
    try:
        assert probes.check_events() == "event bus configured but not connected"
    finally:
        config.get_settings.cache_clear()


async def _none():
    return None
