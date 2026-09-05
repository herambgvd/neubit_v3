"""Broadcasts and the alert inbox — the two places the platform talks to itself.

They are grouped because they are the same shape from opposite ends: a broadcast
is something an operator pushes OUT to tenant consoles, an alert is something the
platform derives and shows the operator. Both are managed from the super-admin
realm (asserted once in ``test_admin_realm_boundary.py``), and both have exactly
one interesting boundary of their own, which is what this file is for.

For broadcasts that boundary is ``GET /broadcasts/active`` — the single route in
either module a tenant may call, and the only unauthenticated one. It decides,
from a token it is not required to have, which announcements a caller may read.
A targeting mistake there does not leak a row so much as broadcast it: a message
addressed to one customer, rendered in every other customer's console.

For alerts the boundary is between super-admins. The alerts themselves are
derived and shared, but "I have read this" and "I have dismissed this" are
per-admin, and a dismissal that applied to everyone would let one operator hide a
critical licence alert from the rest of the team by clicking it away.
"""

from __future__ import annotations

import datetime as dt
import uuid

import httpx
import pytest
import pytest_asyncio

from app.alerts.models import AlertState  # noqa: F401 — create_all
from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.billing.models import Invoice  # noqa: F401 — create_all
from app.broadcasts.models import Broadcast
from app.db.base import get_db
from app.tenancy.models import Tenant
from conftest import make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
ADMIN_BC = f"{PREFIX}/admin/broadcasts"
ALERTS = f"{PREFIX}/admin/alerts"


@pytest.fixture
def app(sessionmaker_):
    application = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    application.dependency_overrides[get_db] = _override_db
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def _auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user, sid='test')}"}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


@pytest_asyncio.fixture
async def world(db):
    """Two tenants with a user each, and TWO super-admins — the second one exists
    only so the per-admin alert state has someone to be isolated from."""
    sa_role = await make_role(db, "Platform", ["*"])
    t_role = await make_role(db, "TenantUser", ["*"])

    async def _tenant(name, slug):
        t = Tenant(name=name, slug=slug, status="active", features={}, limits={})
        db.add(t)
        await db.commit()
        await db.refresh(t)
        return t

    async def _user(email, tenant_id, role, superadmin=False):
        u = User(
            email=email, full_name=email.split("@")[0], role_id=role.id,
            password_hash=hash_password("Passw0rd!"), is_active=True,
            tenant_id=tenant_id, is_superadmin=superadmin,
        )
        db.add(u)
        await db.commit()
        await db.refresh(u)
        await db.refresh(u, attribute_names=["role"])
        return u

    ta = await _tenant("Acme", "bc-acme")
    tb = await _tenant("Globex", "bc-globex")
    return {
        "db": db,
        "ta": ta,
        "tb": tb,
        "a": await _user("bc-a@x.io", ta.id, t_role),
        "b": await _user("bc-b@x.io", tb.id, t_role),
        "sa": await _user("bc-sa@x.io", None, sa_role, superadmin=True),
        "sa2": await _user("bc-sa2@x.io", None, sa_role, superadmin=True),
    }


async def _broadcast(db, **over) -> Broadcast:
    """Insert directly, so the read tests below do not depend on the create route."""
    fields = {
        "title": "Maintenance window",
        "body": "We will be upgrading storage.",
        "severity": "info",
        "target_type": "all",
        "target_tenant_ids": [],
        "is_active": True,
    }
    fields.update(over)
    row = Broadcast(**fields)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


# --- who a broadcast reaches -------------------------------------------------
async def test_a_broadcast_aimed_at_one_tenant_is_invisible_to_another(app, world):
    """The whole point of targeted announcements. "Your account is past due" or
    "your site migration starts tonight" addressed to Acme must not render in
    Globex's console — that is a disclosure about another customer, published to
    every one of their operators at once."""
    mine = await _broadcast(
        world["db"], title="Acme only", target_type="tenants",
        target_tenant_ids=[str(world["ta"].id)],
    )
    async with _client(app) as c:
        for_a = await c.get(f"{PREFIX}/broadcasts/active", headers=_auth(world["a"]))
        for_b = await c.get(f"{PREFIX}/broadcasts/active", headers=_auth(world["b"]))
    assert for_a.status_code == 200 and for_b.status_code == 200
    assert [b["id"] for b in for_a.json()] == [str(mine.id)]
    assert for_b.json() == []


