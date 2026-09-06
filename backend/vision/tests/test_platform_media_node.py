"""A platform media node is not a tenant's to edit.

`kernel.auth.owns()` treats a NULL `tenant_id` as belonging to nobody and
therefore readable by all — right for a shared record a tenant may USE, wrong for
the paths that change it. `MediaNodeService._row` used it without
`allow_shared=False`, and SEVEN call sites go through that helper, including
`update`, `enroll_credential` and `revoke_credential`.

This is not hypothetical. The one media node on this deployment has
`tenant_id NULL`: it is the standalone NVR recorder, and the row carries the
credential the VMS authenticates to it with.

    media_nodes: 1 row, tenant_id = NULL
      name "NVR recorder-dev-01", host "nvr", api_url "http://nvr:8000"

`MediaNodeUpdate` accepts `host` and `api_url`. So a tenant holding
`vms.config.manage`, naming that node's id, could repoint the recorder connection
at an address of their choosing, or mint themselves a credential on it.

The split is per call site, not a blanket refusal: reading a shared node is how a
tenant's cameras find the recorder in the first place.
"""

from __future__ import annotations

import uuid

import pytest

from .conftest import PREFIX, auth, client

TENANT = uuid.uuid4()
MANAGE = ["vms.config.manage"]


async def _platform_node(sessionmaker) -> str:
    """A media node owned by nobody — what the standalone recorder looks like."""
    from app.vms.models.media_node import MediaNode

    async with sessionmaker() as s:
        row = MediaNode(
            tenant_id=None,
            name="NVR recorder-platform",
            host="nvr",
            api_url="http://nvr:8000",
            capacity_channels=128,
            used_channels=0,
            status="offline",
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)
        return str(row.id)


async def test_a_tenant_may_read_a_platform_node(app, http_sessionmaker):
    """The deliberate half — a tenant's cameras are assigned to it."""
    node_id = await _platform_node(http_sessionmaker)
    async with client(app) as c:
        r = await c.get(
            f"{PREFIX}/vms/media-nodes/{node_id}",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
        )
    assert r.status_code == 200, r.text


async def test_a_tenant_cannot_repoint_a_platform_node(app, http_sessionmaker):
    """The half that was not. `api_url` is where the VMS sends stream control."""
    node_id = await _platform_node(http_sessionmaker)
    async with client(app) as c:
        r = await c.patch(
            f"{PREFIX}/vms/media-nodes/{node_id}",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"api_url": "http://attacker.example:8000"},
        )
    assert r.status_code == 404, r.text


async def test_a_tenant_cannot_mint_a_credential_on_a_platform_node(
    app, http_sessionmaker
):
    """`enroll_credential` is the bootstrap for an independently deployed recorder.
    Minting one on somebody else's node is minting access to that recorder."""
    node_id = await _platform_node(http_sessionmaker)
    async with client(app) as c:
        r = await c.post(
            f"{PREFIX}/vms/media-nodes/{node_id}/enroll",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
        )
    assert r.status_code == 404, r.text


async def test_a_tenants_own_node_is_still_editable(app, http_sessionmaker):
    """Refusing the shared one must not refuse the tenant's own — that would be a
    different bug."""
    async with client(app) as c:
        made = await c.post(
            f"{PREFIX}/vms/media-nodes",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"name": f"node-{uuid.uuid4().hex[:6]}", "host": "10.0.0.9",
                  "api_url": "http://10.0.0.9:8000", "capacity_channels": 8},
        )
        assert made.status_code in (200, 201), made.text
        node_id = made.json()["id"]
        patched = await c.patch(
            f"{PREFIX}/vms/media-nodes/{node_id}",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"label": "floor 3"},
        )
    assert patched.status_code == 200, patched.text
