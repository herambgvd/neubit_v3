"""Federation Phase-4 — the per-camera DEVICE surface, proxied THROUGH the node.

These are the routes that close the gap between Model A (``app/vms/drivers/*``: the VMS
decrypts the camera's credentials and drives the device itself) and Model B
(``app/vms/federation``: the owning NVR drives it). Until Phase-4 the federated surface
stopped at PTZ move/stop + snapshot, so imaging, encoders, OSD, privacy masks,
camera-side motion, digital I/O, presets, patrol, tours, talk and forensic motion search
were reachable ONLY through Model A — which is what made Model A undeletable.

NO node is running and none is needed: ``httpx.AsyncClient`` inside the federation client
is given an ``httpx.MockTransport``, so the tests exercise the REAL client code (URL,
headers, error mapping, 204 handling) against a fabricated recorder. That is the point —
a hand-rolled fake of ``fed.*`` would prove the router calls a function, not that the
proxy speaks the node's protocol.

Four things are asserted for the whole surface, not one route of it:
  * the happy path relays the node's payload, stamped with its source node;
  * an unreachable node is a clean 502, never a 500;
  * a node owned by another tenant is 404 — indistinguishable from absent, on purpose;
  * the permission gate on each route actually fires (a declared dependency that is
    never reached is exactly the bug a route test exists to catch).
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

NODE_ID = "11111111-1111-1111-1111-111111111111"
CAM = "cam-7"
FED = f"{PREFIX}/vms/federation/nodes/{NODE_ID}/cameras/{CAM}"

# Every permission the Phase-4 routes gate on, so a "full operator" token can reach the
# whole surface and the gating tests can subtract exactly one of them.
ALL_PERMS = [
    "vms.camera.read",
    "vms.camera.tune",
    "vms.ptz.control",
    "vms.playback.view",
]


@pytest_asyncio.fixture
async def node(http_sessionmaker):
    """One registered recorder, owned by TENANT_A, with a scoped credential."""
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
    """Give the federation client's httpx a MockTransport, and record what it was asked.

    Returns a ``calls`` list of (method, url, headers, body) and lets a test install a
    responder. The default responder answers 200 with an echo of the path, which is
    enough for the shape assertions and keeps each test to the one thing it is about.
    """
    calls: list[dict] = []
    state = {"handler": None}

    def default(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, "path": request.url.path})

    def dispatch(request: httpx.Request) -> httpx.Response:
        calls.append(
            {
                "method": request.method,
                "url": str(request.url),
                "path": request.url.path,
                "headers": dict(request.headers),
                "content": request.content,
            }
        )
        return (state["handler"] or default)(request)

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    # Swap the module the federation client reached for, NOT httpx itself: the test
    # client in conftest is an httpx.AsyncClient too, and patching the attribute on the
    # shared module would put the MockTransport in front of the ASGI app as well —
    # every request would answer the fabricated recorder instead of the service.
    monkeypatch.setattr(
        fedclient,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )

    class Rig:
        calls = None

        def respond(self, fn):
            state["handler"] = fn

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
    """The kernel renders an HTTPException as {"error": {"code", "message"}}, not
    FastAPI's bare {"detail"}. Read either, so the assertion is about the SENTENCE the
    operator gets rather than about which envelope this service happens to use."""
    body = r.json()
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return str(body["error"].get("message") or "")
    return str((body or {}).get("detail") or "")


def _admin(tenant=TENANT_A):
    return auth(tenant_id=tenant, permissions=list(ALL_PERMS))


# ── the surface, as (method, path suffix, body) ──────────────────────────────
#
# One table, walked by every cross-cutting test below. A route added to the router and
# not added here is a route with no 502/404/auth coverage, which is the failure mode
# this shape is chosen to make loud.

# NOTE the writes that are NOT here: encoder video/audio, OSD, privacy masks, motion
# zones and a relay's IdleState. They were in this table and the router proxied them;
# both are gone. The node refuses them to a federation credential on purpose
# (vms.camera.manage is config authorship and federationGrants withholds it), so
# proxying them was building a surface that could only ever 403. Those screens belong
# to the owning node's own console. Driving a relay's STATE stays — that is tuning.
SURFACE = [
    ("GET", "/imaging", None, "vms.camera.read"),
    ("PUT", "/imaging", {"Brightness": 50}, "vms.camera.tune"),
    ("POST", "/imaging/focus/move", {"mode": "relative", "distance": 0.1}, "vms.camera.tune"),
    ("POST", "/imaging/focus/stop", None, "vms.camera.tune"),
    ("GET", "/video", None, "vms.camera.read"),
    ("GET", "/audio", None, "vms.camera.read"),
    ("GET", "/osd", None, "vms.camera.read"),
    ("GET", "/masks", None, "vms.camera.read"),
    ("GET", "/backchannel", None, "vms.camera.read"),
    ("GET", "/motion", None, "vms.camera.read"),
    ("GET", "/io", None, "vms.camera.read"),
    ("POST", "/io/relays/RelayToken_1/state", {"state": "active"}, "vms.camera.tune"),
    ("GET", "/ptz", None, "vms.camera.read"),
    ("GET", "/ptz/presets", None, "vms.camera.read"),
    ("POST", "/ptz/presets", {"name": "Gate"}, "vms.ptz.control"),
    ("POST", "/ptz/presets/p1/goto", {"speed": 0.5}, "vms.ptz.control"),
    ("DELETE", "/ptz/presets/p1", None, "vms.ptz.control"),
    ("GET", "/ptz/patrol", None, "vms.camera.read"),
    ("PUT", "/ptz/patrol", {"enabled": True}, "vms.ptz.control"),
    ("POST", "/ptz/patrol/operate", {"operation": "start"}, "vms.ptz.control"),
    ("GET", "/ptz/tours", None, "vms.camera.read"),
    ("POST", "/ptz/tours", {"name": "Lap"}, "vms.ptz.control"),
    ("PUT", "/ptz/tours/t1", {"name": "Lap"}, "vms.ptz.control"),
    ("DELETE", "/ptz/tours/t1", None, "vms.ptz.control"),
    ("POST", "/ptz/tours/t1/operate", {"operation": "Start"}, "vms.ptz.control"),
    ("POST", "/talk", {}, "vms.camera.tune"),
    ("POST", "/motion-search", {"from": "2026-01-01T00:00:00Z", "to": "2026-01-01T01:00:00Z"},
     "vms.playback.view"),
]

IDS = [f"{m} {p}" for m, p, _, _ in SURFACE]


async def _call(app, method, suffix, body, headers):
    async with client(app) as c:
        return await c.request(method, FED + suffix, json=body, headers=headers)


# ── happy path ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("method,suffix,body,perm", SURFACE, ids=IDS)
async def test_every_route_proxies_to_the_node_and_tags_it(
    app, node, recorder, method, suffix, body, perm
):
    """The node's payload comes back whole, plus the source node — the tag every other
    federated route carries, so a merged multi-node view can say which recorder answered."""
    recorder.json({"ok": True, "device_said": "hello"})
    r = await _call(app, method, suffix, body, _admin())
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["device_said"] == "hello"
    assert payload["node_id"] == NODE_ID
    assert payload["node_name"] == "recorder-a"


@pytest.mark.parametrize("method,suffix,body,perm", SURFACE, ids=IDS)
async def test_every_route_hits_the_nodes_estate_api_with_the_scoped_credential(
    app, node, recorder, method, suffix, body, perm
):
    """The URL is the node's own estate route, and auth is the SCOPED per-node
    credential — not a second mechanism invented for this batch, and never the camera's
    own credentials, which the VMS no longer holds under Model B."""
    r = await _call(app, method, suffix, body, _admin())
    assert r.status_code == 200, r.text
    call = recorder.calls[-1]
    assert call["url"].startswith("http://recorder-a:8000/api/v1/nvr/estate/cameras/cam-7")
    assert call["headers"]["x-node-credential"] == "scoped-key"
    assert "authorization" not in call["headers"]


def test_the_surface_table_covers_every_phase4_route():
    """A route in the router with no row here has no 502 / 404 / permission coverage.

    The comparison is against the router's own path set, so the table cannot quietly
    fall behind the code it is meant to hold to account.
    """
    from app.vms.federation.router import router

    stem = "/nodes/{node_id}/cameras/{camera_id}"
    # Phase-1..3 routes, already covered by their own behaviour elsewhere in the module.
    earlier = {
        ("POST", "/live"), ("POST", "/ptz"), ("GET", "/snapshot"), ("GET", "/timeline"),
        ("GET", "/recordings"), ("POST", "/recording/start"), ("POST", "/recording/stop"),
        ("POST", "/reboot"), ("POST", "/exports"), ("GET", "/exports"),
        ("POST", "/holds"), ("DELETE", "/holds"), ("GET", "/holds"), ("POST", "/playback"),
        # Streams a request body; exercised by its own test rather than the table walk.
        ("POST", "/talk/uplink"),
    }
    live = set()
    for route in router.routes:
        path = getattr(route, "path", "")
        if not path.startswith(stem):
            continue
        for m in set(route.methods) - {"HEAD", "OPTIONS"}:
            live.add((m, path[len(stem):]))
    covered = {(m, _template(s)) for m, s, _, _ in SURFACE} | earlier
    assert not (live - covered), f"uncovered federated routes: {sorted(live - covered)}"


def _template(suffix: str) -> str:
    """Turn a concrete test path back into the router's templated one."""
    return (
        suffix.replace("/osd/osd1", "/osd/{osd_token}")
        .replace("/masks/m1", "/masks/{mask_token}")
        .replace("/relays/RelayToken_1", "/relays/{token}")
        .replace("/presets/p1", "/presets/{preset}")
        .replace("/tours/t1", "/tours/{tour}")
    )


