"""Liveness and readiness answer different questions, and readiness must be able to fail.

`/health` is a static dict and answers 200 with Postgres stopped; `/readyz` reflects
its dependencies. Both halves are asserted, plus that the deployment actually routes
and probes `/readyz` — written correctly and consumed by nothing is the failure this
file watches for.
"""


import pytest

from app.core import health
from conftest import api_client

pytestmark = pytest.mark.asyncio


async def test_ready_reports_503_and_names_the_broken_dependency(app, monkeypatch):
    async def _broken() -> str:
        raise RuntimeError("connection refused")

    monkeypatch.setattr(health, "_check_database", _broken)
    async with api_client(app) as c:
        r = await c.get("/readyz")
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
    async with api_client(app) as c:
        body = (await c.get("/readyz")).json()
    assert set(body["checks"]) == {"database", "redis", "storage"}
    assert body["checks"]["redis"] == "ok"


async def test_ready_is_200_when_everything_answers(app, monkeypatch):
    async def _fine() -> str:
        return "ok"

    for name in ("_check_database", "_check_redis", "_check_storage"):
        monkeypatch.setattr(health, name, _fine)
    async with api_client(app) as c:
        r = await c.get("/readyz")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


@pytest.mark.parametrize(
    ("backend", "url"),
    [("memory", "redis://localhost:6379/0"), ("redis", ""), ("memory", "")],
)
async def test_redis_is_not_a_dependency_when_nothing_uses_it(monkeypatch, backend, url):
    """The native Windows appliance runs without Redis: core's one Redis client is
    the rate limiter, and it uses the per-process window there. Probing Redis anyway
    would hold the console at 503 forever."""
    settings = health.get_settings()
    monkeypatch.setattr(settings, "rate_limit_backend", backend)
    monkeypatch.setattr(settings, "redis_url", url)
    assert health.redis_in_use() is False
    assert await health._check_redis() == "not used"


async def test_redis_is_probed_when_the_limiter_uses_it(monkeypatch):
    settings = health.get_settings()
    monkeypatch.setattr(settings, "rate_limit_backend", "redis")
    monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
    assert health.redis_in_use() is True


async def test_health_is_liveness_and_says_nothing_about_dependencies(app, monkeypatch):
    """Do not "fix" /health by giving it a database check. Alive-but-not-ready has to
    stay distinguishable from dead, or a restart loop and a dependency outage look
    the same to the orchestrator."""

    async def _broken() -> str:
        raise RuntimeError("down")

    monkeypatch.setattr(health, "_check_database", _broken)
    async with api_client(app) as c:
        r = await c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_the_deployment_actually_probes_readiness():
    """The two deployment files: the gateway must route /readyz and core must have a
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
    assert "/readyz" in core_rule, core_rule
    # /metrics is unauthenticated and nothing scrapes it; it must not be public.
    assert "/metrics" not in core_rule, core_rule
    assert "http://localhost:8000/readyz" in compose, "core has no healthcheck on /ready"