async def test_a_targeted_broadcast_is_invisible_to_a_caller_with_no_token(app, world):
    """The route is deliberately unauthenticated so the LOGIN page can show a
    platform-wide notice. That makes an un-scoped caller the widest audience there
    is, and a targeted message must not fall through to it."""
    await _broadcast(
        world["db"], title="Acme only", target_type="tenants",
        target_tenant_ids=[str(world["ta"].id)],
    )
    everyone = await _broadcast(world["db"], title="Platform notice", target_type="all")
    async with _client(app) as c:
        anon = await c.get(f"{PREFIX}/broadcasts/active")
    assert anon.status_code == 200
    assert [b["id"] for b in anon.json()] == [str(everyone.id)]


async def test_an_expired_or_not_yet_started_broadcast_is_not_shown(app, world):
    """The window is what makes a broadcast schedulable. Ignoring it would show
    next week's maintenance notice today and never stop showing last week's."""
    await _broadcast(world["db"], title="over", ends_at=_now() - dt.timedelta(hours=1))
    await _broadcast(world["db"], title="later", starts_at=_now() + dt.timedelta(hours=1))
    await _broadcast(world["db"], title="switched off", is_active=False)
    live = await _broadcast(world["db"], title="now",
                            starts_at=_now() - dt.timedelta(hours=1),
                            ends_at=_now() + dt.timedelta(hours=1))
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/broadcasts/active", headers=_auth(world["a"]))
    assert [b["id"] for b in r.json()] == [str(live.id)]


async def test_the_tenant_facing_read_does_not_expose_the_target_list(app, world):
    """A tenant reading its own announcements must not learn WHO ELSE was
    addressed. `ActiveBroadcastOut` is a narrower shape than the admin one for that
    reason, and a response_model widened back to the admin shape would turn every
    targeted notice into a customer list."""
    await _broadcast(
        world["db"], title="Two of you", target_type="tenants",
        target_tenant_ids=[str(world["ta"].id), str(world["tb"].id)],
    )
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/broadcasts/active", headers=_auth(world["a"]))
    (item,) = r.json()
    assert "target_tenant_ids" not in item
    assert str(world["tb"].id) not in r.text


# --- managing them -----------------------------------------------------------
async def test_an_operator_can_publish_edit_and_retract_a_broadcast(app, world):
    """The management happy path, so the refusals elsewhere cannot pass by the
    surface being dead. Retraction is the part that matters operationally: a wrong
    announcement has to be removable while people are reading it."""
    async with _client(app) as c:
        created = await c.post(
            ADMIN_BC, headers=_auth(world["sa"]),
            json={"title": "Upgrade", "body": "tonight", "severity": "warning",
                  "target_type": "tenants", "target_tenant_ids": [str(world["ta"].id)]},
        )
        assert created.status_code == 201, created.text
        bid = created.json()["id"]

        edited = await c.patch(
            f"{ADMIN_BC}/{bid}", headers=_auth(world["sa"]), json={"body": "postponed"}
        )
        seen_by_tenant = await c.get(f"{PREFIX}/broadcasts/active", headers=_auth(world["a"]))
        removed = await c.delete(f"{ADMIN_BC}/{bid}", headers=_auth(world["sa"]))
        gone = await c.get(f"{PREFIX}/broadcasts/active", headers=_auth(world["a"]))
        listed = await c.get(ADMIN_BC, headers=_auth(world["sa"]))

    assert created.json()["target_tenant_ids"] == [str(world["ta"].id)]
    assert edited.status_code == 200 and edited.json()["body"] == "postponed"
    assert [b["body"] for b in seen_by_tenant.json()] == ["postponed"]
    assert removed.status_code == 204
    assert gone.json() == []
    assert listed.json() == []


async def test_a_severity_or_target_outside_the_vocabulary_is_refused(app, world):
    """Severity drives how loudly the console renders a notice and `target_type`
    decides who sees it. An unknown target_type is the dangerous one: the read
    filter matches "all" or an explicit id list, so anything else silently
    addresses nobody and the operator is never told the message did not go out."""
    async with _client(app) as c:
        bad_sev = await c.post(
            ADMIN_BC, headers=_auth(world["sa"]),
            json={"title": "x", "severity": "apocalyptic"},
        )
        bad_target = await c.post(
            ADMIN_BC, headers=_auth(world["sa"]),
            json={"title": "x", "target_type": "everyone"},
        )
    assert bad_sev.status_code == 422, bad_sev.text
    assert bad_target.status_code == 422, bad_target.text


