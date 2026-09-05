"""Billing — the commercial record, and the twelve routes that write it.

Billing is a super-admin surface by design: one operator prices the platform and
invoices every tenant, so there is no tenant scoping to assert here and asserting
it would be wrong. ``test_admin_realm_boundary.py`` states the property that DOES
hold — no tenant reaches these routes at all — once, over the whole /admin table.

What this file is for is the second half of that: that a super-admin who does
reach them gets the behaviour the console is built on. Money-adjacent state has
the unhappy property that a mistake is silent — a subscription written onto the
wrong tenant, a plan deleted out from under live subscribers, a voided invoice
that can still be marked paid — so each test below is one of those, written as the
consequence rather than as the code path.

Rows are inserted through the API here rather than directly, because in billing
the create path IS the thing under test: ``subscribe`` is the route that copies a
plan's entitlements onto a tenant's licence, and a fixture that hand-built the row
would assert nothing about it.
"""

from __future__ import annotations

import datetime as dt

import httpx
import pytest
import pytest_asyncio

from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.billing.models import Invoice, Plan, Subscription  # noqa: F401 — create_all
from app.db.base import get_db
from app.tenancy.models import Tenant
from conftest import make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
BILLING = f"{PREFIX}/admin/billing"


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


@pytest_asyncio.fixture
async def world(db):
    """Two paying tenants and the operator who bills them."""
    sa_role = await make_role(db, "Platform", ["*"])
    t_role = await make_role(db, "TenantAdmin", ["*"])

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

    ta = await _tenant("Acme", "bill-acme")
    tb = await _tenant("Globex", "bill-globex")
    return {
        "db": db,
        "ta": ta,
        "tb": tb,
        "sa": await _user("billing-sa@x.io", None, sa_role, superadmin=True),
        "tenant_admin": await _user("acme-admin@x.io", ta.id, t_role),
    }


async def _plan(c, sa, key="pro", **over) -> dict:
    body = {
        "key": key, "name": key.title(), "price_cents": 12000, "currency": "USD",
        "interval": "monthly", "features": {"vms": True}, "limits": {"max_users": 25},
    }
    body.update(over)
    r = await c.post(f"{BILLING}/plans", headers=_auth(sa), json=body)
    assert r.status_code == 201, r.text
    return r.json()


# --- the catalog -------------------------------------------------------------
async def test_a_created_plan_comes_back_with_the_price_it_was_given(app, world):
    """The happy path, so every refusal below cannot pass by everything being
    broken. Price is checked in MINOR units: the column is cents and a currency
    field rendered as 12000.0 dollars somewhere in the chain is the kind of thing
    only an explicit number catches."""
    async with _client(app) as c:
        created = await _plan(c, world["sa"], price_cents=12000)
        listed = await c.get(f"{BILLING}/plans", headers=_auth(world["sa"]))
    assert created["price_cents"] == 12000
    assert created["limits"] == {"max_users": 25}
    assert listed.status_code == 200
    assert [p["key"] for p in listed.json()] == ["pro"]


async def test_a_second_plan_cannot_reuse_a_key(app, world):
    """`key` is the soft reference subscriptions hold. Two plans sharing one would
    make a subscription's price ambiguous."""
    async with _client(app) as c:
        await _plan(c, world["sa"], key="starter")
        dup = await c.post(
            f"{BILLING}/plans", headers=_auth(world["sa"]),
            json={"key": "starter", "name": "Starter Again"},
        )
    assert dup.status_code == 409, dup.text


async def test_a_plan_with_live_subscribers_cannot_be_deleted(app, world):
    """Plan.key is a soft reference with no FK behind it, so deleting a subscribed
    plan would leave a tenant on a tier that no longer exists — priced at nothing,
    and invisible in the MRR. The route must refuse and say how many are affected."""
    async with _client(app) as c:
        await _plan(c, world["sa"], key="pro")
        subscribed = await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=_auth(world["sa"]), json={"plan_key": "pro", "status": "active"},
        )
        assert subscribed.status_code == 200, subscribed.text
        refused = await c.delete(f"{BILLING}/plans/pro", headers=_auth(world["sa"]))
        still_there = await c.get(f"{BILLING}/plans", headers=_auth(world["sa"]))
    assert refused.status_code == 409, refused.text
    assert [p["key"] for p in still_there.json()] == ["pro"]


