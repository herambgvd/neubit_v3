"""A captured HMAC request must stop working.

The signature covered the body and nothing else — no timestamp, no nonce — so a
captured request replayed forever, each replay producing a fresh accepted event.
"""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid

import pytest

from conftest import _client
from app.ingest.models import IngestCategory, Webhook
from app.ingest.security import encrypt_secret

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
SECRET = "shhh-secret"


async def _hmac_webhook(session, *, max_age=None):
    cat = IngestCategory(tenant_id=TENANT, name=f"c-{uuid.uuid4().hex[:6]}", target_domain="ingest")
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    wh = Webhook(
        tenant_id=TENANT,
        category_id=cat.id,
        name="hook",
        slug=f"s-{uuid.uuid4().hex[:8]}",
        request_method="post",
        auth_type="hmac",
        auth_secret_hash=encrypt_secret(TENANT, SECRET),
        hmac_max_age_seconds=max_age,
        is_active=True,
    )
    session.add(wh)
    await session.commit()
    await session.refresh(wh)
    return wh


def _sign(body: bytes, stamp: str | None = None) -> str:
    signed = (stamp.encode() + b"." + body) if stamp else body
    return hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()


@pytest.fixture(autouse=True)
def clear_seen():
    from app.ingest.security import _SEEN

    _SEEN.clear()
    yield
    _SEEN.clear()


async def test_a_valid_signature_is_accepted(app, session):
    wh = await _hmac_webhook(session)
    body = b'{"a":1}'
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}", content=body,
            headers={"content-type": "application/json", "X-Signature": _sign(body)},
        )
    assert r.status_code == 202, r.text


async def test_the_same_request_twice_is_refused(app, session):
    """The replay. Also a correct dedup for a genuine retry."""
    wh = await _hmac_webhook(session)
    body = b'{"a":1}'
    headers = {"content-type": "application/json", "X-Signature": _sign(body)}
    async with _client(app) as c:
        first = await c.post(f"/ingest/hooks/{wh.slug}", content=body, headers=headers)
        second = await c.post(f"/ingest/hooks/{wh.slug}", content=body, headers=headers)
    assert first.status_code == 202
    assert second.status_code == 401


async def test_a_different_payload_is_not_a_replay(app, session):
    """Dedup must not block real traffic."""
    wh = await _hmac_webhook(session)
    async with _client(app) as c:
        for value in (1, 2, 3):
            body = f'{{"a":{value}}}'.encode()
            r = await c.post(
                f"/ingest/hooks/{wh.slug}", content=body,
                headers={"content-type": "application/json", "X-Signature": _sign(body)},
            )
            assert r.status_code == 202, r.text


async def test_a_bad_signature_is_refused(app, session):
    wh = await _hmac_webhook(session)
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}", content=b'{"a":1}',
            headers={"content-type": "application/json", "X-Signature": "deadbeef"},
        )
    assert r.status_code == 401


async def test_a_bad_signature_does_not_fill_the_replay_cache(app, session):
    """The cache is only written after the signature verifies, so guesses cannot
    grow it."""
    from app.ingest.security import _SEEN

    wh = await _hmac_webhook(session)
    async with _client(app) as c:
        for i in range(5):
            await c.post(
                f"/ingest/hooks/{wh.slug}", content=b'{"a":1}',
                headers={"content-type": "application/json", "X-Signature": f"{i:064x}"},
            )
    assert len(_SEEN) == 0


# --- the timestamp window --------------------------------------------------


async def test_a_timestamped_webhook_requires_the_header(app, session):
    wh = await _hmac_webhook(session, max_age=300)
    body = b'{"a":1}'
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}", content=body,
            headers={"content-type": "application/json", "X-Signature": _sign(body)},
        )
    assert r.status_code == 401


async def test_a_fresh_timestamped_request_is_accepted(app, session):
    wh = await _hmac_webhook(session, max_age=300)
    body = b'{"a":1}'
    stamp = str(int(time.time()))
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}", content=body,
            headers={
                "content-type": "application/json",
                "X-Timestamp": stamp,
                "X-Signature": _sign(body, stamp),
            },
        )
    assert r.status_code == 202, r.text


async def test_a_stale_timestamp_is_refused(app, session):
    """The protection that does not depend on remembering anything: a capture
    stops working once the window passes."""
    wh = await _hmac_webhook(session, max_age=60)
    body = b'{"a":1}'
    stamp = str(int(time.time()) - 3600)
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}", content=body,
            headers={
                "content-type": "application/json",
                "X-Timestamp": stamp,
                "X-Signature": _sign(body, stamp),
            },
        )
    assert r.status_code == 401


async def test_the_timestamp_is_inside_the_signature(app, session):
    """Otherwise an attacker replays a captured body with a fresh timestamp."""
    wh = await _hmac_webhook(session, max_age=300)
    body = b'{"a":1}'
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}", content=body,
            headers={
                "content-type": "application/json",
                "X-Timestamp": str(int(time.time())),
                # Signed WITHOUT the timestamp — the old shape.
                "X-Signature": _sign(body),
            },
        )
    assert r.status_code == 401
