"""Infrastructure control — the nine routes that can stop the platform.

Core does not touch the Docker socket; it forwards to a privileged ops-agent
sidecar on the internal network. So the router is a proxy, and the things worth
testing about a proxy are the things it adds and the things it must not swallow:

  * every destructive action leaves an audit entry naming WHO and WHAT, because
    "the platform went down at 14:02" is only answerable afterwards if the restart
    that did it was written down at the time;
  * a sidecar that is down is reported as a sidecar being down (503), not as core
    being broken (500) and not as the container being fine;
  * the agent's own refusal reaches the operator with its own status, so "no such
    container" does not arrive as a generic failure.

The agent is replaced with a recorder rather than reached over the network — the
suite runs with no network at all, and the point here is core's half of the
exchange. One test deliberately keeps the real client, pointed at a closed port,
because "unreachable becomes 503" is a property of the real transport handling.
"""

from __future__ import annotations

import importlib

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select

from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.core.audit import AuditLog
from app.db.base import get_db
from app.tenancy.models import Tenant
from conftest import make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
INFRA = f"{PREFIX}/admin/infra"


class RecordingAgent:
    """Stands in for the ops-agent. Records what core asked it to do, so the tests
    can assert the request core BUILT, not just the answer it relayed."""

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
    # The MODULE, not `app.infra.router` the attribute — the package re-exports the
    # APIRouter object under that name, and patching an attribute onto it would
    # succeed silently while the handler kept calling the real client.
    module = importlib.import_module("app.infra.router")
    monkeypatch.setattr(module, "_agent", lambda: RecordingAgent())
    return RecordingAgent


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


def _auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user, sid='test')}"}


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
    """The console's whole infrastructure page is this payload. A router that
    re-shaped it would silently drop whichever field the agent adds next."""
    async with _client(app) as c:
        r = await c.get(f"{INFRA}/containers", headers=_auth(world["sa"]))
    assert r.status_code == 200, r.text
    assert r.json() == [{"name": "core", "state": "running", "cpu": 3.1, "health": "healthy"}]
    assert RecordingAgent.calls == [("list_containers",)]


async def test_a_log_tail_is_passed_through_and_bounded(app, world):
    """`tail` goes straight to a docker logs call on the host. Unbounded, one
    request pulls an entire log file through core's event loop; the cap is the only
    thing standing between a curious operator and a stalled control plane."""
    async with _client(app) as c:
        ok = await c.get(
            f"{INFRA}/containers/core/logs", headers=_auth(world["sa"]), params={"tail": 500}
        )
        too_many = await c.get(
            f"{INFRA}/containers/core/logs", headers=_auth(world["sa"]), params={"tail": 500_000}
        )
        zero = await c.get(
            f"{INFRA}/containers/core/logs", headers=_auth(world["sa"]), params={"tail": 0}
        )
    assert ok.status_code == 200 and ok.json()["lines"] == ["boot", "ready"]
    assert ("logs", "core", 500) in RecordingAgent.calls
    assert too_many.status_code == 422
    assert zero.status_code == 422


async def test_reading_containers_and_the_host_is_not_written_to_the_audit_trail(app, world):
    """An audit trail that records every page view buries the one restart that
    matters. Reads are deliberately not audited; the destructive actions below are.
    """
    async with _client(app) as c:
        await c.get(f"{INFRA}/containers", headers=_auth(world["sa"]))
        await c.get(f"{INFRA}/host", headers=_auth(world["sa"]))
        await c.get(f"{INFRA}/containers/core/logs", headers=_auth(world["sa"]))
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
    """The reason this router exists at all rather than handing operators a shell:
    a restart taken through core is attributable. An action that reaches the agent
    without an audit entry is indistinguishable, afterwards, from one nobody took.
    """
    async with _client(app) as c:
        r = await c.request(verb, f"{INFRA}{path}", headers=_auth(world["sa"]), json=body)
    assert r.status_code == 200, r.text

    rows = (await world["db"].execute(select(AuditLog))).scalars().all()
    (entry,) = [e for e in rows if e.action == action]
    assert entry.actor_email == "infra-sa@x.io"
    assert entry.target_id in ("core", "worker")