async def test_an_unpriced_interval_is_refused_on_create_and_on_update(app, world):
    """MRR normalisation divides a yearly price by twelve and passes a monthly one
    through. An interval it has never heard of would be counted as monthly —
    a twelvefold overstatement of revenue, reported with no error anywhere."""
    async with _client(app) as c:
        bad = await c.post(
            f"{BILLING}/plans", headers=_auth(world["sa"]),
            json={"key": "weird", "name": "Weird", "interval": "fortnightly"},
        )
        await _plan(c, world["sa"], key="pro")
        bad_patch = await c.patch(
            f"{BILLING}/plans/pro", headers=_auth(world["sa"]),
            json={"interval": "fortnightly"},
        )
    assert bad.status_code == 422, bad.text
    assert bad_patch.status_code == 422, bad_patch.text


# --- subscriptions -----------------------------------------------------------
async def test_subscribing_applies_the_plan_to_that_tenant_and_no_other(app, world):
    """`apply_entitlements` REPLACES the tenant's features and limits from the
    plan — it is how a commercial tier becomes an enforced licence. Writing it onto
    the wrong tenant would silently re-licence a customer who did not buy anything;
    this asserts the neighbour is untouched."""
    async with _client(app) as c:
        await _plan(c, world["sa"], key="pro")
        r = await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=_auth(world["sa"]),
            json={"plan_key": "pro", "status": "active", "apply_entitlements": True},
        )
        assert r.status_code == 200, r.text
        mine = await c.get(f"{PREFIX}/admin/tenants/{world['ta'].id}", headers=_auth(world["sa"]))
        theirs = await c.get(f"{PREFIX}/admin/tenants/{world['tb'].id}", headers=_auth(world["sa"]))
    assert r.json()["plan"]["key"] == "pro"
    assert mine.json()["plan"] == "pro"
    assert mine.json()["limits"] == {"max_users": 25}
    assert theirs.json()["plan"] is None
    assert theirs.json()["limits"] == {}


async def test_subscribing_twice_moves_the_tenant_rather_than_stacking_a_second_row(app, world):
    """One active subscription per tenant is a UNIQUE constraint in the schema, so
    an upgrade that inserted instead of updating would be a 500 at the worst
    possible moment. It must be an upsert."""
    async with _client(app) as c:
        await _plan(c, world["sa"], key="starter", price_cents=1000)
        await _plan(c, world["sa"], key="pro", price_cents=12000)
        url = f"{BILLING}/tenants/{world['ta'].id}/subscription"
        first = await c.put(url, headers=_auth(world["sa"]), json={"plan_key": "starter"})
        second = await c.put(url, headers=_auth(world["sa"]), json={"plan_key": "pro"})
        current = await c.get(url, headers=_auth(world["sa"]))
        summary = await c.get(f"{BILLING}/summary", headers=_auth(world["sa"]))
    assert first.status_code == 200 and second.status_code == 200, second.text
    assert first.json()["id"] == second.json()["id"], "a second subscription row was created"
    assert current.json()["plan_key"] == "pro"
    assert summary.json()["active_subscriptions"] == 1
    assert summary.json()["mrr_cents"] == 12000


async def test_a_subscription_for_a_tenant_that_does_not_exist_is_refused(app, world):
    """A typo in a uuid must not create commercial state addressed to nobody."""
    import uuid as _uuid

    async with _client(app) as c:
        await _plan(c, world["sa"], key="pro")
        r = await c.put(
            f"{BILLING}/tenants/{_uuid.uuid4()}/subscription",
            headers=_auth(world["sa"]), json={"plan_key": "pro"},
        )
    assert r.status_code == 404, r.text


async def test_a_tenant_with_no_subscription_reads_as_null_not_as_an_error(app, world):
    """The billing page renders this for every tenant, including the ones on no
    plan. A 404 here would make "not a customer yet" indistinguishable from a bad
    id and put an error state on a perfectly normal row."""
    async with _client(app) as c:
        r = await c.get(
            f"{BILLING}/tenants/{world['tb'].id}/subscription", headers=_auth(world["sa"])
        )
    assert r.status_code == 200
    assert r.json() is None


async def test_cancelling_marks_the_subscription_and_drops_it_out_of_mrr(app, world):
    async with _client(app) as c:
        await _plan(c, world["sa"], key="pro", price_cents=12000)
        await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=_auth(world["sa"]), json={"plan_key": "pro"},
        )
        cancelled = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/subscription/cancel", headers=_auth(world["sa"])
        )
        summary = await c.get(f"{BILLING}/summary", headers=_auth(world["sa"]))
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "canceled"
    assert cancelled.json()["canceled_at"] is not None
    assert summary.json()["active_subscriptions"] == 0
    assert summary.json()["mrr_cents"] == 0


