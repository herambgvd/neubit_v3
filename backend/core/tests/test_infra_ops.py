"""Infrastructure control — the nine routes that can stop the platform.

Core does not touch the Docker socket; it forwards to a privileged ops-agent
sidecar. So this router is a proxy, and what matters is what it adds and what it
must not swallow:

  * every destructive action leaves an audit entry naming who and what;
  * a sidecar that is down is reported as the sidecar being down (503), not as core
    being broken (500) and not as the container being fine;
  * the agent's own refusal reaches the operator with its own status, so "no such
    container" does not arrive as a generic failure.

The agent is a recorder rather than a network call, since the suite has no network.
One test keeps the real client pointed at a closed port, because "unreachable
becomes 503" is a property of the real transport handling.
"""


import importlib

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select

from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.core.audit import AuditLog
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
INFRA = f"{PREFIX}/admin/infra"


class RecordingAgent:
    """Stands in for the ops-agent, recording what core asked it to do so the tests
    can assert the request core built, not just the answer it relayed."""

    calls: list[tuple] = []
    raises: HTTPException | None = None

    async def _record(self, *call):
        RecordingAgent.calls.append(call)
        if RecordingAgent.raises is not None:
            raise RecordingAgent.raises

    async def list_containers(self):
        await self._record("list_containers")
        return [{"name": "core", "state": "running", "cpu": 3.1, "health": "healthy"}]

    async def logs(self, name, tail=200):
        await self._record("logs", name, tail)
        return {"name": name, "lines": ["boot", "ready"]}

    async def restart(self, name):
        await self._record("restart", name)
        return {"ok": True, "name": name}

    async def stop(self, name):
        await self._record("stop", name)
        return {"ok": True, "name": name}

    async def start(self, name):
        await self._record("start", name)
        return {"ok": True, "name": name}

    async def scale(self, name, replicas):
        await self._record("scale", name, replicas)
        return {"ok": False, "reason": "no scalable worker services yet"}

    async def host(self):
        await self._record("host")
        return {"containers": 7, "running": 6, "cpu_percent": 11.5}

    async def db_export(self):
        await self._record("db_export")
        return b"-- neubit_control dump\nCREATE TABLE x();\n"

    async def db_import(self, sql):
        await self._record("db_import", len(sql))
        return {"ok": True, "restored": True}


@pytest.fixture(autouse=True)
def agent(monkeypatch):
    RecordingAgent.calls = []
    RecordingAgent.raises = None
    # The module, not the `app.infra.router` attribute: the package re-exports the
    # APIRouter under that name, so patching it succeeds silently while the handler
    # keeps calling the real client.
    module = importlib.import_module("app.infra.router")
    monkeypatch.setattr(module, "_agent", lambda: RecordingAgent())
    return RecordingAgent


@pytest_asyncio.fixture
async def world(db):
    sa_role = await make_role(db, "Platform", ["*"])
    t_role = await make_role(db, "TenantAdmin", ["*"])
    tenant = Tenant(name="Acme", slug="infra-acme", status="active", features={}, limits={})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    async def _user(email, tenant_id, role, superadmin=False):
        u = User(
            email=email, full_name=email.split("@")[0], role_id=role.id,
            password_hash=hash_password("Passw0rd!"), is_active=True,
            tenant_id=tenant_id, is_superadmin=superadmin,
        )
        db.add(u)
        await db.commit()
        await db.refresh(u)
        await db.refresh(u, attribute_names=["role"])
        return u

    return {
        "db": db,
        "sa": await _user("infra-sa@x.io", None, sa_role, superadmin=True),
        "tenant_admin": await _user("infra-ta@x.io", tenant.id, t_role),
    }


async def _audit_actions(db) -> list[str]:
    rows = (await db.execute(select(AuditLog))).scalars().all()
    return [r.action for r in rows]


# --- reads -------------------------------------------------------------------
async def test_the_container_list_reaches_the_operator_as_the_agent_reported_it(app, world):
    """The console's whole infrastructure page is this payload, so a router that
    re-shaped it would drop whichever field the agent adds next."""
    async with api_client(app) as c:
        r = await c.get(f"{INFRA}/containers", headers=bearer(world["sa"]))
    assert r.status_code == 200, r.text
    assert r.json() == [{"name": "core", "state": "running", "cpu": 3.1, "health": "healthy"}]
    assert RecordingAgent.calls == [("list_containers",)]


async def test_a_log_tail_is_passed_through_and_bounded(app, world):
    """`tail` goes straight to a docker logs call on the host, so unbounded it pulls
    an entire log file through core's event loop."""
    async with api_client(app) as c:
        ok = await c.get(
            f"{INFRA}/containers/core/logs", headers=bearer(world["sa"]), params={"tail": 500}
        )
        too_many = await c.get(
            f"{INFRA}/containers/core/logs", headers=bearer(world["sa"]), params={"tail": 500_000}
        )
        zero = await c.get(
            f"{INFRA}/containers/core/logs", headers=bearer(world["sa"]), params={"tail": 0}
        )
    assert ok.status_code == 200 and ok.json()["lines"] == ["boot", "ready"]
    assert ("logs", "core", 500) in RecordingAgent.calls
    assert too_many.status_code == 422
    assert zero.status_code == 422


