"""Media-node reachability probe — "online" means a RECORDER answered (SCRUM-302).

A recorder was registered with its console's address and showed Online, last
heartbeat "just now", while every federated call behind it answered 404. The probe
read any status below 400 as reachable, and the console's /health was a 307 to its
login page. These pin that only a recorder's own /health body makes a node online.

No node runs here: the service module's ``httpx`` is swapped for one whose client
answers from a fixture, as test_federation_client_errors.py does for the client.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from app.vms.media_nodes import service as node_service

API = "http://192.168.1.11:8080"


@pytest.fixture
def node(monkeypatch):
    state = {"handler": lambda request: httpx.Response(200, json={"status": "ok", "service": "nvr"})}
    seen: list[httpx.Request] = []
    built: list[dict] = []

    def dispatch(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return state["handler"](request)

    def factory(*args, **kwargs):
        built.append(dict(kwargs))
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setattr(
        node_service,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError),
    )
    return SimpleNamespace(state=state, seen=seen, built=built)


async def test_a_recorders_health_body_is_online(node):
    node.state["handler"] = lambda r: httpx.Response(
        200, json={"status": "ok", "service": "nvr", "env": "production"}
    )
    ok, payload = await node_service.probe_node(API)
    assert ok is True
    assert payload["service"] == "nvr"
    assert str(node.seen[0].url) == f"{API}/health"


async def test_a_login_redirect_is_not_online_and_is_not_followed(node):
    # The console's /health before SCRUM-301: a 307 to its login page.
    node.state["handler"] = lambda r: httpx.Response(307, headers={"location": "/login"})
    ok, payload = await node_service.probe_node(API)
    assert (ok, payload) == (False, {})
    assert len(node.seen) == 1
    assert node.built[0].get("follow_redirects") is False


async def test_an_html_page_answering_200_is_not_online(node):
    node.state["handler"] = lambda r: httpx.Response(200, text="<!doctype html><title>Login</title>")
    assert await node_service.probe_node(API) == (False, {})


async def test_another_services_health_is_not_a_recorder(node):
    # Pointing a recorder at this VMS's own core must not read as a healthy recorder.
    node.state["handler"] = lambda r: httpx.Response(200, json={"status": "ok", "service": "core"})
    assert await node_service.probe_node(API) == (False, {})


async def test_a_recorder_body_without_a_service_key_is_still_online(node):
    # An older recorder build: an upgrade of this VMS must not mark it offline.
    node.state["handler"] = lambda r: httpx.Response(200, json={"status": "ok"})
    ok, _ = await node_service.probe_node(API)
    assert ok is True


@pytest.mark.parametrize("status", [404, 500, 503])
async def test_an_error_status_is_not_online(node, status):
    node.state["handler"] = lambda r: httpx.Response(status, json={"status": "ok", "service": "nvr"})
    assert await node_service.probe_node(API) == (False, {})


async def test_an_unreachable_address_is_not_online(node):
    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    node.state["handler"] = refuse
    assert await node_service.probe_node(API) == (False, {})
