"""A NULL tenant_id is a PLATFORM row, not a row owned by everyone.

kernel.auth.owns() still defaults to "NULL is readable by all" — the behaviour
core proved was a privilege escalation (a tenant-admin fetching the super-admin by
id). scoped() excludes NULL rows from a listing while owns() admitted them by id,
and here every by-id path is also the write / re-credential / send-command path.

Access passes allow_shared=False at every assert_owned site. These tests pin that:
a platform-scoped controller instance is invisible AND untouchable to a tenant,
and a super-admin still reaches it (so the fix is not "refuse everyone").
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.access.models import Instance

pytestmark = pytest.mark.asyncio

PERMS = ["access.read", "access.manage"]
TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


async def _mk_instance(session, tenant_id) -> str:
    row = Instance(
        tenant_id=tenant_id,
        brand="dds",
        name=f"ctrl-{uuid.uuid4().hex[:8]}",
        base_url="https://controller.example",
        auth_type="basic",
        username="svc",
        secret_enc=None,
        verify_tls=False,
        is_active=True,
        status="unknown",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row.id


async def test_a_platform_instance_is_404_to_a_tenant_by_id(app, session):
    iid = await _mk_instance(session, None)  # NULL tenant = platform row
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/access/instances/{iid}", headers=auth(tenant_id=TENANT_A, permissions=PERMS))
    assert r.status_code == 404, r.text


async def test_a_platform_instance_is_not_in_a_tenants_list(app, session):
    iid = await _mk_instance(session, None)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/access/instances", headers=auth(tenant_id=TENANT_A, permissions=PERMS))
    assert r.status_code == 200, r.text
    assert iid not in r.text, "a platform instance leaked into a tenant's listing"


async def test_a_tenant_cannot_recredential_a_platform_instance(app, session):
    """The bite: PATCH is the re-credential path. A 404 alone is not enough — the
    row is re-read to prove the write did not land before the guard."""
    iid = await _mk_instance(session, None)
    async with _client(app) as c:
        r = await c.patch(
            f"{PREFIX}/access/instances/{iid}",
            headers=auth(tenant_id=TENANT_A, permissions=PERMS),
            json={"base_url": "https://attacker.example"},
        )
    assert r.status_code == 404, r.text
    fresh = await session.get(Instance, iid)
    assert fresh.base_url == "https://controller.example"


async def test_a_tenant_cannot_command_a_platform_instance(app, session):
    """A door-open / output-activate command must not reach another tenant's — or
    the platform's — physical controller."""
    iid = await _mk_instance(session, None)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/open_all_doors",
            headers=auth(tenant_id=TENANT_A, permissions=PERMS),
        )
    assert r.status_code == 404, r.text


async def test_one_tenant_cannot_reach_anothers_instance(app, session):
    iid = await _mk_instance(session, TENANT_B)
    async with _client(app) as c:
        got = await c.get(f"{PREFIX}/access/instances/{iid}", headers=auth(tenant_id=TENANT_A, permissions=PERMS))
        patched = await c.patch(
            f"{PREFIX}/access/instances/{iid}",
            headers=auth(tenant_id=TENANT_A, permissions=PERMS),
            json={"base_url": "https://attacker.example"},
        )
    assert got.status_code == 404, got.text
    assert patched.status_code == 404, patched.text


async def test_a_super_admin_still_reaches_a_platform_instance(app, session):
    """Without this, every assertion above would pass against a build that refuses
    everyone — which is an outage, not isolation."""
    iid = await _mk_instance(session, None)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/access/instances/{iid}", headers=auth(tenant_id=None, is_superadmin=True))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == iid


async def test_the_owning_tenant_reaches_its_own_instance(app, session):
    iid = await _mk_instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/access/instances/{iid}", headers=auth(tenant_id=TENANT_A, permissions=PERMS))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == iid
