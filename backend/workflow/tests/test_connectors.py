"""The email and webhook connectors — the two that had no test at all.

The push connector is covered (test_push.py, 12 tests). Email and webhook were
not, and they are the two that are actually configured on every estate: the outbox
drains through them on the every-minute ``dispatch_notifications`` sweep, and when
one of them is wrong the symptom is a notification that never arrives, which is
indistinguishable from one that was never queued.

WHAT IS WORTH ASSERTING HERE, given a connector is 40 lines of "read a dict and
call a library". Not that the library was called — that is the library's test.
Three things:

  * THE TLS MODE. ``port == 465`` means implicit TLS (the socket is encrypted
    before SMTP starts); 587 and 25 mean STARTTLS (plaintext socket, upgraded).
    Getting the pair backwards on 465 does not fail loudly — aiosmtplib opens a
    plaintext socket to a port expecting TLS — and the failure mode of the other
    direction is worse: an SMTP AUTH sent before the upgrade puts the tenant's
    stored password on the wire in the clear. Nothing else in this repo checks it.
  * THE FALLBACK CHAIN. Both connectors resolve config from the tenant's channel
    row first, then (email) the service env vars, then a default; webhook falls
    back to the notification's own ``recipient`` as the URL. Which one wins is the
    part an operator debugs at 2am, and it is the part a refactor silently
    reorders.
  * THAT A FAILURE RAISES. The dispatch contract in connectors/base.py is "``send``
    raises on failure — the dispatch task marks the row failed and retries". A
    connector that swallowed a 500 would mark the notification DELIVERED and it
    would never be retried and never be reported. That is a silent data-loss bug
    with no log line, so both connectors are asserted to propagate.

No network and no SMTP server: the lazy imports both connectors use are the seam,
and both are patched at the module object so the connector's own resolution logic
is what runs.
"""

from __future__ import annotations

import pytest

from app.workflow.notifications.connectors import registry
from app.workflow.notifications.connectors.base import DeliveryContext
from app.workflow.notifications.connectors.email import EmailConnector
from app.workflow.notifications.connectors.webhook import WebhookConnector

from conftest import run_async as _run

#: The env vars EmailConnector falls back to. Cleared in every email test so a
#: developer with VE_SMTP_HOST exported cannot make "no host configured" pass.
_SMTP_ENV = (
    "VE_SMTP_HOST", "VE_SMTP_PORT", "VE_SMTP_USERNAME",
    "VE_SMTP_PASSWORD", "VE_SMTP_FROM",
)


def _ctx(**over) -> DeliveryContext:
    base = dict(
        tenant_id="t-1",
        recipient="ops@example.test",
        subject="Incident 42",
        body="a door was forced",
        metadata={},
        channel_config={},
    )
    base.update(over)
    return DeliveryContext(**base)


@pytest.fixture
def smtp(monkeypatch):
    """Patch ``aiosmtplib.send`` and return the list it records calls into."""
    import aiosmtplib

    for var in _SMTP_ENV:
        monkeypatch.delenv(var, raising=False)
    sent: list[dict] = []

    async def fake_send(msg, **kw):
        sent.append({"msg": msg, **kw})

    monkeypatch.setattr(aiosmtplib, "send", fake_send)
    return sent


@pytest.fixture
def http(monkeypatch):
    """Patch ``httpx.AsyncClient`` and return the list of POSTs it records.

    ``status`` on the returned list-like is settable so one test can make
    ``raise_for_status`` fire.
    """
    import httpx

    posts: list[dict] = []
    state = {"raise": None}

    class FakeResp:
        def raise_for_status(self):
            if state["raise"]:
                raise state["raise"]

    class FakeClient:
        def __init__(self, *a, **k):
            posts.append({"client_kwargs": k})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            posts[-1].update(url=url, json=json, headers=headers)
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    return posts, state


# ── registry ───────────────────────────────────────────────────────────


def test_both_connectors_are_registered_under_their_channel_type():
    """The dispatch task resolves by ``channel_type``; an unregistered connector
    means every notification of that type fails with "no connector"."""
    assert isinstance(registry.get("email"), EmailConnector)
    assert isinstance(registry.get("webhook"), WebhookConnector)


# ── email ──────────────────────────────────────────────────────────────


def test_email_without_a_host_anywhere_raises(smtp):
    """No channel host and no env host. Raising is right — the alternative is a row
    marked delivered to nowhere — and the message must name BOTH places to look."""
    with pytest.raises(RuntimeError) as e:
        _run(EmailConnector().send(_ctx()))
    assert "VE_SMTP_HOST" in str(e.value)
    assert not smtp


def test_email_starttls_on_587(smtp):
    _run(EmailConnector().send(_ctx(channel_config={
        "host": "mail.example.test", "port": 587,
        "username": "u", "password": "p", "from_address": "alerts@example.test",
    })))
    call = smtp[0]
    assert call["hostname"] == "mail.example.test" and call["port"] == 587
    assert call["start_tls"] is True, "587 must upgrade — AUTH before it is plaintext"
    assert call["use_tls"] is False, "587 is not an implicit-TLS port"


