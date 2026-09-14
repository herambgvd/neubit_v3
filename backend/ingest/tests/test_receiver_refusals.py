"""What an ANONYMOUS caller learns from a refusal, and what it can make us write.

Everything past ``verify_inbound`` is covered elsewhere (test_receiver_auth_dispatch
for which credential opens a webhook, test_receiver_pipeline for what a delivery
becomes). This file is about the other side of the gate — the requests that never
get in — because the receiver's two promises to a stranger are both invisible in a
happy-path suite:

  * A REFUSAL TELLS THE CALLER NOTHING. The slug is the only secret protecting an
    unlisted webhook from being probed at all, and the service docstring says this
    receiver leaks nothing. It leaked: an unknown slug answered "invalid webhook"
    and a real slug with a bad credential answered "unauthorized", so an anonymous
    caller could walk a wordlist and read the slug table off the difference. The
    assertions below compare the WHOLE response — status, body, headers — rather
    than the message alone, because the next version of this leak is a
    ``WWW-Authenticate`` header or an extra ``details`` key, not a sentence.

  * A REFUSAL DOES NOT LET THE CALLER SIZE OUR DISK. ``IngestEventLog`` rows hold
    up to 64 KB of the caller's own text and ingest runs no retention sweep. An
    unknown slug already wrote nothing. Two other pre-auth paths still wrote a
    full row per request to anyone who could guess a slug: the method mismatch,
    which ran BEFORE auth, and the auth failure itself. The method check now runs
    after auth — the row is for the sender getting the verb wrong, so the
    credential buys it — and the refusals that still must leave a trace keep the
    who/where/when/why and drop the body. The row is bounded; the trail survives.

Route-level, through the real router and the real ``verify_inbound``.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from conftest import _client
from app.ingest.models import IngestCategory, IngestEventLog, Webhook
from app.ingest.security import store_secret

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
SECRET = "correct-horse-battery-staple"


async def _webhook(session, *, auth_type="api_key", method="post", is_active=True):
    cat = IngestCategory(
        tenant_id=TENANT, name=f"cat-{uuid.uuid4().hex[:6]}", target_domain="ingest"
    )
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
        auth_secret_hash=store_secret(TENANT, auth_type, SECRET) if auth_type != "none" else None,
        is_active=is_active,
    )
    session.add(wh)
    await session.commit()
    await session.refresh(wh)
    return wh


def _fingerprint(response) -> tuple:
    """Everything a caller can see, minus what is the same on every response.

    ``date`` is wall-clock and ``content-length`` is a function of the body we are
    already comparing, so neither can carry the signal; every other header can,
    which is the point of comparing the set rather than the message.
    """
    headers = {
        k.lower(): v for k, v in response.headers.items()
        if k.lower() not in ("date", "content-length")
    }
    return (response.status_code, response.text, tuple(sorted(headers.items())))


# ── the refusals must be one refusal ─────────────────────────────────────────


async def test_a_bad_credential_is_indistinguishable_from_a_slug_that_does_not_exist(
    app, session
):
    """The oracle itself. Two different sentences here is an enumerable slug table."""
    wh = await _webhook(session)
    async with _client(app) as c:
        real = await c.post(f"/ingest/hooks/{wh.slug}", json={"a": 1},
                            headers={"X-API-Key": "wrong"})
        unknown = await c.post(f"/ingest/hooks/{uuid.uuid4().hex}", json={"a": 1},
                               headers={"X-API-Key": "wrong"})

    assert real.status_code == 401, real.text
    assert _fingerprint(real) == _fingerprint(unknown)


async def test_a_disabled_webhook_is_indistinguishable_from_one_that_never_existed(
    app, session
):
    """A disabled webhook is still a slug that exists, and saying so is the leak."""
    wh = await _webhook(session, auth_type="none", is_active=False)
    async with _client(app) as c:
        disabled = await c.post(f"/ingest/hooks/{wh.slug}", json={"a": 1})
        unknown = await c.post(f"/ingest/hooks/{uuid.uuid4().hex}", json={"a": 1})

    assert disabled.status_code == 401, disabled.text
    assert _fingerprint(disabled) == _fingerprint(unknown)


async def test_the_wrong_verb_on_a_real_slug_looks_like_a_slug_that_does_not_exist(
    app, session
):
    """The third leg, and the one that is easy to reopen.

    A 422 naming ``expected_method`` can only come from a webhook that exists, so
    answering it before the caller is authorised was a slug oracle with a different
    status code. Moving the method check behind auth closed it; putting the check
    back "early, it's cheaper" reopens it.
    """
    wh = await _webhook(session, method="post")
    async with _client(app) as c:
        wrong_verb = await c.get(f"/ingest/hooks/{wh.slug}")
        unknown = await c.get(f"/ingest/hooks/{uuid.uuid4().hex}")

    assert wrong_verb.status_code == 401, wrong_verb.text
    assert _fingerprint(wrong_verb) == _fingerprint(unknown)


# ── the rows an anonymous caller can cause ───────────────────────────────────


async def test_an_unauthenticated_wrong_verb_writes_no_method_row(app, session):
    """The method row is a post-auth row now.

    Before, a stranger sending the wrong verb was answered by the method check and
    never reached auth at all — so the row said ``rejected_method`` and the
    caller's query string went into it. Now the credential is checked first and
    this caller never gets that far.
    """
    wh = await _webhook(session, method="post")
    async with _client(app) as c:
        for _ in range(3):
            r = await c.get(f"/ingest/hooks/{wh.slug}?padding={'x' * 500}")
            assert r.status_code == 401, r.text

    rows = (await session.execute(select(IngestEventLog))).scalars().all()
    assert [r.status for r in rows] == ["rejected_auth"] * 3


@pytest.mark.parametrize(
    "kind, active, headers",
    [
        ("bad credential", True, {"X-API-Key": "wrong"}),
        ("disabled webhook", False, {"X-API-Key": SECRET}),
    ],
)
async def test_a_pre_auth_refusal_records_the_attempt_without_the_callers_body(
    app, session, kind, active, headers
):
    """Both halves at once: the attempt is still visible, and it is a FIXED cost.

    Dropping the row would hide "why did my integration stop" and "someone is
    probing us", which is why neither is dropped. Keeping the payload let an
    anonymous caller choose 64 KB of our disk per request, forever, with nothing
    that expires it — the same reasoning that already removed the unknown-slug row
    outright. Restoring ``raw_payload=raw_stored`` here for debuggability is the
    edit this test exists to stop.
    """
    wh = await _webhook(session, is_active=active)
    async with _client(app) as c:
        r = await c.post(f"/ingest/hooks/{wh.slug}", json={"secret_note": "x" * 5000},
                         headers=headers)
    assert r.status_code == 401, r.text

    row = (await session.execute(select(IngestEventLog))).scalars().one()
    assert row.webhook_id == wh.id          # which webhook
    assert row.source_ip is not None        # from where
    assert row.status == "rejected_auth"    # and why
    assert row.error
    assert row.raw_payload is None
    assert row.raw_truncated is False


async def test_the_sender_who_gets_the_verb_wrong_still_gets_the_row_and_the_reason(
    app, session
):
    """The half that must NOT change.

    "My integration sends GET and gets an error" is the question the delivery log
    exists to answer. Auth bounds who can ask it; it does not delete the answer.
    """
    wh = await _webhook(session, auth_type="api_key", method="post")
    async with _client(app) as c:
        r = await c.get(f"/ingest/hooks/{wh.slug}", headers={"X-API-Key": SECRET})

    assert r.status_code == 422, r.text
    assert r.json()["error"]["details"]["expected_method"] == "POST"

    row = (await session.execute(select(IngestEventLog))).scalars().one()
    assert row.status == "rejected_method"
    assert row.webhook_id == wh.id
    # The credential DID pass — recording it as an auth failure would put this row
    # in the operator's "someone is probing us" filter, where it does not belong.
    assert row.auth_outcome == "ok"


async def test_an_open_webhook_still_accepts_its_configured_verb(app, session):
    """The guard must not be 'refuse everything'."""
    wh = await _webhook(session, auth_type="none", method="get")
    async with _client(app) as c:
        r = await c.get(f"/ingest/hooks/{wh.slug}?temp=21")
    assert r.status_code == 202, r.text
