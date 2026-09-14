"""One bad channel must not eat the notification.

``notify`` is the single seam every scenario in the platform calls to tell a
person something: an alarm, a breach, a failed job. Behind it are four
deliveries — the always-on in-app row, then email, push and webhook — and each
one talks to something that is configured per tenant and therefore routinely
misconfigured: an SMTP host that is wrong, an FCM key that expired, a webhook
pointing at a URL nobody runs any more.

The property that matters is not that any one of them works. It is that a
failure in one is CONFINED to it. The alternative is the failure mode this whole
module is shaped to avoid: the first misconfigured channel raises, the ones after
it never run, and the operator's alarm is delivered nowhere — while the scenario
that called ``notify`` sees an exception from a best-effort side effect and fails
the request that raised the alarm in the first place.

Every test below breaks exactly one channel and asserts the others still
delivered. None of it is observable from ``notify``'s return value, which is
``None`` whatever happens, and none of it is observable from a suite that stubs
one channel at a time and checks the happy path.

The channels are stubbed at the dispatcher's own names (it imports them
directly), so the fan-out, the channel gating and the in-app write are the real
code; only the sockets are fabricated.
"""


import uuid

import pytest

from app.messaging import dispatcher
from app.messaging.inapp import Notification
from app.messaging.push import DeviceToken

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
ALICE, BOB = uuid.uuid4(), uuid.uuid4()


class _Recorder:
    """What each fabricated channel was asked to deliver."""

    def __init__(self):
        self.email: list = []
        self.push: list = []
        self.webhook: list = []
        self.rendered: list = []


@pytest.fixture
def channels(monkeypatch):
    """Every outbound channel, fabricated, plus a webhook that is configured.

    Enabled-with-a-url by default because that is the interesting case: a
    dispatcher that quietly skipped it would otherwise pass every test here.
    """
    rec = _Recorder()

    async def send_email(db, to, subject, html, tenant_id):
        rec.email.append((list(to), subject, html, tenant_id))

    async def send_push(db, tokens, title, body, data, tenant_id):
        rec.push.append((sorted(tokens), title, body, data, tenant_id))

    async def send_webhook(url, payload, secret=None):
        rec.webhook.append((url, payload, secret))

    def render(template, ctx):
        rec.rendered.append((template, ctx))
        return f"subject:{template}", f"<b>{ctx.get('message', '')}</b>"

    class _Chan:
        enabled = True

    async def get_channel(db, name, tenant_id):
        return _Chan()

    async def get_config_decrypted(db, name, tenant_id):
        return {"url": "https://hooks.example/ingest", "secret": "s3cr3t"}

    monkeypatch.setattr(dispatcher, "send_email", send_email)
    monkeypatch.setattr(dispatcher, "send_push", send_push)
    monkeypatch.setattr(dispatcher, "send_webhook", send_webhook)
    monkeypatch.setattr(dispatcher, "render", render)
    monkeypatch.setattr(dispatcher, "get_channel", get_channel)
    monkeypatch.setattr(dispatcher, "get_config_decrypted", get_config_decrypted)
    return rec


async def _tokens(db, user_id, *tokens):
    for t in tokens:
        db.add(DeviceToken(user_id=user_id, token=t, platform="android"))
    await db.commit()


async def _inapp(db):
    from sqlalchemy import select

    rows = (await db.execute(select(Notification))).scalars().all()
    return [(r.user_id, r.title) for r in rows]


ALL = ["email", "push", "webhook"]


async def _notify_all(db, **kw):
    await dispatcher.notify(
        db,
        user_ids=[ALICE, BOB],
        title="Gate forced",
        body="north gate",
        channels=ALL,
        email_to=["ops@example.com"],
        tenant_id=TENANT,
        **kw,
    )


# ── the fan-out reaches everything when nothing is broken ────────────────────


async def test_every_requested_channel_is_delivered_and_the_bell_always_rings(db, channels):
    # The control for every isolation test below: without it, "the other channels
    # still ran" would also pass against a dispatcher that ran none of them.
    await _tokens(db, ALICE, "tok-a1", "tok-a2")
    await _tokens(db, BOB, "tok-b1")
    await _notify_all(db)

    assert len(channels.email) == 1
    assert channels.push[0][0] == ["tok-a1", "tok-a2", "tok-b1"]
    assert channels.webhook[0][0] == "https://hooks.example/ingest"
    assert sorted(u for u, _ in await _inapp(db)) == sorted([ALICE, BOB])