def test_email_implicit_tls_on_465(smtp):
    """The pair that must not be swapped: 465 is TLS from the first byte, and
    aiosmtplib will happily open a plaintext socket to it if told to STARTTLS."""
    _run(EmailConnector().send(_ctx(channel_config={
        "host": "mail.example.test", "port": 465, "username": "u", "password": "p",
    })))
    call = smtp[0]
    assert call["use_tls"] is True
    assert call["start_tls"] is False


def test_email_use_tls_false_disables_starttls(smtp):
    """A plaintext relay on 25 is a real deployment (an appliance on a closed LAN).
    The operator's explicit ``use_tls: false`` has to survive to the send call."""
    _run(EmailConnector().send(_ctx(channel_config={
        "host": "relay.lan", "port": 25, "use_tls": False,
    })))
    assert smtp[0]["start_tls"] is False and smtp[0]["use_tls"] is False


def test_email_channel_config_beats_the_env(monkeypatch, smtp):
    monkeypatch.setenv("VE_SMTP_HOST", "service-wide.example.test")
    _run(EmailConnector().send(_ctx(channel_config={"host": "tenant.example.test"})))
    assert smtp[0]["hostname"] == "tenant.example.test"


def test_email_falls_back_to_the_env_when_the_channel_is_empty(monkeypatch, smtp):
    """A tenant with no channel row still gets mail, from the service's own SMTP."""
    monkeypatch.setenv("VE_SMTP_HOST", "service-wide.example.test")
    monkeypatch.setenv("VE_SMTP_PORT", "2525")
    monkeypatch.setenv("VE_SMTP_FROM", "noc@example.test")
    _run(EmailConnector().send(_ctx(channel_config={})))
    assert smtp[0]["hostname"] == "service-wide.example.test"
    assert smtp[0]["port"] == 2525
    assert smtp[0]["msg"]["From"] == "noc@example.test"


def test_email_message_carries_recipient_subject_and_body(smtp):
    _run(EmailConnector().send(_ctx(channel_config={
        "host": "mail.example.test", "from_address": "alerts@example.test",
    })))
    msg = smtp[0]["msg"]
    assert msg["To"] == "ops@example.test"
    assert msg["Subject"] == "Incident 42"
    assert msg["From"] == "alerts@example.test"
    assert "a door was forced" in msg.get_content()


def test_email_without_a_subject_still_sends(smtp):
    """A notification template may render no subject. An empty Subject header is a
    common spam trigger, so the connector substitutes rather than omitting."""
    _run(EmailConnector().send(_ctx(subject=None, channel_config={"host": "m.test"})))
    assert smtp[0]["msg"]["Subject"] == "(no subject)"


def test_email_propagates_a_provider_failure(monkeypatch, smtp):
    """base.py: "send raises on failure — the dispatch task marks the row failed and
    retries". Swallowing this marks an undelivered notification delivered."""
    import aiosmtplib

    async def boom(msg, **kw):
        raise OSError("connection refused")

    monkeypatch.setattr(aiosmtplib, "send", boom)
    with pytest.raises(OSError):
        _run(EmailConnector().send(_ctx(channel_config={"host": "m.test"})))


# ── webhook ────────────────────────────────────────────────────────────


def test_webhook_without_a_url_anywhere_raises(http):
    posts, _ = http
    with pytest.raises(RuntimeError):
        _run(WebhookConnector().send(_ctx(recipient="")))
    assert not posts


def test_webhook_uses_the_recipient_as_the_url_when_the_channel_has_none(http):
    """Documented behaviour: a webhook notification may carry its own destination,
    which is how a per-incident callback works without a channel row per target."""
    posts, _ = http
    _run(WebhookConnector().send(_ctx(recipient="https://hook.example.test/a")))
    assert posts[0]["url"] == "https://hook.example.test/a"


def test_webhook_channel_url_beats_the_recipient(http):
    posts, _ = http
    _run(WebhookConnector().send(_ctx(
        recipient="https://hook.example.test/a",
        channel_config={"url": "https://hook.example.test/configured"},
    )))
    assert posts[0]["url"] == "https://hook.example.test/configured"


def test_webhook_posts_the_documented_body_and_headers(http):
    """The five keys are the contract with whatever is on the other end. A rename
    here is a silent breaking change for every existing receiver, so pin them."""
    posts, _ = http
    _run(WebhookConnector().send(_ctx(
        metadata={"instance_id": "i-1"},
        channel_config={
            "url": "https://hook.example.test/x",
            "headers": {"X-Token": "abc"},
            "timeout": 3,
        },
    )))
    body = posts[0]["json"]
    assert set(body) == {"subject", "body", "recipient", "metadata", "tenant_id"}
    assert body["tenant_id"] == "t-1"
    assert body["metadata"] == {"instance_id": "i-1"}
    assert posts[0]["headers"] == {"X-Token": "abc"}
    assert posts[0]["client_kwargs"]["timeout"] == 3.0


def test_webhook_propagates_a_non_2xx(http):
    """``raise_for_status`` is the whole error handling. If a 500 from the receiver
    did not raise, the row would be marked delivered and the incident notification
    would be lost with no log line."""
    import httpx

    posts, state = http
    state["raise"] = httpx.HTTPStatusError("500", request=None, response=None)
    with pytest.raises(httpx.HTTPStatusError):
        _run(WebhookConnector().send(_ctx(channel_config={"url": "https://h.test/x"})))