async def test_a_yearly_plan_is_normalised_to_a_monthly_figure(app, world):
    """MRR mixes intervals. A yearly plan counted at its full price would put a
    year of revenue into one month of the dashboard."""
    async with _client(app) as c:
        await _plan(c, world["sa"], key="annual", price_cents=120_000, interval="yearly")
        await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=_auth(world["sa"]), json={"plan_key": "annual"},
        )
        summary = await c.get(f"{BILLING}/summary", headers=_auth(world["sa"]))
    assert summary.json()["mrr_cents"] == 10_000


# --- invoices ----------------------------------------------------------------
async def test_invoice_numbers_are_sequential_and_unique_within_a_year(app, world):
    """The number is the human handle on a statutory record. Two invoices sharing
    one makes the books unreconcilable."""
    async with _client(app) as c:
        a = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=_auth(world["sa"]), json={"amount_cents": 5000},
        )
        b = await c.post(
            f"{BILLING}/tenants/{world['tb'].id}/invoices",
            headers=_auth(world["sa"]), json={"amount_cents": 7000},
        )
    assert a.status_code == 201 and b.status_code == 201, b.text
    year = dt.datetime.now(dt.timezone.utc).year
    assert a.json()["number"] == f"INV-{year}-0001"
    assert b.json()["number"] == f"INV-{year}-0002"


async def test_the_invoice_list_filters_to_the_tenant_it_was_asked_for(app, world):
    """The cross-tenant list is the operator's whole view of receivables, and the
    ?tenant_id filter is how they answer "what does this customer owe". A filter
    applied to the page but not to the count reports the wrong total — the two
    statements are built separately in this handler."""
    async with _client(app) as c:
        for _ in range(3):
            await c.post(
                f"{BILLING}/tenants/{world['ta'].id}/invoices",
                headers=_auth(world["sa"]), json={"amount_cents": 100},
            )
        await c.post(
            f"{BILLING}/tenants/{world['tb'].id}/invoices",
            headers=_auth(world["sa"]), json={"amount_cents": 999},
        )
        mine = await c.get(
            f"{BILLING}/invoices", headers=_auth(world["sa"]),
            params={"tenant_id": str(world["ta"].id)},
        )
        everything = await c.get(f"{BILLING}/invoices", headers=_auth(world["sa"]))
    assert mine.status_code == 200, mine.text
    assert mine.json()["total"] == 3
    assert {i["tenant_id"] for i in mine.json()["items"]} == {str(world["ta"].id)}
    assert all(i["tenant_name"] == "Acme" for i in mine.json()["items"])
    assert everything.json()["total"] == 4


async def test_a_voided_invoice_can_never_be_marked_paid(app, world):
    """Void is the correction of record for an invoice that should not have been
    issued. Letting it be paid afterwards resurrects a cancelled debt and puts
    money into the reconciliation that was never owed."""
    async with _client(app) as c:
        inv = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=_auth(world["sa"]), json={"amount_cents": 5000},
        )
        inv_id = inv.json()["id"]
        voided = await c.post(f"{BILLING}/invoices/{inv_id}/void", headers=_auth(world["sa"]))
        paid = await c.post(f"{BILLING}/invoices/{inv_id}/mark-paid", headers=_auth(world["sa"]))
    assert voided.status_code == 200 and voided.json()["status"] == "void"
    assert paid.status_code == 422, paid.text


async def test_marking_paid_clears_the_invoice_out_of_outstanding(app, world):
    async with _client(app) as c:
        inv = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=_auth(world["sa"]), json={"amount_cents": 5000, "status": "issued"},
        )
        before = await c.get(f"{BILLING}/summary", headers=_auth(world["sa"]))
        paid = await c.post(
            f"{BILLING}/invoices/{inv.json()['id']}/mark-paid", headers=_auth(world["sa"])
        )
        after = await c.get(f"{BILLING}/summary", headers=_auth(world["sa"]))
    assert before.json()["outstanding_cents"] == 5000
    assert paid.json()["paid_at"] is not None
    assert after.json()["outstanding_cents"] == 0
    assert after.json()["paid_last_30d_cents"] == 5000


async def test_an_invoice_status_outside_the_lifecycle_is_refused(app, world):
    """`status` drives the receivables arithmetic. A free-text value would be
    counted as neither outstanding nor paid and the invoice would vanish from every
    total while still existing."""
    async with _client(app) as c:
        r = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=_auth(world["sa"]), json={"amount_cents": 100, "status": "maybe"},
        )
    assert r.status_code == 422, r.text