async def test_reading_containers_and_the_host_is_not_written_to_the_audit_trail(app, world):
    """An audit trail that records every page view buries the one restart that
    matters, so reads are deliberately not audited.
    """
    async with api_client(app) as c:
        await c.get(f"{INFRA}/containers", headers=bearer(world["sa"]))
        await c.get(f"{INFRA}/host", headers=bearer(world["sa"]))
        await c.get(f"{INFRA}/containers/core/logs", headers=bearer(world["sa"]))
    assert await _audit_actions(world["db"]) == []


# --- destructive actions -----------------------------------------------------
@pytest.mark.parametrize(
    "verb,path,body,action",
    [
        ("POST", "/containers/core/restart", None, "infra.container.restart"),
        ("POST", "/containers/core/stop", None, "infra.container.stop"),
        ("POST", "/containers/core/start", None, "infra.container.start"),
        ("POST", "/services/worker/scale", {"replicas": 3}, "infra.service.scale"),
    ],
)
async def test_every_lifecycle_action_names_its_actor_in_the_audit_trail(
    app, world, verb, path, body, action
):
    """Why this router exists rather than a shell: a restart taken through core is
    attributable. An action that reaches the agent without an audit entry is, later,
    indistinguishable from one nobody took.
    """
    async with api_client(app) as c:
        r = await c.request(verb, f"{INFRA}{path}", headers=bearer(world["sa"]), json=body)
    assert r.status_code == 200, r.text

    rows = (await world["db"].execute(select(AuditLog))).scalars().all()
    (entry,) = [e for e in rows if e.action == action]
    assert entry.actor_email == "infra-sa@x.io"
    assert entry.target_id in ("core", "worker")


async def test_a_scale_request_carries_the_replica_count_the_operator_asked_for(app, world):
    """Scale is a recorded intent for now — the agent answers ok=false until real
    worker services exist — so the recorded number is all there is."""
    async with api_client(app) as c:
        r = await c.post(
            f"{INFRA}/services/worker/scale", headers=bearer(world["sa"]), json={"replicas": 4}
        )
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert ("scale", "worker", 4) in RecordingAgent.calls

    rows = (await world["db"].execute(select(AuditLog))).scalars().all()
    (entry,) = [e for e in rows if e.action == "infra.service.scale"]
    assert entry.meta == {"replicas": 4}


# --- database backup / restore ----------------------------------------------
async def test_a_database_export_comes_back_as_a_downloadable_sql_file(app, world):
    """The operator's backup, returned as a named attachment rather than JSON: a
    browser that renders a control-plane dump into a tab is showing credentials."""
    async with api_client(app) as c:
        r = await c.get(f"{INFRA}/db/export", headers=bearer(world["sa"]))
    assert r.status_code == 200
    assert r.content.startswith(b"-- neubit_control dump")
    assert r.headers["content-type"].startswith("application/sql")
    assert "attachment" in r.headers["content-disposition"]
    assert "neubit_control.sql" in r.headers["content-disposition"]
    assert "infra.db.export" in await _audit_actions(world["db"])


async def test_a_database_restore_records_that_it_happened(app, world):
    """The most destructive call on the platform: it drops and rebuilds the control
    database, including the audit table this entry lands in. The handler must release
    its own transaction before handing off, or the restore waits on the request that
    asked for it, and then write the entry onto the rebuilt schema.
    """
    async with api_client(app) as c:
        r = await c.post(
            f"{INFRA}/db/import",
            headers=bearer(world["sa"]),
            files={"file": ("dump.sql", b"CREATE TABLE y();", "application/sql")},
        )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "restored": True}
    assert ("db_import", len(b"CREATE TABLE y();")) in RecordingAgent.calls
    assert "infra.db.import" in await _audit_actions(world["db"])


# --- when the sidecar misbehaves ---------------------------------------------
async def test_the_agents_own_refusal_reaches_the_operator_with_its_own_status(app, world):
    """"No such container" is a 404 the operator can act on; flattening it to a 500
    turns a typo into an incident."""
    RecordingAgent.raises = HTTPException(status_code=404, detail="no such container: typo")
    async with api_client(app) as c:
        r = await c.post(f"{INFRA}/containers/typo/restart", headers=bearer(world["sa"]))
    assert r.status_code == 404
    assert "typo" in r.text
    # And nothing that did not happen was written down.
    assert await _audit_actions(world["db"]) == []


async def test_an_unreachable_sidecar_is_reported_as_the_sidecar_being_down(app, world, monkeypatch):
    """503, not 500 — one says the infrastructure control plane is unavailable, the
    other says core is broken, and core answering at all proves it is not.

    The real client is used here because the recorder cannot produce a transport
    failure.
    """
    from app.infra.client import OpsAgentClient

    module = importlib.import_module("app.infra.router")
    monkeypatch.setenv("OPS_AGENT_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(module, "_agent", lambda: OpsAgentClient(timeout=2.0))

    async with api_client(app) as c:
        r = await c.get(f"{INFRA}/containers", headers=bearer(world["sa"]))
    assert r.status_code == 503, r.text
    assert "ops-agent" in r.text


# --- who may ask -------------------------------------------------------------
async def test_a_tenant_admin_cannot_reach_the_agent_at_all(app, world):
    """Stated for the whole /admin table in test_admin_realm_boundary.py, repeated
    here because of what is behind this route: the refusal has to happen in core,
    before the forward. A 403 after the container restarted is not a refusal."""
    async with api_client(app) as c:
        r = await c.post(f"{INFRA}/containers/core/stop", headers=bearer(world["tenant_admin"]))
    assert r.status_code == 403
    assert RecordingAgent.calls == [], "core forwarded to the agent before refusing"