# ── an unreachable node is a 502, never a 500 ────────────────────────────────


@pytest.mark.parametrize("method,suffix,body,perm", SURFACE, ids=IDS)
async def test_unreachable_node_is_a_clean_502(app, node, recorder, method, suffix, body, perm):
    """A recorder that cannot be reached is an UPSTREAM failure. 502 says so; a 500
    would blame the VMS and send the operator to the wrong log."""
    recorder.down()
    r = await _call(app, method, suffix, body, _admin())
    assert r.status_code == 502, r.text
    assert "recorder unavailable" in _detail(r)


async def test_a_node_that_refuses_relays_its_own_sentence(app, node, recorder):
    """The node's own error text survives the proxy. This is the case that matters most
    in practice: the scoped federation credential does NOT carry camera.manage, so a
    real node answers 403 to every device WRITE — and the operator has to be able to
    read WHY rather than a bare status code."""
    recorder.json({"error": {"code": "FORBIDDEN", "message": "missing permission camera.manage"}}, 403)
    async with client(app) as c:
        r = await c.put(FED + "/imaging", json={"Brightness": 10}, headers=_admin())
    assert r.status_code == 502
    assert "camera.manage" in _detail(r)


# ── tenant scoping ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("method,suffix,body,perm", SURFACE, ids=IDS)
async def test_another_tenants_node_is_404(app, node, recorder, method, suffix, body, perm):
    """Tenant B holds every permission and still cannot reach tenant A's recorder — and
    gets 404, not 403: a node it may not see is indistinguishable from one that is not
    there, which is what keeps the estate from being enumerable across tenants."""
    r = await _call(app, method, suffix, body, _admin(TENANT_B))
    assert r.status_code == 404, r.text
    assert not recorder.calls, "a cross-tenant request reached the node"


