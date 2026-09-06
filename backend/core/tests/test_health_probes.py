"""Liveness and readiness answer different questions, and readiness must be able to fail.

`/health` is a static dict and answers 200 with Postgres stopped; `/ready` reflects
its dependencies. Both halves are asserted, plus that the deployment actually routes
and probes `/ready` — written correctly and consumed by nothing is the failure this
file watches for.
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
    # It must name which one: a 503 saying only "not ready" sends an operator
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
    """Do not "fix" /health by giving it a database check. Alive-but-not-ready has to
    stay distinguishable from dead, or a restart loop and a dependency outage look
    the same to the orchestrator."""

    async def _broken() -> str:
        raise RuntimeError("down")

    monkeypatch.setattr(health, "_check_database", _broken)
    async with _client(app) as c:
        r = await c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_the_deployment_actually_probes_readiness():
    """The two deployment files: the gateway must route /ready and core must have a
    healthcheck that uses it, or the endpoint is silently unreachable.
    """
    import os
    import pathlib

    # run-tests.sh mounts gateway/ and deploy/ at VE_REPO_ROOT; locally they are
    # three levels up. Deliberately not skip-if-absent — a test that quietly skips
    # itself is how this endpoint became unreachable.
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