async def test_the_in_app_record_is_written_even_when_no_channel_is_asked_for(db, channels):
    # The bell is the one channel that is always on — it is what an operator scrolls
    # back through, and the only delivery that does not depend on tenant config.
    await dispatcher.notify(db, user_ids=[ALICE], title="Quiet alarm", tenant_id=TENANT)
    assert await _inapp(db) == [(ALICE, "Quiet alarm")]
    assert (channels.email, channels.push, channels.webhook) == ([], [], [])


# ── one broken channel, three that still deliver ─────────────────────────────


async def test_a_misconfigured_email_server_does_not_swallow_push_and_webhook(
    db, channels, monkeypatch
):
    # The commonest real failure: SMTP credentials that stopped working. Without the
    # per-channel isolation this raises out of _notify_email and the two deliveries
    # after it never happen — for every notification, until someone fixes SMTP.
    async def boom(*a, **kw):
        raise RuntimeError("SMTP 535 authentication failed")

    monkeypatch.setattr(dispatcher, "send_email", boom)
    await _tokens(db, ALICE, "tok-a1")
    await _notify_all(db)

    assert channels.push, "email took push down with it"
    assert channels.webhook, "email took the webhook down with it"
    assert await _inapp(db)


async def test_a_webhook_that_is_down_does_not_swallow_email_and_push(db, channels, monkeypatch):
    async def boom(*a, **kw):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(dispatcher, "send_webhook", boom)
    await _tokens(db, ALICE, "tok-a1")
    await _notify_all(db)

    assert channels.email
    assert channels.push
    assert await _inapp(db)


async def test_a_push_failure_does_not_swallow_email_and_webhook(db, channels, monkeypatch):
    async def boom(*a, **kw):
        raise RuntimeError("FCM 401 invalid server key")

    monkeypatch.setattr(dispatcher, "send_push", boom)
    await _tokens(db, ALICE, "tok-a1")
    await _notify_all(db)

    assert channels.email
    assert channels.webhook
    assert await _inapp(db)


async def test_a_template_that_will_not_render_costs_the_email_and_nothing_else(
    db, channels, monkeypatch
):
    # A template is operator-authored, so a bad one is a routine event — and it is
    # raised inside the email branch, one line before the send. Push and webhook
    # carry no template at all and must not be affected by it.
    def boom(template, ctx):
        raise KeyError("severity")

    monkeypatch.setattr(dispatcher, "render", boom)
    await _tokens(db, ALICE, "tok-a1")
    await _notify_all(db, template="gate_breach", template_ctx={})

    assert channels.email == []
    assert channels.push
    assert channels.webhook


async def test_one_users_in_app_row_failing_does_not_cost_the_other_users_or_the_channels(
    db, channels, monkeypatch
):
    # The in-app write is per user and each one is isolated separately, because a
    # single bad user id would otherwise cost every OTHER recipient their bell AND
    # every outbound channel — the notification would reach nobody.
    real = dispatcher.inapp.create_notification
    seen: list = []

    async def flaky(db_, uid, title, body=None):
        seen.append(uid)
        if uid == ALICE:
            raise RuntimeError("row rejected")
        return await real(db_, uid, title, body)

    monkeypatch.setattr(dispatcher.inapp, "create_notification", flaky)
    await _tokens(db, BOB, "tok-b1")
    await _notify_all(db)

    assert seen == [ALICE, BOB], "the loop stopped at the first failing user"
    assert await _inapp(db) == [(BOB, "Gate forced")]
    assert channels.email
    assert channels.push
    assert channels.webhook


async def test_notify_never_raises_into_the_scenario_that_called_it(db, channels, monkeypatch):
    # The whole point of the try/except walls: a notification is a side effect of
    # something more important (an alarm being raised, a job finishing). It must
    # never be the reason that thing fails.
    async def boom(*a, **kw):
        raise RuntimeError("everything is on fire")

    for name in ("send_email", "send_push", "send_webhook", "get_channel"):
        monkeypatch.setattr(dispatcher, name, boom)
    monkeypatch.setattr(dispatcher.inapp, "create_notification", boom)

    await _tokens(db, ALICE, "tok-a1")
    await _notify_all(db)  # no exception is the assertion


# ── which channel runs at all ────────────────────────────────────────────────