# ── permission gating ────────────────────────────────────────────────────────


@pytest.mark.parametrize("method,suffix,body,perm", SURFACE, ids=IDS)
async def test_the_permission_gate_actually_fires(app, node, recorder, method, suffix, body, perm):
    """Hold every permission EXCEPT the one this route declares → 403, and nothing
    reaches the node. A dependency that is declared and never reached looks identical
    to a working gate until exactly this test."""
    without = [p for p in ALL_PERMS if p != perm]
    r = await _call(app, method, suffix, body, auth(tenant_id=TENANT_A, permissions=without))
    assert r.status_code == 403, f"{method} {suffix} -> {r.status_code}"
    assert not recorder.calls, "an unauthorised request reached the node"


@pytest.mark.parametrize("method,suffix,body,perm", SURFACE, ids=IDS)
async def test_anonymous_is_refused(app, node, recorder, method, suffix, body, perm):
    r = await _call(app, method, suffix, body, {})
    assert r.status_code == 401


# ── shapes worth asserting individually ──────────────────────────────────────


async def test_a_204_delete_still_answers_a_body(app, node, recorder):
    """The node answers 204 to a preset delete. A bare 204 would be the one shape in
    this module carrying no node tag, so the client turns an empty body into {} and the
    route tags it like everything else."""
    recorder.respond(lambda r: httpx.Response(204))
    async with client(app) as c:
        r = await c.delete(FED + "/ptz/presets/p1", headers=_admin())
    assert r.status_code == 200
    assert r.json() == {"node_id": NODE_ID, "node_name": "recorder-a"}