async def test_a_scale_request_carries_the_replica_count_the_operator_asked_for(app, world):
    """Scale is currently a recorded intent — the agent answers ok=false until real
    worker services exist. That makes the recorded number the only thing there is,
    so it has to be the number that was typed."""
    async with _client(app) as c:
        r = await c.post(
            f"{INFRA}/services/worker/scale", headers=_auth(world["sa"]), json={"replicas": 4}
        )
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert ("scale", "worker", 4) in RecordingAgent.calls

    rows = (await world["db"].execute(select(AuditLog))).scalars().all()
    (entry,) = [e for e in rows if e.action == "infra.service.scale"]
    assert entry.meta == {"replicas": 4}


# --- database backup / restore ----------------------------------------------
async def test_a_database_export_comes_back_as_a_downloadable_sql_file(app, world):
    """This is the operator's backup. Returned as an attachment with a filename,
    not as JSON: a browser that renders a control-plane dump into a tab instead of
    saving it has produced a very large screenful of credentials."""
    async with _client(app) as c:
        r = await c.get(f"{INFRA}/db/export", headers=_auth(world["sa"]))
    assert r.status_code == 200
    assert r.content.startswith(b"-- neubit_control dump")
    assert r.headers["content-type"].startswith("application/sql")
    assert "attachment" in r.headers["content-disposition"]
    assert "neubit_control.sql" in r.headers["content-disposition"]
    assert "infra.db.export" in await _audit_actions(world["db"])


async def test_a_database_restore_records_that_it_happened(app, world):
    """The single most destructive call on the platform: it drops and rebuilds the
    control database, including the audit table this entry lands in. The handler
    has to release its own transaction before handing off — otherwise the restore
    waits on the very request that asked for it — and then write the entry back
    onto the rebuilt schema.
    """
    async with _client(app) as c:
        r = await c.post(
            f"{INFRA}/db/import",
            headers=_auth(world["sa"]),
            files={"file": ("dump.sql", b"CREATE TABLE y();", "application/sql")},
        )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "restored": True}
    assert ("db_import", len(b"CREATE TABLE y();")) in RecordingAgent.calls
    assert "infra.db.import" in await _audit_actions(world["db"])


# --- when the sidecar misbehaves ---------------------------------------------
async def test_the_agents_own_refusal_reaches_the_operator_with_its_own_status(app, world):
    """"No such container" is a 404 the operator can act on. Flattening it to a 500
    turns a typo into an incident."""
    RecordingAgent.raises = HTTPException(status_code=404, detail="no such container: typo")
    async with _client(app) as c:
        r = await c.post(f"{INFRA}/containers/typo/restart", headers=_auth(world["sa"]))
    assert r.status_code == 404
    assert "typo" in r.text
    # And nothing that did not happen was written down.
    assert await _audit_actions(world["db"]) == []


async def test_an_unreachable_sidecar_is_reported_as_the_sidecar_being_down(app, world, monkeypatch):
    """503, not 500. The distinction is the whole on-call triage: one says the
    infrastructure control plane is unavailable, the other says core is broken —
    and core answering this request at all proves it is not.

    The real client is used here on purpose; the recorder above cannot produce a
    transport failure.
    """
    from app.infra.client import OpsAgentClient

    module = importlib.import_module("app.infra.router")
    monkeypatch.setenv("OPS_AGENT_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(module, "_agent", lambda: OpsAgentClient(timeout=2.0))

    async with _client(app) as c:
        r = await c.get(f"{INFRA}/containers", headers=_auth(world["sa"]))
    assert r.status_code == 503, r.text
    assert "ops-agent" in r.text


# --- who may ask -------------------------------------------------------------
async def test_a_tenant_admin_cannot_reach_the_agent_at_all(app, world):
    """Stated for the whole /admin table in test_admin_realm_boundary.py; repeated
    here for one route because of what is behind it. The refusal must happen in
    core, BEFORE the forward — a 403 produced after the container was already
    restarted is not a refusal."""
    async with _client(app) as c:
        r = await c.post(f"{INFRA}/containers/core/stop", headers=_auth(world["tenant_admin"]))
    assert r.status_code == 403
    assert RecordingAgent.calls == [], "core forwarded to the agent before refusing"
