"""Liveness and readiness answer DIFFERENT questions, and readiness must be able to fail.

`/ready` was written correctly and consumed by nothing: Traefik did not route the
path and the core service had no healthcheck, so the only reachable probe was
`/health` — `return {"status": "ok"}`, a static dict with no dependency injected. It
answers 200 with Postgres stopped while every `/api/v1/*` route 500s on `get_db`.

These tests assert the property (readiness reflects a dependency, liveness does not)
rather than restarting Postgres to prove it.
"""

from __future__ import annotations

import httpx
import pytest

from app.app import create_base_app
from app.core import health
from app.db.base import get_db

pytestmark = pytest.mark.asyncio


@pytest.fixture
def app(sessionmaker_):
    application = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    application.dependency_overrides[get_db] = _override_db
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def test_ready_reports_503_and_names_the_broken_dependency(app, monkeypatch):
    async def _broken() -> str:
        raise RuntimeError("connection refused")

    monkeypatch.setattr(health, "_check_database", _broken)
    async with _client(app) as c:
        r = await c.get("/ready")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "not_ready"
    assert body["checks"]["database"].startswith("error:")
    # It must name WHICH one — a 503 saying only "not ready" sends an operator
    # looking at three systems instead of one.
    assert "connection refused" in body["checks"]["database"]


async def test_one_broken_dependency_does_not_hide_the_others(app, monkeypatch):
    async def _broken() -> str:
        raise RuntimeError("down")

    async def _fine() -> str:
        return "ok"

    monkeypatch.setattr(health, "_check_database", _broken)
    monkeypatch.setattr(health, "_check_redis", _fine)
    monkeypatch.setattr(health, "_check_storage", _fine)
    async with _client(app) as c:
        body = (await c.get("/ready")).json()
    assert set(body["checks"]) == {"database", "redis", "storage"}
    assert body["checks"]["redis"] == "ok"


async def test_ready_is_200_when_everything_answers(app, monkeypatch):
    async def _fine() -> str:
        return "ok"

    for name in ("_check_database", "_check_redis", "_check_storage"):
        monkeypatch.setattr(health, name, _fine)
    async with _client(app) as c:
        r = await c.get("/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


async def test_health_is_liveness_and_says_nothing_about_dependencies(app, monkeypatch):
    """Not a defect — a deliberate split. This test exists so that nobody "fixes"
    /health by giving it a database check: an instance that is alive but not ready
    must still be distinguishable from one that is dead, or a restart loop and a
    dependency outage look identical to the orchestrator."""

    async def _broken() -> str:
        raise RuntimeError("down")

    monkeypatch.setattr(health, "_check_database", _broken)
    async with _client(app) as c:
        r = await c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_the_deployment_actually_probes_readiness():
    """The code was never the problem. This asserts the two deployment files that
    were: the gateway must route /ready, and core must have a healthcheck that uses
    it. Without this, /ready can silently become unreachable again — which is the
    state it was in.
    """
    import os
    import pathlib

    # run-tests.sh mounts gateway/ and deploy/ at VE_REPO_ROOT; locally they are
    # three levels up. Deliberately NOT a skip-if-absent: a test that quietly skips
    # itself is how this endpoint became unreachable in the first place.
    repo = pathlib.Path(os.environ.get("VE_REPO_ROOT") or pathlib.Path(__file__).resolve().parents[3])
    routes_path = repo / "gateway" / "dynamic" / "routes.yml"
    compose_path = repo / "deploy" / "docker-compose.yml"
    assert routes_path.is_file(), f"cannot read {routes_path} — check run-tests.sh mounts it"
    routes = routes_path.read_text()
    compose = compose_path.read_text()

    core_rule = next(
        line for line in routes.splitlines() if "rule:" in line and "/health" in line
    )
    assert "/ready" in core_rule, core_rule
    # /metrics is unauthenticated and nothing scrapes it; it must not be public.
    assert "/metrics" not in core_rule, core_rule
    assert "http://localhost:8000/ready" in compose, "core has no healthcheck on /ready"
