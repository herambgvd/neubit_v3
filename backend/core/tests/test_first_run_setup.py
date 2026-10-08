"""First-run setup: the administrator a fresh deployment is created with.

Two properties, both about WHO ends up owning a fresh system:

* The account POST /auth/setup creates is the platform super-admin, the same
  first account VE_BOOTSTRAP_ADMIN_* produces. A first admin that is merely
  tenant-less but not super could not reach the platform pages it just installed.
* With `setup_local_only` (the native Windows appliance) setup is refused from
  anywhere but the server itself. The appliance answers on the LAN before anyone
  has set it up, and the endpoint is public by necessity; without the gate,
  whoever reaches it first owns the system.
"""

import httpx
import pytest
from sqlalchemy import select

from app.auth.models import User
from app.core import config

from conftest import api_client

pytestmark = pytest.mark.asyncio

ADMIN = {"email": "ops@company.com", "password": "Str0ngPassw0rd", "full_name": "Ops"}
GATEWAY = "127.0.0.1"


def _client_as(app, peer: str, xff: str | None = None) -> httpx.AsyncClient:
    """A client whose socket peer is `peer` (the gateway, natively) and whose
    request carries the X-Forwarded-For the gateway would add."""
    headers = {"x-forwarded-for": xff} if xff else {}
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(peer, 50000)),
        base_url="http://t",
        headers=headers,
    )


@pytest.fixture
def local_only(monkeypatch):
    """The native appliance's settings: setup local-only, Traefik on loopback trusted."""
    monkeypatch.setenv("VE_SETUP_LOCAL_ONLY", "true")
    monkeypatch.setenv("VE_TRUSTED_PROXY_CIDRS", f'["{GATEWAY}/32"]')
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


async def _users(db) -> list[User]:
    return list((await db.execute(select(User))).scalars())


async def test_the_first_administrator_is_the_platform_super_admin(app, db):
    async with api_client(app) as c:
        r = await c.post("/api/v1/auth/setup", json=ADMIN)
    assert r.status_code == 201, r.text
    [admin] = await _users(db)
    assert admin.is_superadmin
    assert admin.tenant_id is None


async def test_setup_is_open_from_anywhere_by_default(app):
    """Docker deployments keep today's behaviour: the flag is off unless set."""
    async with _client_as(app, "203.0.113.9") as c:
        status = (await c.get("/api/v1/auth/setup-status")).json()
    assert status == {"needs_setup": True, "setup_here": True}


async def test_a_lan_browser_is_told_and_refused(app, db, local_only):
    async with _client_as(app, GATEWAY, xff="192.168.1.50") as c:
        status = (await c.get("/api/v1/auth/setup-status")).json()
        r = await c.post("/api/v1/auth/setup", json=ADMIN)
    assert status == {"needs_setup": True, "setup_here": False}
    assert r.status_code == 403
    assert await _users(db) == []


async def test_the_server_itself_can_set_up(app, db, local_only):
    async with _client_as(app, GATEWAY, xff="127.0.0.1") as c:
        status = (await c.get("/api/v1/auth/setup-status")).json()
        r = await c.post("/api/v1/auth/setup", json=ADMIN)
    assert status["setup_here"] is True
    assert r.status_code == 201, r.text
    assert len(await _users(db)) == 1


async def test_a_forged_loopback_hop_does_not_pass_for_local(app, db, local_only):
    """A LAN caller sends X-Forwarded-For: 127.0.0.1 and the gateway appends the
    address it really saw; the rightmost untrusted hop is the one believed."""
    async with _client_as(app, GATEWAY, xff="127.0.0.1, 192.168.1.50") as c:
        r = await c.post("/api/v1/auth/setup", json=ADMIN)
    assert r.status_code == 403
    assert await _users(db) == []
