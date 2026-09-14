"""A secret nobody remembers setting must never become a live credential.

``WebhookCreate`` accepted ``auth_secret`` alongside ``auth_type="none"`` and
``create()`` stored it. Nothing consulted it — auth was off — so it sat in the
column looking exactly like a configured credential. A later PATCH to ``api_key``
or ``bearer`` with no secret in the body then reached ``_auth_update_fields``'
``if not row.auth_secret_hash`` guard, found the column non-null, concluded "the
stored secret is fine, keep it", and promoted a forgotten value to the only thing
guarding a public internet-facing endpoint. Nobody typed it, nobody rotated it,
nobody knows it is live.

Two refusals, because they close different halves:

  * at CREATE, because the request is incoherent and the operator who typed the
    secret almost certainly believes the webhook is protected — answering 201 and
    leaving it wide open is the worse of the two ways to be wrong. This is also
    what keeps "auth_secret_hash is set ⇒ some auth_type consults it" true for
    every row the API can write from here on;
  * at the PATCH, because rows written BEFORE that refusal existed still carry
    one, and the transition off ``none`` is the moment such a row wakes up. A row
    created directly below stands in for them.

Turning auth on is then always an act someone performed knowingly.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.ingest.models import IngestCategory, Webhook
from app.ingest.security import store_secret

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
PERMS = ["ingest.read", "ingest.manage"]
FORGOTTEN = "typed-once-in-2023-and-never-again"


async def _category(session):
    row = IngestCategory(
        tenant_id=TENANT, name=f"c-{uuid.uuid4().hex[:6]}", target_domain="ingest"
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _legacy_open_webhook_carrying_a_secret(session):
    """The pre-fix state, built directly because the API no longer produces it."""
    cat = await _category(session)
    row = Webhook(
        tenant_id=TENANT,
        category_id=cat.id,
        name="hook",
        slug=f"s-{uuid.uuid4().hex[:8]}",
        request_method="post",
        auth_type="none",
        auth_secret_hash=store_secret(TENANT, "none", FORGOTTEN),
        is_active=True,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


def _body(cat_id, **kw):
    return {"category_id": cat_id, "name": "hook", "slug": f"s-{uuid.uuid4().hex[:8]}", **kw}


# ── create: the state is refused where it is born ────────────────────────────


async def test_creating_an_open_webhook_with_a_secret_is_refused(app, session):
    cat = await _category(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/ingest/webhooks",
            json=_body(cat.id, auth_type="none", auth_secret=FORGOTTEN),
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
    assert r.status_code == 422, r.text


async def test_patching_a_webhook_to_open_while_supplying_a_secret_is_refused(app, session):
    """The same incoherent request on the other path. Silently dropping the secret
    would leave the operator believing they had just set one."""
    cat = await _category(session)
    async with _client(app) as c:
        created = await c.post(
            f"{PREFIX}/ingest/webhooks",
            json=_body(cat.id, auth_type="api_key", auth_secret="real-one"),
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
        assert created.status_code == 201, created.text
        r = await c.patch(
            f"{PREFIX}/ingest/webhooks/{created.json()['id']}",
            json={"auth_type": "none", "auth_secret": FORGOTTEN},
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
    assert r.status_code == 422, r.text


# ── patch: the rows that already exist ───────────────────────────────────────


@pytest.mark.parametrize("new_type", ["api_key", "bearer"])
async def test_a_forgotten_secret_is_not_promoted_by_turning_auth_on(app, session, new_type):
    """The whole finding, end to end: enabling auth without naming a secret must
    not silently make the stale one the live key."""
    wh = await _legacy_open_webhook_carrying_a_secret(session)
    async with _client(app) as c:
        r = await c.patch(
            f"{PREFIX}/ingest/webhooks/{wh.id}",
            json={"auth_type": new_type},
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
    assert r.status_code == 422, r.text

    await session.refresh(wh)
    assert wh.auth_type == "none"  # the refusal wrote nothing


async def test_turning_auth_on_with_a_chosen_secret_works_and_leaves_no_second_key(
    app, session
):
    """The way OUT of the legacy state, and the receiver's view of it.

    The refusal above is only correct if there is a way forward: name a secret and
    auth turns on. What must not survive is the stale value as a SECOND accepted
    credential — the column holds one secret, and after a deliberate rotation the
    forgotten one is a 401 like any other guess.
    """
    wh = await _legacy_open_webhook_carrying_a_secret(session)
    async with _client(app) as c:
        await c.patch(
            f"{PREFIX}/ingest/webhooks/{wh.id}",
            json={"auth_type": "bearer"},
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
        # Set auth for real, with a secret someone chose, and the stale one is dead.
        ok = await c.patch(
            f"{PREFIX}/ingest/webhooks/{wh.id}",
            json={"auth_type": "bearer", "auth_secret": "chosen-deliberately"},
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
        assert ok.status_code == 200, ok.text

        stale = await c.post(f"/ingest/hooks/{wh.slug}", json={"a": 1},
                             headers={"Authorization": f"Bearer {FORGOTTEN}"})
        chosen = await c.post(f"/ingest/hooks/{wh.slug}", json={"a": 1},
                              headers={"Authorization": "Bearer chosen-deliberately"})

    assert stale.status_code == 401, stale.text
    assert chosen.status_code == 202, chosen.text


# ── the refusals must not be 'refuse everything' ─────────────────────────────


async def test_an_ordinary_webhook_with_a_real_secret_is_still_created(app, session):
    cat = await _category(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/ingest/webhooks",
            json=_body(cat.id, auth_type="api_key", auth_secret="a-real-key"),
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
    assert r.status_code == 201, r.text
    assert r.json()["has_secret"] is True


async def test_an_open_webhook_with_no_secret_is_still_created(app, session):
    cat = await _category(session)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/ingest/webhooks",
            json=_body(cat.id, auth_type="none"),
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
    assert r.status_code == 201, r.text
    assert r.json()["has_secret"] is False


async def test_rotating_an_existing_credential_still_needs_no_new_type(app, session):
    """A PATCH that touches nothing about auth must keep working — the new guard
    fires on the none→typed transition only."""
    cat = await _category(session)
    async with _client(app) as c:
        created = await c.post(
            f"{PREFIX}/ingest/webhooks",
            json=_body(cat.id, auth_type="api_key", auth_secret="a-real-key"),
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
        assert created.status_code == 201, created.text
        r = await c.patch(
            f"{PREFIX}/ingest/webhooks/{created.json()['id']}",
            json={"name": "renamed"},
            headers=auth(tenant_id=TENANT, permissions=PERMS),
        )
    assert r.status_code == 200, r.text
    assert r.json()["has_secret"] is True