async def test_motion_search_relays_the_not_ai_disclosure_whole(app, node, recorder):
    """``method``/``summary`` and ``complete``/``notes`` are the node's non-negotiable
    disclosures: this is pixel-difference, not object detection, and a bounded search
    that gave up must not read as "the footage is clear". They survive the proxy."""
    recorder.json({
        "hits": [{"start": "2026-01-01T00:10:00Z", "end": "2026-01-01T00:10:12Z",
                  "duration_sec": 12.0, "score": 0.4}],
        "examined_from": "2026-01-01T00:00:00Z",
        "examined_to": "2026-01-01T00:30:00Z",
        "frames_examined": 1800,
        "complete": False,
        "notes": ["frame budget reached"],
        "gaps": [],
        "method": "Region pixel-difference over recorded frames — NOT AI.",
        "summary": "1 change window in the 30 minutes examined.",
    })
    async with client(app) as c:
        r = await c.post(
            FED + "/motion-search",
            json={"from": "2026-01-01T00:00:00Z", "to": "2026-01-01T01:00:00Z",
                  "region": {"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5}},
            headers=_admin(),
        )
    body = r.json()
    assert r.status_code == 200
    assert "NOT AI" in body["method"]
    assert body["complete"] is False and body["notes"] == ["frame budget reached"]
    assert body["examined_to"] == "2026-01-01T00:30:00Z"
    # It is a node call on the bare estate route, NOT under /onvif/ — it reads the
    # recording index and never touches the camera.
    assert recorder.calls[-1]["path"] == "/api/v1/nvr/estate/cameras/cam-7/motion-search"


async def test_tours_supported_tristate_is_not_flattened(app, node, recorder):
    """``tours_supported`` absent means "we could not ask", which is the only one of the
    three states worth a Retry. The proxy must not helpfully fill it in."""
    recorder.json({"supported": True, "profile_token": "p0", "tours": [],
                   "tours_error": "read timed out", "detail": "unknown"})
    async with client(app) as c:
        r = await c.get(FED + "/ptz/tours", headers=_admin())
    assert "tours_supported" not in r.json()


async def test_relay_latching_null_survives(app, node, recorder):
    """``latching: null`` is a fabrication guard — the device did not report its mode, so
    "there is a way back from this" is unknown, not false."""
    recorder.json({"token": "RelayToken_1", "state": "active", "mode": "",
                   "latching": None, "mode_unknown": True})
    async with client(app) as c:
        r = await c.post(FED + "/io/relays/RelayToken_1/state",
                         json={"state": "active"}, headers=_admin())
    body = r.json()
    assert body["latching"] is None and body["mode_unknown"] is True


async def test_talk_uplink_streams_the_body_through(app, node, recorder):
    """The microphone leg is carried, not buffered into a summary: what the operator
    sent is what the node receives."""
    recorder.json({"talked": True, "half_duplex": True, "codec": "PCMU", "frames_sent": 3,
                   "finished_at": "2026-01-01T00:00:03Z"})
    pcm = b"\x01\x02" * 480
    async with client(app) as c:
        r = await c.post(FED + "/talk/uplink", content=pcm, headers=_admin())
    assert r.status_code == 200, r.text
    assert r.json()["frames_sent"] == 3
    assert recorder.calls[-1]["content"] == pcm
    assert recorder.calls[-1]["path"] == "/api/v1/nvr/estate/cameras/cam-7/onvif/talk/uplink"


async def test_talk_uplink_unreachable_node_is_502(app, node, recorder):
    recorder.down()
    async with client(app) as c:
        r = await c.post(FED + "/talk/uplink", content=b"\x00\x00", headers=_admin())
    assert r.status_code == 502


async def test_talk_uplink_is_gated_and_tenant_scoped(app, node, recorder):
    async with client(app) as c:
        viewer = await c.post(FED + "/talk/uplink", content=b"\x00",
                              headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
        stranger = await c.post(f"{PREFIX}/vms/federation/nodes/{NODE_ID}/cameras/{CAM}/talk/uplink",
                                content=b"\x00", headers=_admin(TENANT_B))
    assert viewer.status_code == 403
    assert stranger.status_code == 404
    assert not recorder.calls
