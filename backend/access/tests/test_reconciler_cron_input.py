"""A reconcile schedule that cannot fire must not be storable.

`app/access/scheduler.py` skips a cron it cannot use, and that is the second line
of defence. The first is here: a schedule accepted at save time and then silently
never fired is exactly the failure the scheduler work exists to end — the column
held "0 3 * * *" on every controller for months and nothing ran it.

The six- and seven-field cases are the ones worth the file. They are not typos to
croniter: it accepts them and reads the extra LEADING field as SECONDS, so
`* * * * * *` means a full pull against that controller every second, forever.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, _client, auth

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
MANAGE = ["access.read", "access.manage"]


def _instance_body(**kw):
    body = {
        "name": f"ctrl-{uuid.uuid4().hex[:6]}",
        "base_url": "https://controller.example",
        "brand": "dds",
        "auth_type": "basic",
        "username": "svc",
    }
    body.update(kw)
    return body


@pytest.mark.parametrize(
    "cron",
    ["not a cron", "0 3 * *", "99 99 * * *", "* * * * * *", "* * * * * * *"],
)
async def test_a_bad_cron_cannot_be_saved(app, cron):
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json=_instance_body(reconciler_cron=cron),
        )
    assert r.status_code == 422, r.text
    assert "cron" in r.text.lower(), r.text


@pytest.mark.parametrize("cron", ["0 3 * * *", "*/15 * * * *", "0 */6 * * 1-5"])
async def test_a_real_cron_is_accepted(app, cron):
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/access/instances",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json=_instance_body(reconciler_cron=cron),
        )
    assert r.status_code == 201, r.text
    assert r.json()["reconciler_cron"] == cron


async def test_a_bad_cron_cannot_be_patched_in_either(app):
    """The update path is a second door to the same column."""
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/instances",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json=_instance_body(),
        )
        assert made.status_code == 201, made.text
        r = await c.patch(
            f"{PREFIX}/access/instances/{made.json()['id']}",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"reconciler_cron": "* * * * * *"},
        )
    assert r.status_code == 422, r.text


async def test_an_empty_cron_turns_the_schedule_off(app):
    """The column's server_default is "0 3 * * *", so a NULL on create is omitted
    from the INSERT and the database fills the nightly schedule back in. An
    operator clearing the field would have got nightly reconciles anyway — which
    did not matter while nothing fired them, and does now."""
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/instances",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json=_instance_body(reconciler_cron=""),
        )
    assert made.status_code == 201, made.text
    assert made.json()["reconciler_cron"] == "", made.text


async def test_the_schedule_can_be_turned_off_afterwards(app):
    """`update` uses exclude_none, so folding "" into None would make clearing
    unreachable on the PATCH path too."""
    async with _client(app) as c:
        made = await c.post(
            f"{PREFIX}/access/instances",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json=_instance_body(reconciler_cron="0 3 * * *"),
        )
        assert made.json()["reconciler_cron"] == "0 3 * * *"
        cleared = await c.patch(
            f"{PREFIX}/access/instances/{made.json()['id']}",
            headers=auth(tenant_id=TENANT, permissions=MANAGE),
            json={"reconciler_cron": ""},
        )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["reconciler_cron"] == "", cleared.text


async def test_a_blank_cron_is_not_scheduled(app):
    """The two halves have to agree: what the API stores for "off" is what the
    scheduler reads as "off"."""
    import datetime as dt

    from app.access.scheduler import Candidate, due_instances

    off = Candidate("i1", "", dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc))
    assert due_instances([off], dt.datetime.now(dt.timezone.utc)) == []
