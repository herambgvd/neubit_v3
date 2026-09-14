"""WHICH credential opens a webhook — the receiver's auth_type dispatch.

``POST /ingest/hooks/{slug}`` carries no JWT. The only thing standing between an
anonymous caller and a published event is ``verify_inbound``'s dispatch on the
webhook's own ``auth_type``, so the fact worth holding is not "a good credential
is accepted" — it is WHICH scheme a given configuration accepts and, far more
importantly, which ones it must refuse.

The refusals are the tests. A verifier that consults one more header than it
should, or a dispatch that stops failing closed on a type it does not know, is a
one-line change that every happy-path test in this suite still passes:

  * ``bearer`` must not also read ``X-API-Key``. ``api_key`` deliberately reads
    both (a token in either place); the reverse is not true, and collapsing the
    two verifiers into one "helpful" reader would silently widen every bearer
    webhook to a second header the operator never configured.
  * ``basic`` must compare the USERNAME as well as the password — the username is
    half the credential, and dropping the compare leaves a webhook that any
    username opens.
  * ``hmac`` must not accept the shared secret presented as a token. The secret is
    stored REVERSIBLY for hmac (the signature has to be recomputed), so a verifier
    that fell back to a token comparison would turn the one recoverable secret in
    the table into a bearer key.
  * an ``auth_type`` this build does not know must FAIL CLOSED. A row can carry
    one after a downgrade or a half-finished migration, and the alternative to a
    401 is an open receiver.

Route-level, the same way test_public_receiver.py does it: rows built directly,
the real router, the real ``verify_inbound``.
"""

from __future__ import annotations

import base64
import uuid

import pytest

from conftest import _client
from app.ingest.models import IngestCategory, IngestEventLog, Webhook
from app.ingest.security import store_secret

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
SECRET = "correct-horse-battery-staple"
USER = "sender"


async def _webhook(session, *, auth_type, secret=SECRET, username=None, method="post"):
    """A webhook whose secret is encoded exactly the way the config API encodes it.

    Through ``store_secret``, not a literal: hmac is stored reversibly encrypted
    and everything else salted-hashed, and a test that hand-rolled either would
    stop testing the thing the receiver actually reads.
    """
    cat = IngestCategory(tenant_id=TENANT, name=f"cat-{uuid.uuid4().hex[:6]}", target_domain="ingest")
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    wh = Webhook(
        tenant_id=TENANT,
        category_id=cat.id,
        name="hook",
        slug=f"s-{uuid.uuid4().hex[:8]}",
        request_method=method,
        auth_type=auth_type,
        auth_username=username,
        auth_secret_hash=store_secret(TENANT, auth_type, secret) if secret else None,
        is_active=True,
    )
    session.add(wh)
    await session.commit()
    await session.refresh(wh)
    return wh


def _basic(user: str, password: str) -> dict:
    raw = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {"Authorization": f"Basic {raw}"}


async def _post(app, wh, headers=None):
    async with _client(app) as c:
        return await c.post(f"/ingest/hooks/{wh.slug}", json={"temp": 21}, headers=headers or {})


# ── bearer vs api_key: the asymmetry is deliberate ───────────────────────────


async def test_an_api_key_webhook_takes_the_token_in_either_place(app, session):
    # Both are configured behaviour — senders put an API key in an Authorization
    # header as often as in X-API-Key — so losing either branch breaks live
    # integrations that were never asked to change.
    wh = await _webhook(session, auth_type="api_key")
    assert (await _post(app, wh, {"Authorization": f"Bearer {SECRET}"})).status_code == 202
    assert (await _post(app, wh, {"X-API-Key": SECRET})).status_code == 202


async def test_a_bearer_webhook_refuses_the_same_secret_sent_as_an_api_key_header(app, session):
    # The half that is NOT symmetric. api_key reads two headers; bearer reads one.
    # Unifying the two verifiers "because they both compare a hash" would widen
    # every bearer webhook to a header its operator never configured, and no
    # happy-path test would notice.
    wh = await _webhook(session, auth_type="bearer")
    assert (await _post(app, wh, {"X-API-Key": SECRET})).status_code == 401
    assert (await _post(app, wh, {"Authorization": f"Bearer {SECRET}"})).status_code == 202


async def test_a_bearer_webhook_refuses_a_basic_header_carrying_the_token(app, session):
    # The other way a "be liberal in what you accept" edit gets in: reading the
    # password half of a Basic header as a token.
    wh = await _webhook(session, auth_type="bearer")
    assert (await _post(app, wh, _basic("anyone", SECRET))).status_code == 401


# ── basic: the username is half the credential ───────────────────────────────


async def test_a_basic_webhook_checks_the_username_and_not_only_the_password(app, session):
    wh = await _webhook(session, auth_type="basic", username=USER)
    assert (await _post(app, wh, _basic(USER, SECRET))).status_code == 202
    # Right password, wrong user. If the username compare is dropped the webhook
    # is opened by a credential the operator never issued.
    assert (await _post(app, wh, _basic("someone-else", SECRET))).status_code == 401


async def test_a_basic_webhook_refuses_a_bearer_token_carrying_the_password(app, session):
    wh = await _webhook(session, auth_type="basic", username=USER)
    assert (await _post(app, wh, {"Authorization": f"Bearer {SECRET}"})).status_code == 401


