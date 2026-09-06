"""A platform row is readable by everyone. It is not EDITABLE by everyone.

`kernel.auth.owns()` treats a NULL `tenant_id` as belonging to nobody and
therefore readable by all, while `scoped()` hides it from listings. That is the
right default for a shared catalog a tenant may USE.

Every ownership check in this service used it — 14 `assert_owned` calls, not one
passing `allow_shared=False` — and the helpers they live in are the SAME ones the
update and delete paths use. `SOPService._row` is called by `get`, `update` AND
`delete`.

And a NULL tenant_id is not hypothetical here. `app/workflow/sops/models.py` says
so in as many words: "NULLS NOT DISTINCT because a NULL tenant_id is a real
platform row here".

So any tenant holding `workflow.sop.update` could rewrite — or deactivate — a
platform SOP that every other tenant runs on, by naming its id. Access hit this
exact shape and passes `allow_shared=False` on every by-id path for the same
reason: here, every by-id path is also a write path.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
SOP_RW = ["workflow.sop.read", "workflow.sop.create", "workflow.sop.update",
          "workflow.sop.delete"]
NOTIF_RW = ["workflow.notification.read", "workflow.notification.update",
            "workflow.notification.delete"]


async def _platform_sop(sessionmaker) -> str:
    """A SOP owned by nobody — what a seeded, shared procedure looks like."""
    from app.workflow.sops.models import SOP

    async with sessionmaker() as s:
        row = SOP(tenant_id=None, name="Platform: bomb threat", description="shared")
        s.add(row)
        await s.commit()
        await s.refresh(row)
        return row.sop_id


async def _platform_template(sessionmaker) -> str:
    from app.workflow.notifications.models import NotificationTemplate

    async with sessionmaker() as s:
        row = NotificationTemplate(
            tenant_id=None, name="Platform: escalation", channel_type="email",
            body="shared body",
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)
        return row.template_id


async def test_a_tenant_may_read_a_platform_sop(app, http_sessionmaker):
    """The half that is deliberate — a shared procedure is meant to be usable."""
    sop_id = await _platform_sop(http_sessionmaker)
    async with client(app) as c:
        r = await c.get(
            f"{PREFIX}/workflow/sops/{sop_id}",
            headers=auth(tenant_id=TENANT, permissions=SOP_RW),
        )
    assert r.status_code == 200, r.text


async def test_a_tenant_cannot_edit_a_platform_sop(app, http_sessionmaker):
    """The half that was not. `update` goes through the same `_row` as `get`."""
    sop_id = await _platform_sop(http_sessionmaker)
    async with client(app) as c:
        r = await c.patch(
            f"{PREFIX}/workflow/sops/{sop_id}",
            headers=auth(tenant_id=TENANT, permissions=SOP_RW),
            json={"name": "rewritten by a tenant"},
        )
    assert r.status_code == 404, r.text


async def test_a_tenant_cannot_delete_a_platform_sop(app, http_sessionmaker):
    """`delete` deactivates the row, so every other tenant's procedure stops."""
    sop_id = await _platform_sop(http_sessionmaker)
    async with client(app) as c:
        r = await c.delete(
            f"{PREFIX}/workflow/sops/{sop_id}",
            headers=auth(tenant_id=TENANT, permissions=SOP_RW),
        )
        assert r.status_code == 404, r.text

        # and it is still live for everyone.
        still = await c.get(
            f"{PREFIX}/workflow/sops/{sop_id}",
            headers=auth(tenant_id=TENANT, permissions=SOP_RW),
        )
    assert still.status_code == 200, still.text
    assert still.json()["is_active"] is True, still.text


async def test_a_tenant_cannot_edit_a_platform_notification_template(
    app, http_sessionmaker
):
    """Same helper, same shape — the text sent to other tenants' people."""
    template_id = await _platform_template(http_sessionmaker)
    async with client(app) as c:
        r = await c.patch(
            f"{PREFIX}/workflow/notifications/templates/{template_id}",
            headers=auth(tenant_id=TENANT, permissions=NOTIF_RW),
            json={"body": "rewritten by a tenant"},
        )
    assert r.status_code == 404, r.text
