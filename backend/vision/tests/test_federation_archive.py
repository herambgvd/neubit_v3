"""Federation — the cold tier, read through the recorder that owns it.

The archive copies footage somewhere durable and retention then deletes the local
copy. From a console those two are the same symptom — an empty stretch of timeline
— and only these reads tell them apart. So what is pinned here is not that the
proxy forwards bytes, but that the three facts an operator acts on survive the
trip: whether the archive is actually running, what is recoverable, and how past
recoveries went.

There is no write to test, and that is the shape of the surface rather than a gap:
starting a restore gates node-side on vms.storage.manage, which the federation
credential does not carry.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from app.vms.federation import client as fedclient
from app.vms.models import MediaNode

from .conftest import PREFIX, auth, client

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
NODE_ID = "33333333-3333-3333-3333-333333333333"
BASE = f"{PREFIX}/vms/federation/nodes/{NODE_ID}"

READ_PERMS = ["vms.playback.view", "vms.camera.read"]


@pytest_asyncio.fixture
async def node(http_sessionmaker):
    async with http_sessionmaker() as s:
        s.add(
            MediaNode(
                id=NODE_ID,
                tenant_id=TENANT_A,
                name="recorder-a",
                host="recorder-a",
                api_url="http://recorder-a:8000",
                credential="scoped-key",
                status="online",
            )
        )
        await s.commit()


@pytest.fixture
def recorder(monkeypatch):
    calls: list[dict] = []
    state = {"handler": None}

    def default(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    def dispatch(request: httpx.Request) -> httpx.Response:
        calls.append({"method": request.method, "path": request.url.path, "query": str(request.url.query)})
        return (state["handler"] or default)(request)

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setattr(
        fedclient,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )

    class Rig:
        calls = None

        def json(self, payload, statuscode: int = 200):
            state["handler"] = lambda r: httpx.Response(statuscode, json=payload)

        def down(self):
            def boom(r):
                raise httpx.ConnectError("connection refused", request=r)

            state["handler"] = boom

    rig = Rig()
    rig.calls = calls
    return rig


@pytest.mark.asyncio
async def test_the_reason_an_archive_cannot_run_survives_the_proxy(app, node, recorder):
    """The field the whole panel is for.

    An archive that is enabled and blocked protects exactly as much footage as one
    that is off, and only `blocked_reason` distinguishes them. Dropping it in
    transit would leave "0 archived" reading as "nothing needed archiving".
    """
    recorder.json({
        "enabled": True,
        "ready": False,
        "blocked_reason": "the destination NAS share is not mounted",
        "stats": {"archived_segments": 0, "local_only": 412, "cold_only": 0},
    })
    async with client(app) as c:
        r = await c.get(f"{BASE}/storage/archive", headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["blocked_reason"] == "the destination NAS share is not mounted"
    # local_only is the number that reads as harmless and is not: those segments
    # have ONE copy.
    assert body["stats"]["local_only"] == 412
    assert body["node_name"] == "recorder-a"


@pytest.mark.asyncio
async def test_a_restore_window_is_passed_to_the_recorder_as_asked(app, node, recorder):
    """`from` is the recorder's query name. Renaming it in transit would silently
    widen every windowed request to the whole archive."""
    async with client(app) as c:
        r = await c.get(
            f"{BASE}/storage/restore/ranges?camera_id=cam-1&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
            headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS),
        )
    assert r.status_code == 200, r.text
    q = recorder.calls[-1]["query"]
    assert "camera_id=cam-1" in q
    assert "from=2026-01-01" in q
    assert "to=2026-02-01" in q


@pytest.mark.asyncio
async def test_restore_jobs_keep_all_three_counts(app, node, recorder):
    """40 of 50 recovered is neither a success nor a failure, and only the counts
    say which. A proxy that kept `status` and dropped the numbers would turn a
    partial restore into a green tick."""
    recorder.json({"items": [{"id": "j1", "status": "done", "requested": 50, "restored": 40, "failed": 10}]})
    async with client(app) as c:
        r = await c.get(f"{BASE}/storage/restore/jobs", headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS))
    job = r.json()["items"][0]
    assert (job["requested"], job["restored"], job["failed"]) == (50, 40, 10)


@pytest.mark.asyncio
async def test_a_recorder_that_is_down_reads_as_down(app, node, recorder):
    recorder.down()
    async with client(app) as c:
        r = await c.get(f"{BASE}/storage/archive", headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS))
    assert r.status_code == 503, r.text


@pytest.mark.asyncio
async def test_another_tenants_recorder_is_absent_not_forbidden(app, node, recorder):
    async with client(app) as c:
        r = await c.get(f"{BASE}/storage/archive", headers=auth(tenant_id=TENANT_B, permissions=READ_PERMS))
    assert r.status_code == 404, r.text
    # And nothing was asked of the recorder on another tenant's behalf.
    assert recorder.calls == []
