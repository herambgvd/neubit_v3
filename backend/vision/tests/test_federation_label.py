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


class _Recorder:
    """A fabricated recorder for the heal path: lists credentials, accepts renames."""

    def __init__(self, creds, *, refuse_rename=False, unreachable=False):
        self.creds = creds
        self.refuse_rename = refuse_rename
        self.unreachable = unreachable
        self.renamed: list[tuple[str, str]] = []

    def dispatch(self, request: httpx.Request) -> httpx.Response:
        if self.unreachable:
            raise httpx.ConnectError("no route to host")
        if request.method == "PATCH":
            if self.refuse_rename:
                return httpx.Response(403, json={"error": {"message": "missing grant settings.manage"}})
            import json as _json

            cid = request.url.path.rsplit("/", 1)[-1]
            label = _json.loads(request.content)["label"]
            self.renamed.append((cid, label))
            for c in self.creds:
                if c["id"] == cid:
                    c["label"] = label
            return httpx.Response(204)
        return httpx.Response(200, json={"items": self.creds})


def _install(monkeypatch, recorder: _Recorder):
    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(recorder.dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setattr(
        fedclient,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )


async def _list_credentials(monkeypatch, recorder: _Recorder):
    """Drive MediaNodeService.list_credentials against one registered node."""
    import uuid

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from kernel.auth import Scope

    from app.db import Base
    from app.vms.media_nodes.service import MediaNodeService
    from app.vms.models import MediaNode

    _install(monkeypatch, recorder)
    tenant = uuid.uuid4()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with sm() as db:
            node = MediaNode(
                id=str(uuid.uuid4()), tenant_id=tenant, name="recorder-a",
                host="recorder-a", api_url=NODE, status="online",
            )
            db.add(node)
            await db.commit()
            svc = MediaNodeService(db, Scope(tenant_id=tenant, is_superadmin=False))
            return await svc.list_credentials(node.id)
    finally:
        await engine.dispose()


async def test_a_credential_still_carrying_the_old_name_is_renamed(monkeypatch):
    # Otherwise the retired name survives on BOTH consoles until someone
    # re-enrols, which revokes a working credential to fix a string.
    monkeypatch.delenv("VE_FEDERATION_LABEL", raising=False)
    rec = _Recorder([{"id": "c1", "label": "neubit_v3 VMS", "revoked_at": None}])

    creds = await _list_credentials(monkeypatch, rec)

    assert rec.renamed == [("c1", "Neubit VMS")]
    assert creds[0]["label"] == "Neubit VMS"


async def test_a_label_somebody_chose_is_left_alone(monkeypatch):
    # Only the exact strings this VMS itself used to send are touched — another
    # VMS's key, or a name an operator typed, is not ours to rewrite.
    monkeypatch.delenv("VE_FEDERATION_LABEL", raising=False)
    rec = _Recorder([
        {"id": "c1", "label": "Head office VMS", "revoked_at": None},
        {"id": "c2", "label": "Neubit VMS", "revoked_at": None},
    ])

    creds = await _list_credentials(monkeypatch, rec)

    assert rec.renamed == []
    assert [c["label"] for c in creds] == ["Head office VMS", "Neubit VMS"]


async def test_a_recorder_that_refuses_the_rename_still_lists(monkeypatch):
    # An independently deployed recorder does not grant us settings.manage. The
    # label stays wrong there; the screen must still work.
    monkeypatch.delenv("VE_FEDERATION_LABEL", raising=False)
    rec = _Recorder([{"id": "c1", "label": "neubit_v3 VMS", "revoked_at": None}], refuse_rename=True)

    creds = await _list_credentials(monkeypatch, rec)

    assert creds[0]["label"] == "neubit_v3 VMS"
