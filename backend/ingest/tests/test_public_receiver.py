"""The public receiver is unauthenticated and internet-facing.

Two things it used to do on behalf of an anonymous caller: write a database row
before authenticating, and read an unbounded body. Between them, one request could
cost 64 KB of storage that nothing ever pruned, at whatever rate the edge allowed.
"""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid

import pytest
from sqlalchemy import func, select

from conftest import _client
from app.ingest.models import IngestCategory, IngestEventLog, Webhook

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
SECRET = "shhh-secret"


async def _webhook(session, *, auth_type="none", secret_enc=None, max_age=None, active=True):
    cat = IngestCategory(tenant_id=TENANT, name="cat", target_domain="ingest")
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    wh = Webhook(
        tenant_id=TENANT,
        category_id=cat.id,
        name="hook",
        slug=f"s-{uuid.uuid4().hex[:8]}",
        request_method="post",
        auth_type=auth_type,
        auth_secret_hash=secret_enc,
        hmac_max_age_seconds=max_age,
        is_active=active,
    )
    session.add(wh)
    await session.commit()
    await session.refresh(wh)
    return wh


async def _log_count(session) -> int:
    return int(await session.scalar(select(func.count()).select_from(IngestEventLog)) or 0)


async def test_an_unknown_slug_writes_no_row(app, session):
    """The anonymous unbounded write. The attempt is still counted and logged."""
    before = await _log_count(session)
    async with _client(app) as c:
        r = await c.post("/ingest/hooks/does-not-exist", json={"payload": "x" * 1000})
    assert r.status_code == 401
    assert await _log_count(session) == before


async def test_an_unknown_slug_is_counted(app, session):
    """An operator still needs to see someone hammering a slug that is gone."""
    from app.ingest.metrics import unknown_slug_attempts

    before = unknown_slug_attempts.value
    async with _client(app) as c:
        await c.post("/ingest/hooks/nope", json={})
    assert unknown_slug_attempts.value == before + 1


async def test_a_disabled_webhook_does_write_a_row(app, session):
    """This one is bounded by the number of webhooks that exist, and 'why did my
    integration stop' is the question the log is for."""
    wh = await _webhook(session, active=False)
    before = await _log_count(session)
    async with _client(app) as c:
        r = await c.post(f"/ingest/hooks/{wh.slug}", json={})
    assert r.status_code == 401
    assert await _log_count(session) == before + 1


async def test_an_unknown_and_a_disabled_slug_look_the_same_to_the_caller(app, session):
    """Otherwise the response tells an attacker which slugs are real."""
    wh = await _webhook(session, active=False)
    async with _client(app) as c:
        unknown = await c.post("/ingest/hooks/definitely-not-real", json={})
        disabled = await c.post(f"/ingest/hooks/{wh.slug}", json={})
    assert unknown.status_code == disabled.status_code == 401
    assert unknown.json() == disabled.json()


async def test_an_oversized_body_is_refused(app, session):
    from app.ingest import router as router_mod

    wh = await _webhook(session)
    async with _client(app) as c:
        r = await c.post(
            f"/ingest/hooks/{wh.slug}",
            content=b"x" * (router_mod.MAX_INBOUND_BODY_BYTES + 1),
            headers={"content-type": "application/json"},
        )
    assert r.status_code == 413


async def test_an_ordinary_event_is_still_accepted(app, session):
    """Every refusal test above would pass against a receiver that refuses
    everything."""
    wh = await _webhook(session)
    async with _client(app) as c:
        r = await c.post(f"/ingest/hooks/{wh.slug}", json={"temp": 21})
    assert r.status_code == 202, r.text
    assert r.json()["accepted"] is True
    assert await _log_count(session) == 1
