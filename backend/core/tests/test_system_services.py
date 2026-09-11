"""GET /system/services and its log tail — the estate view behind the Health page.

The page used to show three dependency probes and the host's CPU/RAM, which
answers "can core reach its database", not "which services are running and what
are they saying". These two routes answer the second question by forwarding to
the ops-agent (the only component holding the docker socket).

What is worth pinning:
  * LOGS ARE A SEPARATE GRANT. system.read shows that a service is up;
    system.logs reads what it prints. A log line carries request paths,
    identifiers and whatever a stack trace picked up.
  * THE ROW IS A PROJECTION, not the agent's payload — the image tag and
    container id would put the deployed image on a screen system.read opens.
  * A container with NO healthcheck is not unhealthy.
"""


import pytest

from conftest import api_client, bearer, make_role, make_user

pytestmark = pytest.mark.asyncio

PREFIX = "/api/v1"

AGENT_ROWS = [
    {
        "name": "neubit-v3-core-1", "id": "abc123", "image": "neubit-v3-core:latest",
        "state": "running", "status": "running", "health": "healthy",
        "created_at": "2026-01-01T00:00:00Z", "service": "core",
        "cpu_pct": 3.5, "mem_used_mb": 210.0, "mem_limit_mb": 2048.0,
    },
    {
        "name": "neubit-v3-nats-1", "id": "def456", "image": "nats:2",
        "state": "running", "status": "running", "health": None,
        "created_at": "2026-01-01T00:00:00Z", "service": "nats",
        "cpu_pct": 0.4, "mem_used_mb": 30.0, "mem_limit_mb": 512.0,
    },
    {
        "name": "neubit-v3-vision-1", "id": "ghi789", "image": "neubit-v3-vision:latest",
        "state": "exited", "status": "exited", "health": None,
        "created_at": "2026-01-01T00:00:00Z", "service": "vision",
        "cpu_pct": None, "mem_used_mb": None, "mem_limit_mb": None,
    },
    {
        "name": "neubit-v3-db-init-1", "id": "jkl000", "image": "x",
        "state": "exited", "status": "exited", "health": None,
        "created_at": "2026-01-01T00:00:00Z", "service": "db-init",
        "cpu_pct": None, "mem_used_mb": None, "mem_limit_mb": None,
    },
]


@pytest.fixture
def agent(monkeypatch):
    """Stand in for the ops-agent. Records what core asked it for."""
    from app.infra import client as client_mod

    calls: list[tuple] = []

    class FakeAgent:
        async def list_containers(self):
            calls.append(("list",))
            return AGENT_ROWS

        async def logs(self, name, tail=200, since=0):
            calls.append(("logs", name, tail, since))
            return {"lines": ["2026-01-01T00:00:01Z hello"]}

    monkeypatch.setattr(client_mod, "OpsAgentClient", FakeAgent)
    return calls


async def _user_with(db, perms: list[str], email: str):
    role = await make_role(db, f"Role-{email}", perms)
    return await make_user(db, email, role)


async def test_the_estate_is_listed_for_system_read(app, db, agent):
    user = await _user_with(db, ["system.read"], "ops@x.io")
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}/system/services", headers=bearer(user))
    assert r.status_code == 200, r.text
    rows = r.json()
    names = [row["name"] for row in rows]
    # db-init is a one-shot migration, not a service anyone watches.
    assert "db-init" not in names
    # Trouble first: the exited service is at the top.
    assert names[0] == "vision"
    core = next(row for row in rows if row["name"] == "core")
    assert core["running"] is True and core["health"] == "healthy"
    assert core["container"] == "neubit-v3-core-1"
    assert core["cpu_pct"] == 3.5


async def test_a_service_without_a_healthcheck_is_not_reported_unhealthy(app, db, agent):
    user = await _user_with(db, ["system.read"], "ops2@x.io")
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}/system/services", headers=bearer(user))
    nats = next(row for row in r.json() if row["name"] == "nats")
    assert nats["health"] is None
    assert nats["running"] is True


async def test_the_row_does_not_carry_the_image_or_container_id(app, db, agent):
    """A projection, not a pass-through — system.read is not a deployment read."""
    user = await _user_with(db, ["system.read"], "ops3@x.io")
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}/system/services", headers=bearer(user))
    for row in r.json():
        assert "image" not in row
        assert "id" not in row


async def test_logs_need_system_logs_not_system_read(app, db, agent):
    watcher = await _user_with(db, ["system.read"], "watch@x.io")
    reader = await _user_with(db, ["system.read", "system.logs"], "read@x.io")
    async with api_client(app) as c:
        r = await c.get(
            f"{PREFIX}/system/services/neubit-v3-core-1/logs", headers=bearer(watcher)
        )
        assert r.status_code == 403
        r = await c.get(
            f"{PREFIX}/system/services/neubit-v3-core-1/logs", headers=bearer(reader)
        )
    assert r.status_code == 200
    assert r.json()["lines"] == ["2026-01-01T00:00:01Z hello"]


async def test_since_is_forwarded_so_a_follow_costs_only_new_lines(app, db, agent):
    reader = await _user_with(db, ["system.logs"], "read2@x.io")
    async with api_client(app) as c:
        r = await c.get(
            f"{PREFIX}/system/services/neubit-v3-core-1/logs",
            params={"tail": 50, "since": 1750000000},
            headers=bearer(reader),
        )
    assert r.status_code == 200
    assert ("logs", "neubit-v3-core-1", 50, 1750000000) in agent


async def test_the_tail_is_clamped(app, db, agent):
    reader = await _user_with(db, ["system.logs"], "read3@x.io")
    async with api_client(app) as c:
        r = await c.get(
            f"{PREFIX}/system/services/neubit-v3-core-1/logs",
            params={"tail": 999999}, headers=bearer(reader),
        )
    assert r.status_code == 422


async def test_an_unreachable_agent_is_a_503_not_an_empty_estate(app, db, monkeypatch):
    """An empty list would render as "nothing is running", which is the one
    reading a health page must never invent."""
    from fastapi import HTTPException

    from app.infra import client as client_mod

    class DeadAgent:
        async def list_containers(self):
            raise HTTPException(status_code=503, detail="ops-agent unreachable")

    monkeypatch.setattr(client_mod, "OpsAgentClient", DeadAgent)
    user = await _user_with(db, ["system.read"], "ops4@x.io")
    async with api_client(app) as c:
        r = await c.get(f"{PREFIX}/system/services", headers=bearer(user))
    assert r.status_code == 503
