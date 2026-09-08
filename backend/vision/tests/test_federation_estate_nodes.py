"""GET /vms/federation/nodes — what the Federation screen is built from.

The row this returns is the ONLY description of an enrolled recorder the console
gets, and two of its fields exist because of failures that are otherwise
invisible:

  * `credential_error` — a federation credential freezes the grants it was minted
    with, so widening the recorder's grant set leaves an existing credential
    short. The node stays reachable and keeps reporting online the whole time,
    and the only symptom is one screen somewhere returning an error. The
    heartbeat writes the reason here; before this it was written and never read.
  * the media bases — a node can answer its API and still play nothing because
    `hls_base` was never filled in at onboarding.

And one field that must never appear: the credential itself.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

from app.vms.models import MediaNode

from .conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()

NODE_ID = "22222222-2222-2222-2222-222222222222"
OTHER_ID = "33333333-3333-3333-3333-333333333333"

URL = f"{PREFIX}/vms/federation/nodes"


@pytest_asyncio.fixture
async def nodes(http_sessionmaker):
    async with http_sessionmaker() as s:
        s.add(
            MediaNode(
                id=NODE_ID,
                tenant_id=TENANT_A,
                name="north-recorder",
                host="north.local",
                api_url="http://north:8000",
                hls_base="http://north:8888",
                webrtc_base="http://north:8889",
                rtsp_base="rtsp://north:8554",
                label="Tower B basement",
                credential="scoped-key-value",
                credential_error="403 from recorder: missing grant storage:read",
                capacity_channels=64,
                used_channels=12,
                status="online",
            )
        )
        # A node with no per-node credential — it falls back to the service JWT.
        s.add(
            MediaNode(
                id=OTHER_ID,
                tenant_id=TENANT_A,
                name="south-recorder",
                host="south.local",
                api_url="http://south:8000",
                status="offline",
            )
        )
        await s.commit()


async def test_the_row_carries_what_the_console_shows(app, nodes):
    async with client(app) as c:
        r = await c.get(URL, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert r.status_code == 200, r.text
    by_name = {n["name"]: n for n in r.json()["items"]}
    north = by_name["north-recorder"]
    assert north["api_url"] == "http://north:8000"
    # The media bases: reachable on the API and still unplayable is a real state,
    # and the console warns on it.
    assert north["hls_base"] == "http://north:8888"
    assert north["webrtc_base"] == "http://north:8889"
    # Nothing reads these two, so they are not sent. A field with no consumer is
    # a field that drifts.
    assert "host" not in north
    assert "rtsp_base" not in north
    assert north["capacity_channels"] == 64 and north["used_channels"] == 12
    assert north["enrolled_at"]


async def test_a_short_credential_is_reported_not_swallowed(app, nodes):
    """The node is online and reachable; only this says a screen is broken."""
    async with client(app) as c:
        r = await c.get(URL, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    north = next(n for n in r.json()["items"] if n["name"] == "north-recorder")
    assert north["status"] == "online"
    assert "missing grant storage:read" in north["credential_error"]


async def test_whether_there_is_a_credential_is_reported_but_never_its_value(app, nodes):
    async with client(app) as c:
        r = await c.get(URL, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    body = r.text
    by_name = {n["name"]: n for n in r.json()["items"]}
    assert by_name["north-recorder"]["has_credential"] is True
    # Falling back to the ambient service JWT still works, so this is a fact, not
    # a fault — but it is the difference between access we can revoke on its own
    # and access we cannot.
    assert by_name["south-recorder"]["has_credential"] is False
    assert by_name["south-recorder"]["credential_error"] is None
    # The secret itself must not cross this boundary under any key.
    assert "scoped-key-value" not in body
    assert "credential" not in {k for n in r.json()["items"] for k in n}


async def test_another_tenants_recorder_is_not_listed(app, nodes, http_sessionmaker):
    async with http_sessionmaker() as s:
        s.add(
            MediaNode(
                id="44444444-4444-4444-4444-444444444444",
                tenant_id=TENANT_B,
                name="their-recorder",
                host="theirs.local",
                api_url="http://theirs:8000",
                status="online",
            )
        )
        await s.commit()
    async with client(app) as c:
        r = await c.get(URL, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert "their-recorder" not in {n["name"] for n in r.json()["items"]}


async def test_listing_needs_the_read_permission(app, nodes):
    async with client(app) as c:
        r = await c.get(URL, headers=auth(tenant_id=TENANT_A, permissions=["vms.live.view"]))
    assert r.status_code == 403
