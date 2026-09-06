"""The twelve routes no test had ever named.

Alert formats, notification templates, threat levels and available-transitions.
Everything else in this service was reachable from some test by name; these were
not, so a 500 in any of them was something only a customer would find.

Each is asserted for the two things worth asserting on a tenant-scoped CRUD
surface: that it works, and that another tenant cannot see or change the row. The
second matters more here than usual — a notification TEMPLATE carries the body
text sent to a customer's people, and a threat LEVEL is a statement about a
building.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()

SOP_RW = ["workflow.sop.read", "workflow.sop.create", "workflow.sop.update",
          "workflow.sop.delete"]
NOTIF_RW = ["workflow.notification.read", "workflow.notification.create",
            "workflow.notification.update", "workflow.notification.delete"]
THREAT_RW = ["workflow.threat_level.read", "workflow.threat_level.update"]


def _fmt(**kw):
    body = {"alert_code": f"AC-{uuid.uuid4().hex[:6]}", "name": "Perimeter breach"}
    body.update(kw)
    return body


# ── alert formats ────────────────────────────────────────────────────────────

async def test_alert_format_round_trip(app):
    async with client(app) as c:
        empty = await c.get(
            f"{PREFIX}/workflow/alert-formats",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
        )
        assert empty.status_code == 200, empty.text
        assert empty.json()["items"] == []

        made = await c.post(
            f"{PREFIX}/workflow/alert-formats",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
            json=_fmt(severity="high", color_code="#FF0000"),
        )
        assert made.status_code == 201, made.text
        fid = made.json()["format_id"]

        got = await c.get(
            f"{PREFIX}/workflow/alert-formats/{fid}",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
        )
        assert got.status_code == 200, got.text
        assert got.json()["severity"] == "high"

        patched = await c.patch(
            f"{PREFIX}/workflow/alert-formats/{fid}",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
            json={"severity": "low"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["severity"] == "low"
        # A partial update leaves the rest alone.
        assert patched.json()["name"] == "Perimeter breach"

        gone = await c.delete(
            f"{PREFIX}/workflow/alert-formats/{fid}",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
        )
        assert gone.status_code == 204, gone.text

        after = await c.get(
            f"{PREFIX}/workflow/alert-formats/{fid}",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
        )
        assert after.status_code == 404, after.text


async def test_another_tenant_cannot_see_or_change_an_alert_format(app):
    async with client(app) as c:
        made = await c.post(
            f"{PREFIX}/workflow/alert-formats",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
            json=_fmt(),
        )
        fid = made.json()["format_id"]

        for call in (
            c.get(f"{PREFIX}/workflow/alert-formats/{fid}",
                  headers=auth(tenant_id=TENANT_B, permissions=SOP_RW)),
            c.patch(f"{PREFIX}/workflow/alert-formats/{fid}",
                    headers=auth(tenant_id=TENANT_B, permissions=SOP_RW),
                    json={"severity": "low"}),
            c.delete(f"{PREFIX}/workflow/alert-formats/{fid}",
                     headers=auth(tenant_id=TENANT_B, permissions=SOP_RW)),
        ):
            r = await call
            assert r.status_code == 404, r.text

        listed = await c.get(
            f"{PREFIX}/workflow/alert-formats",
            headers=auth(tenant_id=TENANT_B, permissions=SOP_RW),
        )
        assert listed.json()["items"] == [], listed.text

        # and it is still A's.
        still = await c.get(
            f"{PREFIX}/workflow/alert-formats/{fid}",
            headers=auth(tenant_id=TENANT_A, permissions=SOP_RW),
        )
        assert still.status_code == 200, still.text


# ── notification templates ───────────────────────────────────────────────────

async def test_notification_template_round_trip(app):
    async with client(app) as c:
        made = await c.post(
            f"{PREFIX}/workflow/notifications/templates",
            headers=auth(tenant_id=TENANT_A, permissions=NOTIF_RW),
            json={"name": "Escalation", "body": "Incident {{id}} needs attention"},
        )
        assert made.status_code == 201, made.text
        tid = made.json()["template_id"]
        assert made.json()["channel_type"] == "email"

        listed = await c.get(
            f"{PREFIX}/workflow/notifications/templates",
            headers=auth(tenant_id=TENANT_A, permissions=NOTIF_RW),
        )
        assert [t["template_id"] for t in listed.json()] == [tid]

        patched = await c.patch(
            f"{PREFIX}/workflow/notifications/templates/{tid}",
            headers=auth(tenant_id=TENANT_A, permissions=NOTIF_RW),
            json={"subject": "Action required"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["subject"] == "Action required"
        assert patched.json()["body"] == "Incident {{id}} needs attention"

        gone = await c.delete(
            f"{PREFIX}/workflow/notifications/templates/{tid}",
            headers=auth(tenant_id=TENANT_A, permissions=NOTIF_RW),
        )
        assert gone.status_code == 204, gone.text


async def test_another_tenant_cannot_read_a_notification_template(app):
    """The body is the text sent to a customer's people."""
    async with client(app) as c:
        made = await c.post(
            f"{PREFIX}/workflow/notifications/templates",
            headers=auth(tenant_id=TENANT_A, permissions=NOTIF_RW),
            json={"name": "Escalation", "body": "SECRET-BODY-TEXT"},
        )
        tid = made.json()["template_id"]

        listed = await c.get(
            f"{PREFIX}/workflow/notifications/templates",
            headers=auth(tenant_id=TENANT_B, permissions=NOTIF_RW),
        )
        assert listed.json() == [], listed.text
        assert "SECRET-BODY-TEXT" not in listed.text

        refused = await c.patch(
            f"{PREFIX}/workflow/notifications/templates/{tid}",
            headers=auth(tenant_id=TENANT_B, permissions=NOTIF_RW),
            json={"body": "changed"},
        )
        assert refused.status_code == 404, refused.text


