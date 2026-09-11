"""Federation — recording schedules, the one config authorship the VMS carries.

Every other write on this surface is an operator acting on a live scene. These
write CONFIG onto a recorder, and they exist because "record this camera
09:00-18:00 on weekdays" is weekly operator work that used to require opening each
recorder's own console.

No node runs here. The federation client's httpx gets a MockTransport, so these
exercise the real client — its URLs, its headers, and above all its ERROR MAPPING —
against a fabricated recorder. A hand-rolled fake of ``fed.*`` would prove the
router calls a function, which is not the part that was wrong.

What is pinned:
  * a bad schedule reads as a REFUSAL, not as a dead recorder. The node validates
    the document and answers 422 with a sentence saying what is wrong with it; the
    first cut mapped that to 503 "recorder unavailable", which reads as a network
    fault and hides the one sentence that would have fixed it;
  * a genuinely unreachable node still reads as unreachable;
  * a partial write is forwarded VERBATIM. The node's PUT patches only the fields it
    receives, and the same permission that carries schedules also carries
    retention_days — so a console sending {"schedule": …} must not have retention
    added to it in transit;
  * the write gate fires. Reading the library is a camera read; writing it is
    config authorship, and a role without that right must not get there.
"""

from __future__ import annotations

import json
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

NODE_ID = "22222222-2222-2222-2222-222222222222"
CAM = "cam-9"
BASE = f"{PREFIX}/vms/federation/nodes/{NODE_ID}"
LIBRARY = f"{BASE}/recording-schedule-templates"
CONFIG = f"{BASE}/cameras/{CAM}/recording-config"

READ_PERMS = ["vms.camera.read"]
WRITE_PERMS = ["vms.camera.read", "vms.config.manage"]

GOOD_SCHEDULE = {"monday": [{"start": "09:00", "end": "18:00"}]}


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
    """A fabricated recorder behind the federation client's own httpx."""
    calls: list[dict] = []
    state = {"handler": None}

    def default(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, "path": request.url.path})

    def dispatch(request: httpx.Request) -> httpx.Response:
        calls.append(
            {
                "method": request.method,
                "path": request.url.path,
                "headers": dict(request.headers),
                "content": request.content,
            }
        )
        return (state["handler"] or default)(request)

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    # The module attribute, not httpx itself: the ASGI test client is an
    # httpx.AsyncClient too, and patching httpx globally would answer the fabricated
    # recorder for requests meant for the service under test.
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


def _detail(r) -> str:
    body = r.json()
    err = body.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or "")
    return str(body.get("detail") or "")


@pytest.mark.asyncio
async def test_the_library_is_relayed_and_says_which_recorder_answered(app, node, recorder):
    recorder.json({"items": [{"id": "t1", "name": "Business hours"}], "total": 1})
    async with client(app) as c:
        r = await c.get(LIBRARY, headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    # An estate view merges several recorders' libraries; without this it cannot say
    # which one a template belongs to, and applying it to the wrong node's cameras
    # is the kind of mistake that is only visible afterwards.
    assert body["node_name"] == "recorder-a"


@pytest.mark.asyncio
async def test_a_schedule_the_recorder_cannot_read_is_a_refusal_not_an_outage(
    app, node, recorder
):
    # What the node actually answers for a malformed week.
    recorder.json(
        {"error": {"code": "VALIDATION_ERROR",
                   "message": "the schedule is not a shape this recorder can use"}},
        statuscode=422,
    )
    async with client(app) as c:
        r = await c.post(
            LIBRARY,
            json={"name": "broken", "schedule": {"notaday": []}},
            headers=auth(tenant_id=TENANT_A, permissions=WRITE_PERMS),
        )
    assert r.status_code == 502, f"{r.status_code}: {r.text}"
    assert "not a shape this recorder can use" in _detail(r)


@pytest.mark.asyncio
async def test_a_recorder_that_is_actually_down_still_reads_as_down(app, node, recorder):
    recorder.down()
    async with client(app) as c:
        r = await c.get(LIBRARY, headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS))
    # 503, not 502: this one may well work on the next try, which is the whole
    # distinction the two statuses carry.
    assert r.status_code == 503, f"{r.status_code}: {r.text}"


@pytest.mark.asyncio
async def test_a_partial_write_is_forwarded_verbatim(app, node, recorder):
    async with client(app) as c:
        r = await c.put(
            CONFIG,
            json={"schedule": GOOD_SCHEDULE},
            headers=auth(tenant_id=TENANT_A, permissions=WRITE_PERMS),
        )
    assert r.status_code == 200, r.text
    sent = json.loads(recorder.calls[-1]["content"])
    # Exactly what was asked for. retention_days rides the same permission and the
    # same endpoint; adding it here — even as a "current value" — would turn every
    # schedule edit into a decision about how long footage survives.
    assert sent == {"schedule": GOOD_SCHEDULE}


@pytest.mark.asyncio
async def test_reading_the_library_does_not_require_config_authorship(app, node, recorder):
    async with client(app) as c:
        r = await c.get(LIBRARY, headers=auth(tenant_id=TENANT_A, permissions=READ_PERMS))
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_writing_a_schedule_does(app, node, recorder):
    """A read token reaches the library and stops at every write on it."""
    headers = auth(tenant_id=TENANT_A, permissions=READ_PERMS)
    async with client(app) as c:
        refused = [
            await c.post(LIBRARY, json={"name": "x", "schedule": GOOD_SCHEDULE}, headers=headers),
            await c.put(CONFIG, json={"schedule": GOOD_SCHEDULE}, headers=headers),
            await c.post(f"{LIBRARY}/t1/apply", json={"camera_ids": [CAM]}, headers=headers),
            await c.delete(f"{LIBRARY}/t1", headers=headers),
        ]
    for r in refused:
        assert r.status_code == 403, f"reached the recorder without config.manage: {r.text}"
    # And nothing was proxied: a gate that refuses after calling the node has already
    # done the thing it is refusing.
    assert recorder.calls == []


@pytest.mark.asyncio
async def test_another_tenants_recorder_is_absent_not_forbidden(app, node, recorder):
    async with client(app) as c:
        r = await c.get(LIBRARY, headers=auth(tenant_id=TENANT_B, permissions=READ_PERMS))
    assert r.status_code == 404, r.text