async def test_a_basic_header_that_is_not_decodable_is_refused_rather_than_crashing(app, session):
    # A 500 here is a 500 on an internet-facing unauthenticated route, and the
    # generic 401 is what keeps a caller from learning it reached a real webhook.
    wh = await _webhook(session, auth_type="basic", username=USER)
    assert (await _post(app, wh, {"Authorization": "Basic !!!not-base64!!!"})).status_code == 401
    # Decodable, but no colon — no username/password to compare at all.
    nocolon = base64.b64encode(b"justuser").decode()
    assert (await _post(app, wh, {"Authorization": f"Basic {nocolon}"})).status_code == 401


# ── hmac: the one secret that can be recovered must stay a signature key ─────


async def test_an_hmac_webhook_refuses_the_raw_secret_presented_as_a_token(app, session):
    # hmac secrets are stored reversibly BECAUSE the signature must be recomputed.
    # That makes them the only secrets in the table an attacker with the row could
    # use directly, so the verifier must never accept one as a bearer/api key.
    wh = await _webhook(session, auth_type="hmac")
    assert (await _post(app, wh, {"Authorization": f"Bearer {SECRET}"})).status_code == 401
    assert (await _post(app, wh, {"X-API-Key": SECRET})).status_code == 401
    assert (await _post(app, wh, _basic(USER, SECRET))).status_code == 401


async def test_an_hmac_webhook_refuses_a_signature_under_another_algorithm(app, session):
    # "sha1=<hex>" is a real shape (the older GitHub header). Accepting the prefix
    # without checking it would let a sender downgrade the algorithm by label.
    wh = await _webhook(session, auth_type="hmac")
    assert (await _post(app, wh, {"X-Signature": "sha1=" + "0" * 40})).status_code == 401


# ── the dispatch itself ──────────────────────────────────────────────────────


@pytest.mark.parametrize("auth_type", ["api_key", "basic", "bearer", "hmac"])
async def test_no_configured_scheme_lets_an_unauthenticated_caller_through(
    app, session, auth_type
):
    # The whole matrix in one line: a webhook that requires anything at all must
    # refuse a request that carries nothing.
    wh = await _webhook(session, auth_type=auth_type, username=USER)
    assert (await _post(app, wh)).status_code == 401


async def test_auth_type_none_is_the_only_one_that_accepts_a_bare_request(app, session):
    # The control for the parametrized refusals above — without it they would all
    # pass against a receiver that had stopped accepting anything.
    wh = await _webhook(session, auth_type="none", secret=None)
    assert (await _post(app, wh)).status_code == 202


async def test_an_auth_type_this_build_does_not_know_fails_closed(app, session):
    # A row can carry one: a downgrade, or a migration that added a type to the
    # enum before the verifier learned it. The dispatch ends in a refusal rather
    # than a fall-through, and that is the difference between a 401 and an open
    # receiver.
    wh = await _webhook(session, auth_type="oauth2")
    assert (await _post(app, wh)).status_code == 401
    assert (await _post(app, wh, {"Authorization": f"Bearer {SECRET}"})).status_code == 401


async def test_a_webhook_whose_secret_is_missing_refuses_instead_of_waving_callers_past(
    app, session
):
    # "Nothing to compare against" must not read as "nothing to check". A row can
    # reach this state through a failed rotation, and an api_key webhook that
    # accepts every caller because its hash is NULL is the worst version of it.
    for auth_type in ("api_key", "bearer", "hmac"):
        wh = await _webhook(session, auth_type=auth_type, secret=None)
        assert (await _post(app, wh, {"X-API-Key": SECRET})).status_code == 401
        assert (await _post(app, wh, {"Authorization": f"Bearer {SECRET}"})).status_code == 401


# ── what the operator is left with after a refusal ───────────────────────────


async def test_a_refused_delivery_is_logged_as_an_auth_failure_and_publishes_nothing(
    app, session
):
    # The delivery log is the only record of a rejected call, and "why is my
    # integration 401ing" is answered by auth_outcome + error, not by the status
    # code the sender saw.
    wh = await _webhook(session, auth_type="bearer")
    assert (await _post(app, wh, {"Authorization": "Bearer wrong"})).status_code == 401

    from sqlalchemy import select

    rows = list((await session.execute(
        select(IngestEventLog).where(IngestEventLog.webhook_id == wh.id)
    )).scalars().all())
    assert len(rows) == 1
    assert rows[0].auth_outcome == "failed"
    assert rows[0].published is False
    assert rows[0].status == "rejected_auth"
    # The stages after auth must not have run on an unauthorised body.
    assert rows[0].schema_outcome == "skipped"
    assert rows[0].transform_outcome == "skipped"


async def test_a_refusal_never_tells_the_caller_why_it_was_refused(app, session):
    # verify_inbound's reason ("bad token", "bad signature", "missing X-Timestamp",
    # "webhook has no bearer token configured") goes to the delivery log and NOWHERE
    # else. Relaying it to the sender — the obvious "make this easier to debug"
    # edit — hands an anonymous caller which scheme a slug uses and how close a
    # guess came.
    wh = await _webhook(session, auth_type="hmac")
    for headers in (
        {"Authorization": f"Bearer {SECRET}"},
        {"X-Signature": "sha256=" + "0" * 64},
        {},
    ):
        r = await _post(app, wh, headers)
        assert r.status_code == 401
        body = r.text.lower()
        for leak in ("signature", "bearer", "hmac", "secret", "timestamp", "configured"):
            assert leak not in body, f"the 401 body named {leak!r}: {r.text}"