# ── threat levels ────────────────────────────────────────────────────────────

async def test_threat_level_can_be_set_and_read_back(app):
    async with client(app) as c:
        empty = await c.get(
            f"{PREFIX}/workflow/threat-levels",
            headers=auth(tenant_id=TENANT_A, permissions=THREAT_RW),
        )
        assert empty.status_code == 200, empty.text
        assert empty.json() == []

        put = await c.put(
            f"{PREFIX}/workflow/threat-levels",
            headers=auth(tenant_id=TENANT_A, permissions=THREAT_RW),
            json={"level": "high", "reason": "credible report"},
        )
        assert put.status_code == 200, put.text
        assert put.json()["level"] == "high"
        assert put.json()["reason"] == "credible report"

        listed = await c.get(
            f"{PREFIX}/workflow/threat-levels",
            headers=auth(tenant_id=TENANT_A, permissions=THREAT_RW),
        )
        assert [t["level"] for t in listed.json()] == ["high"]


async def test_a_threat_level_is_not_another_tenants_business(app):
    """It is a statement about one customer's buildings."""
    async with client(app) as c:
        await c.put(
            f"{PREFIX}/workflow/threat-levels",
            headers=auth(tenant_id=TENANT_A, permissions=THREAT_RW),
            json={"level": "high", "reason": "credible report"},
        )
        listed = await c.get(
            f"{PREFIX}/workflow/threat-levels",
            headers=auth(tenant_id=TENANT_B, permissions=THREAT_RW),
        )
    assert listed.status_code == 200, listed.text
    assert listed.json() == [], listed.text


# ── available transitions ────────────────────────────────────────────────────

async def test_available_transitions_for_an_unknown_instance_is_404(app):
    """Not an empty list. "This instance has no next step" and "there is no such
    instance" are different answers and a console shows them differently."""
    async with client(app) as c:
        r = await c.get(
            f"{PREFIX}/workflow/instances/{uuid.uuid4()}/available-transitions",
            headers=auth(tenant_id=TENANT_A, permissions=["workflow.instance.read"]),
        )
    assert r.status_code == 404, r.text
