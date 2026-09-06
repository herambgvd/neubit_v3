"""Configuring an access system and using it are different jobs.

The service had two keys for 55 routes, so whoever could add a controller could
also open every door in the estate. access.manage now covers configuration only;
issuing credentials is access.credential and acting on hardware is access.command.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.access.models import Door, Instance

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()


async def _instance_and_door(session):
    inst = Instance(
        tenant_id=TENANT, brand="dds", name=f"c-{uuid.uuid4().hex[:6]}",
        base_url="https://ctrl.example", auth_type="basic", username="svc",
        verify_tls=True, is_active=True, status="unknown",
    )
    session.add(inst)
    await session.commit()
    await session.refresh(inst)
    door = Door(tenant_id=TENANT, instance_id=inst.id, name="Front", remote_ref="r1", is_active=True)
    session.add(door)
    await session.commit()
    await session.refresh(door)
    return inst.id, door.id


async def test_config_rights_alone_cannot_open_a_door(app, session):
    """The whole point of the split."""
    _iid, did = await _instance_and_door(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/doors/{did}/unlock",
            headers=auth(tenant_id=TENANT, permissions=["access.read", "access.manage"]),
        )
    assert r.status_code == 403, r.text


async def test_config_rights_alone_cannot_open_every_door(app, session):
    iid, _did = await _instance_and_door(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/commands/outputs/open_all_doors",
            headers=auth(tenant_id=TENANT, permissions=["access.read", "access.manage"]),
        )
    assert r.status_code == 403, r.text


async def test_config_rights_alone_cannot_issue_a_credential(app, session):
    iid, _did = await _instance_and_door(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT, permissions=["access.read", "access.manage"]),
            json={"name": "Someone"},
        )
    assert r.status_code == 403, r.text


async def test_the_command_right_gets_past_the_gate(app, session):
    """Past the PERMISSION gate — the controller is unreachable here, so anything
    other than 403 means the gate let it through. Without this the tests above
    would pass against a build that refuses everyone."""
    _iid, did = await _instance_and_door(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/doors/{did}/unlock",
            headers=auth(tenant_id=TENANT, permissions=["access.read", "access.command"]),
        )
    assert r.status_code != 403, r.text


async def test_the_credential_right_gets_past_the_gate(app, session):
    iid, _did = await _instance_and_door(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances/{iid}/cardholders",
            headers=auth(tenant_id=TENANT, permissions=["access.read", "access.credential"]),
            json={"name": "Someone"},
        )
    assert r.status_code != 403, r.text


async def test_command_rights_alone_cannot_reconfigure_the_controller(app, session):
    """The split has to cut both ways, or it is just a rename."""
    iid, _did = await _instance_and_door(session)
    async with _client(app) as c:
        r = await c.patch(
            f"{PREFIX}/access/instances/{iid}",
            headers=auth(tenant_id=TENANT, permissions=["access.read", "access.command"]),
            json={"base_url": "https://elsewhere.example"},
        )
    assert r.status_code == 403, r.text


def test_every_route_is_still_gated():
    """55 routes, four keys. A new route with no gate is the failure this catches."""
    from fastapi.routing import APIRoute

    from app.access.router import router

    ungated = []
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        names = set()

        def visit(dep):
            for sub in dep.dependencies:
                names.add(getattr(sub.call, "__qualname__", ""))
                visit(sub)

        visit(route.dependant)
        if not any("require_permission" in n for n in names):
            ungated.append(f"{sorted(route.methods)[0]} {route.path}")
    assert not ungated, "routes with no permission gate:\n" + "\n".join(ungated)


def test_the_actuation_keys_are_registered_in_cores_catalog():
    """A key access enforces but core cannot grant is a key no role can hold —
    core's own suite guards this too, but access should fail on its own."""
    import pathlib
    import re

    catalog = pathlib.Path("/src/core/app/auth/permissions.py")
    if not catalog.is_file():
        catalog = pathlib.Path(__file__).resolve().parents[3] / "core/app/auth/permissions.py"
    text = catalog.read_text()
    for key in ("access.read", "access.manage", "access.credential", "access.command"):
        assert f'"{key}"' in text, f"{key} is enforced here but not registered in core"