async def test_a_channel_that_was_not_asked_for_is_not_sent(db, channels):
    await _tokens(db, ALICE, "tok-a1")
    await dispatcher.notify(
        db, user_ids=[ALICE], title="t", body="b", channels=["email"],
        email_to=["ops@example.com"], tenant_id=TENANT,
    )
    assert channels.email
    assert (channels.push, channels.webhook) == ([], [])


async def test_email_without_a_recipient_is_skipped_rather_than_sent_to_nobody(db, channels):
    # An SMTP send with an empty recipient list is either an error at the server or
    # a silently accepted message that reaches no one; neither is worth doing.
    await dispatcher.notify(
        db, user_ids=[ALICE], title="t", channels=["email"], email_to=[], tenant_id=TENANT
    )
    assert channels.email == []


async def test_push_with_no_registered_device_does_not_call_fcm(db, channels):
    # Every user without the mobile app would otherwise mean an FCM request with an
    # empty token list on every single notification.
    await dispatcher.notify(
        db, user_ids=[ALICE], title="t", channels=["push"], tenant_id=TENANT
    )
    assert channels.push == []


async def test_push_goes_only_to_the_targeted_users_devices(db, channels):
    # The tokens are looked up by user id. A lookup that lost its filter would push
    # one tenant's alarm to every registered device in the deployment.
    await _tokens(db, ALICE, "tok-a1")
    await _tokens(db, BOB, "tok-b1")
    await dispatcher.notify(
        db, user_ids=[ALICE], title="t", body="b", channels=["push"], tenant_id=TENANT
    )
    assert channels.push[0][0] == ["tok-a1"]


async def test_a_disabled_webhook_channel_is_not_posted_to(db, channels, monkeypatch):
    # Disabling the channel is how an operator turns it off; a dispatcher that only
    # checked for the row's existence would keep posting to a URL they revoked.
    class _Off:
        enabled = False

    async def get_channel(db_, name, tenant_id):
        return _Off()

    monkeypatch.setattr(dispatcher, "get_channel", get_channel)
    await _notify_all(db)
    assert channels.webhook == []
    assert channels.email, "the other channels must be unaffected"


async def test_a_webhook_with_no_url_configured_is_skipped_and_not_posted_to_nothing(
    db, channels, monkeypatch
):
    async def no_url(db_, name, tenant_id):
        return {"secret": "s3cr3t"}

    monkeypatch.setattr(dispatcher, "get_config_decrypted", no_url)
    await _notify_all(db)
    assert channels.webhook == []


async def test_an_unconfigured_webhook_channel_is_skipped(db, channels, monkeypatch):
    async def missing(db_, name, tenant_id):
        return None

    monkeypatch.setattr(dispatcher, "get_channel", missing)
    await _notify_all(db)
    assert channels.webhook == []


# ── what each channel is handed ──────────────────────────────────────────────


async def test_each_channel_is_told_which_tenants_config_to_send_through(db, channels):
    # Omitting the tenant falls back to the PLATFORM config, which is silently wrong
    # for a tenant that configured its own SMTP, FCM project or webhook: the message
    # goes out, from the wrong account, and nothing reports it.
    await _tokens(db, ALICE, "tok-a1")
    await _notify_all(db)
    assert channels.email[0][3] == TENANT
    assert channels.push[0][4] == TENANT


async def test_a_named_template_supplies_the_subject_and_body(db, channels):
    await _notify_all(db, template="gate_breach", template_ctx={"message": "north gate"})
    assert channels.rendered == [("gate_breach", {"message": "north gate"})]
    _to, subject, html, _tid = channels.email[0]
    assert (subject, html) == ("subject:gate_breach", "<b>north gate</b>")


async def test_without_a_template_the_title_and_body_are_sent_as_they_are(db, channels):
    await _notify_all(db)
    _to, subject, html, _tid = channels.email[0]
    assert subject == "Gate forced"
    assert "north gate" in html
    assert channels.rendered == [], "no template was named; none should have been rendered"


async def test_the_webhook_payload_names_the_recipients_and_carries_the_signing_secret(
    db, channels
):
    # The receiving system decides what to do with an alarm from the subject and the
    # recipients, and it authenticates the POST with the shared secret — a payload
    # that lost either is accepted by nothing.
    await _notify_all(db)
    _url, payload, secret = channels.webhook[0]
    assert payload["title"] == "Gate forced"
    assert sorted(payload["user_ids"]) == sorted([str(ALICE), str(BOB)])
    assert secret == "s3cr3t"