async def test_editing_a_broadcast_that_does_not_exist_is_a_404(app, world):
    async with _client(app) as c:
        r = await c.patch(
            f"{ADMIN_BC}/{uuid.uuid4()}", headers=_auth(world["sa"]), json={"title": "x"}
        )
        d = await c.delete(f"{ADMIN_BC}/{uuid.uuid4()}", headers=_auth(world["sa"]))
    assert r.status_code == 404
    assert d.status_code == 404


# --- the alert inbox ---------------------------------------------------------
async def test_alerts_are_derived_from_the_state_they_describe(app, world):
    """The inbox holds no alert rows — it recomputes from tenants, invoices and
    subscriptions on every read. So the test that it works is that changing the
    world changes the inbox: suspend a tenant, and the suspension is in there,
    keyed by that tenant."""
    async with _client(app) as c:
        before = await c.get(ALERTS, headers=_auth(world["sa"]))
        assert before.status_code == 200, before.text
        assert before.json()["items"] == []

        await c.post(
            f"{PREFIX}/admin/tenants/{world['tb'].id}/suspend", headers=_auth(world["sa"])
        )
        after = await c.get(ALERTS, headers=_auth(world["sa"]))

    keys = [a["key"] for a in after.json()["items"]]
    assert f"suspended:{world['tb'].id}" in keys
    assert after.json()["unread"] == after.json()["total"] == len(keys)


async def test_one_admin_dismissing_an_alert_does_not_hide_it_from_the_others(app, world):
    """Read and dismiss state is per-admin on purpose. If it were shared, the first
    operator to clear a critical licence alert would clear it for the whole team —
    and the alert it silences is the one nobody else has seen yet."""
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/admin/tenants/{world['tb'].id}/suspend", headers=_auth(world["sa"])
        )
        key = f"suspended:{world['tb'].id}"

        dismissed = await c.post(ALERTS + "/dismiss", headers=_auth(world["sa"]), json={"key": key})
        assert dismissed.status_code == 204, dismissed.text

        for_sa = await c.get(ALERTS, headers=_auth(world["sa"]))
        for_sa2 = await c.get(ALERTS, headers=_auth(world["sa2"]))

    assert key not in [a["key"] for a in for_sa.json()["items"]]
    assert key in [a["key"] for a in for_sa2.json()["items"]]
    assert for_sa2.json()["unread"] >= 1


async def test_marking_read_clears_the_badge_without_hiding_the_alert(app, world):
    """Read and dismissed are different states and the console renders them
    differently: read drops the unread count, dismissed removes the row. Collapsing
    the two would make "I have seen this" delete the thing seen."""
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/admin/tenants/{world['tb'].id}/suspend", headers=_auth(world["sa"])
        )
        key = f"suspended:{world['tb'].id}"
        await c.post(ALERTS + "/read", headers=_auth(world["sa"]), json={"key": key})
        after = await c.get(ALERTS, headers=_auth(world["sa"]))

    (row,) = [a for a in after.json()["items"] if a["key"] == key]
    assert row["read"] is True
    assert after.json()["unread"] == 0


async def test_read_all_covers_every_alert_currently_showing(app, world):
    """The "mark all read" button has to mean the badge goes to zero — including
    for alerts the operator never opened individually."""
    async with _client(app) as c:
        await c.post(
            f"{PREFIX}/admin/tenants/{world['ta'].id}/suspend", headers=_auth(world["sa"])
        )
        await c.post(
            f"{PREFIX}/admin/tenants/{world['tb'].id}/suspend", headers=_auth(world["sa"])
        )
        before = await c.get(ALERTS, headers=_auth(world["sa"]))
        done = await c.post(ALERTS + "/read-all", headers=_auth(world["sa"]))
        after = await c.get(ALERTS, headers=_auth(world["sa"]))

    assert before.json()["unread"] == 2
    assert done.status_code == 204
    assert after.json()["total"] == 2
    assert after.json()["unread"] == 0
    assert all(a["read"] for a in after.json()["items"])
