"""What this VMS calls itself on a recorder it federates.

The label travels: it is written into the RECORDER's own credential list, so it
is read by an operator standing at that recorder deciding which key to revoke,
and a recorder federated by two VMSs shows two of them. It used to be
"neubit_v3 VMS" — the name of a source tree, on someone else's screen.

Driven through the real client against an httpx.MockTransport, so what is
asserted is the request that would actually leave this process.
"""

from __future__ import annotations

import httpx
import pytest
from types import SimpleNamespace

from app.vms.federation import client as fedclient

pytestmark = pytest.mark.asyncio

NODE = "http://recorder-a:8000"


@pytest.fixture
def recorder(monkeypatch):
    """A fabricated recorder that records what it was asked and answers a credential."""
    calls: list[httpx.Request] = []

    def dispatch(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            201,
            json={"credential": "scoped-key", "id": "c1", "label": "whatever", "grants": []},
        )

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setattr(
        fedclient,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )
    return calls


async def test_enrol_does_not_name_the_repository(recorder, monkeypatch):
    monkeypatch.delenv("VE_FEDERATION_LABEL", raising=False)
    await fedclient.enroll_node_full(NODE)

    label = recorder[0].url.params["label"]
    assert label == "Neubit VMS"
    assert "neubit_v3" not in label


async def test_pairing_carries_the_same_label(recorder, monkeypatch):
    monkeypatch.delenv("VE_FEDERATION_LABEL", raising=False)
    await fedclient.pair_node(NODE, "123456")

    import json

    body = json.loads(recorder[0].content)
    # Same name whichever way the trust was established — a recorder listing two
    # keys from one VMS under two names is not a thing an operator can act on.
    assert body["label"] == "Neubit VMS"


async def test_a_deployment_can_name_itself(recorder, monkeypatch):
    # An estate with two VMSs has to be able to tell them apart on the recorder.
    monkeypatch.setenv("VE_FEDERATION_LABEL", "Acme Control Room")
    await fedclient.enroll_node_full(NODE)

    assert recorder[0].url.params["label"] == "Acme Control Room"


async def test_a_blank_setting_falls_back_rather_than_sending_nothing(recorder, monkeypatch):
    # An empty env var is how a label goes missing entirely, and a nameless
    # credential on the recorder's list is worse than a generic one.
    monkeypatch.setenv("VE_FEDERATION_LABEL", "   ")
    await fedclient.enroll_node_full(NODE)

    assert recorder[0].url.params["label"] == "Neubit VMS"


async def test_an_explicit_label_still_wins(recorder, monkeypatch):
    monkeypatch.setenv("VE_FEDERATION_LABEL", "Acme Control Room")
    await fedclient.enroll_node_full(NODE, label="one-off")

    assert recorder[0].url.params["label"] == "one-off"
