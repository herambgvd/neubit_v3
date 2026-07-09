"""Tests for the mobile-push connector + device-token registration.

Covers, without needing real FCM/APNs credentials or a live provider:
  * the ``data`` payload + deep-link build (incident / camera / home),
  * FCM + APNs provider request build (envelope shape, endpoints, headers),
  * tenant-scoped token resolution (a push never crosses tenants),
  * graceful degrade when no credential is configured (no crash, clear error),
  * invalid-token pruning wiring,
  * the connector's registration in the process-wide registry.

Provider request build is asserted by monkeypatching the lazy ``httpx`` import so
no network happens; real end-to-end delivery is a LIVE-VALIDATE step (real project
+ device token).
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.workflow.connectors import registry
from app.workflow.connectors.base import DeliveryContext
from app.workflow.connectors.push import (
    PushConnector,
    PushToken,
    _apns_payload,
    _build_data_payload,
    _deep_link,
    _fcm_message,
)


def _run(coro):
    return asyncio.run(coro)


# ── registry ──────────────────────────────────────────────────────────


def test_push_connector_registered():
    conn = registry.get("push")
    assert conn is not None
    assert conn.channel_type == "push"
    assert "push" in registry.types()


# ── data payload + deep link ──────────────────────────────────────────


def test_deep_link_incident_precedence():
    assert _deep_link("inc1", "cam1") == "neubit://incidents/inc1"
    assert _deep_link("", "cam1") == "neubit://cameras/cam1/live"
    assert _deep_link("", "") == "neubit://home"


def test_build_data_payload_strings_and_dedup():
    ctx = DeliveryContext(
        tenant_id="t-1", recipient="u-1", subject="Hi", body="Body",
        metadata={"event_type": "vms.motion", "camera_id": "cam-9", "incident_id": "inc-3"},
        channel_config={},
    )
    data = _build_data_payload(ctx)
    # All values are strings (FCM requirement).
    assert all(isinstance(v, str) for v in data.values())
    assert data["tenant_id"] == "t-1"
    assert data["event_type"] == "vms.motion"
    assert data["camera_id"] == "cam-9"
    assert data["deep_link"] == "neubit://incidents/inc-3"
    # Empty values are dropped.
    assert "event_id" not in data


def test_build_data_payload_instance_id_alias():
    ctx = DeliveryContext(
        tenant_id="t", recipient="u", subject="s", body="b",
        metadata={"instance_id": "inst-x", "type": "workflow.incident"},
        channel_config={},
    )
    data = _build_data_payload(ctx)
    assert data["incident_id"] == "inst-x"
    assert data["deep_link"] == "neubit://incidents/inst-x"


# ── provider request build ────────────────────────────────────────────


def test_fcm_message_shape():
    msg = _fcm_message("TOK", "Title", "Body", {"k": "v"})["message"]
    assert msg["token"] == "TOK"
    assert msg["notification"] == {"title": "Title", "body": "Body"}
    assert msg["data"] == {"k": "v"}
    assert msg["android"]["priority"] == "high"


def test_apns_payload_shape():
    p = _apns_payload("Title", "Body", {"camera_id": "cam-1"})
    assert p["aps"]["alert"] == {"title": "Title", "body": "Body"}
    assert p["aps"]["sound"] == "default"
    # Custom keys ride alongside aps.
    assert p["camera_id"] == "cam-1"


# ── tenant-scoped resolution + graceful degrade ───────────────────────


def test_no_tokens_is_noop():
    """No registered devices → not an error (nothing to deliver)."""
    async def resolver(tenant_id, user_id):
        return []

    conn = PushConnector(token_resolver=resolver)
    ctx = DeliveryContext(
        tenant_id="t", recipient="u", subject="s", body="b", metadata={}, channel_config={},
    )
    # Should return cleanly (no raise).
    _run(conn.send(ctx))


def test_no_recipient_raises():
    conn = PushConnector(token_resolver=lambda *_: [])
    ctx = DeliveryContext(
        tenant_id="t", recipient="", subject="s", body="b", metadata={}, channel_config={},
    )
    with pytest.raises(RuntimeError):
        _run(conn.send(ctx))


def test_fcm_no_credential_degrades_gracefully():
    """FCM token present but no service account → all-fail RuntimeError, no crash."""
    async def resolver(tenant_id, user_id):
        return [PushToken("d1", "fcm", "tok-a")]

    pruned = []

    async def pruner(ids):
        pruned.extend(ids)

    conn = PushConnector(token_resolver=resolver, token_pruner=pruner)
    ctx = DeliveryContext(
        tenant_id="t", recipient="u", subject="s", body="b", metadata={},
        channel_config={},  # no service_account
    )
    with pytest.raises(RuntimeError) as exc:
        _run(conn.send(ctx))
    assert "failed" in str(exc.value).lower()
    assert pruned == []  # a missing-credential is not a token-invalidation


def test_apns_no_credential_degrades_gracefully():
    async def resolver(tenant_id, user_id):
        return [PushToken("d2", "apns", "tok-b")]

    conn = PushConnector(token_resolver=resolver, token_pruner=lambda ids: _noop())
    ctx = DeliveryContext(
        tenant_id="t", recipient="u", subject="s", body="b", metadata={},
        channel_config={},  # no apns key_id/team_id/topic/auth_key
    )
    with pytest.raises(RuntimeError):
        _run(conn.send(ctx))


async def _noop():
    return None


def test_tenant_scoping_resolver_receives_tenant():
    """The connector passes the notification's tenant_id to the resolver, so the
    DB helper can filter — a push cannot leak across tenants."""
    seen = {}

    async def resolver(tenant_id, user_id):
        seen["tenant_id"] = tenant_id
        seen["user_id"] = user_id
        return []

    conn = PushConnector(token_resolver=resolver)
    ctx = DeliveryContext(
        tenant_id="tenant-A", recipient="user-7", subject="s", body="b",
        metadata={}, channel_config={},
    )
    _run(conn.send(ctx))
    assert seen == {"tenant_id": "tenant-A", "user_id": "user-7"}


# ── FCM delivery with a stubbed transport (no network) ─────────────────


def test_fcm_delivery_and_prune_with_stub(monkeypatch):
    """Stub the FCM access-token mint + httpx so we exercise the send loop:
    one 200 (delivered) + one UNREGISTERED (pruned)."""
    from app.workflow.connectors import push as push_mod

    async def fake_token(_sa):
        return "bearer-xyz"

    monkeypatch.setattr(push_mod, "_fcm_access_token", fake_token)

    class FakeResp:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

    posts = []

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            posts.append({"url": url, "headers": headers, "json": json})
            # First token OK, second UNREGISTERED.
            if json["message"]["token"] == "good":
                return FakeResp(200, {})
            return FakeResp(404, {"error": {"status": "NOT_FOUND"}})

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    async def resolver(tenant_id, user_id):
        return [PushToken("d-good", "fcm", "good"), PushToken("d-bad", "fcm", "bad")]

    pruned = []

    async def pruner(ids):
        pruned.extend(ids)

    conn = PushConnector(token_resolver=resolver, token_pruner=pruner)
    cfg = {"service_account": {"project_id": "proj-123", "type": "service_account"}}
    ctx = DeliveryContext(
        tenant_id="t", recipient="u", subject="Alert", body="Body",
        metadata={"camera_id": "cam-1"}, channel_config=cfg,
    )
    _run(conn.send(ctx))  # 1 delivered, 1 pruned → no raise

    assert len(posts) == 2
    assert posts[0]["url"].endswith("/v1/projects/proj-123/messages:send")
    assert posts[0]["headers"]["Authorization"] == "Bearer bearer-xyz"
    assert pruned == ["d-bad"]
