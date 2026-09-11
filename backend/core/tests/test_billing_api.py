"""Billing — the commercial record, and the twelve routes that write it.

Billing is a super-admin surface by design: one operator prices the platform and
invoices every tenant, so there is no tenant scoping to assert here.
``test_admin_realm_boundary.py`` states the property that does hold — no tenant
reaches these routes — once, over the whole /admin table.

This file covers what a super-admin gets when they do reach them. Money-adjacent
mistakes are silent — a subscription written onto the wrong tenant, a plan deleted
under live subscribers, a voided invoice marked paid — so each test is one of those,
written as the consequence rather than the code path.

Rows go in through the API rather than directly, because the create path is part of
what is under test: ``subscribe`` copies a plan's entitlements onto a tenant's
licence, and a hand-built row would assert nothing about it.
"""


import datetime as dt

import pytest
import pytest_asyncio

from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.tenancy.models import Tenant
from conftest import api_client, bearer, make_role

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"
BILLING = f"{PREFIX}/admin/billing"


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
    r = await c.post(f"{BILLING}/plans", headers=bearer(sa), json=body)
    assert r.status_code == 201, r.text
    return r.json()


# --- the catalog -------------------------------------------------------------
async def test_a_created_plan_comes_back_with_the_price_it_was_given(app, world):
    """The happy path, so the refusals below cannot pass by everything being broken.
    Price is checked in minor units: the column is cents, and only an explicit number
    catches a value rendered as 12000.0 dollars somewhere in the chain."""
    async with api_client(app) as c:
        created = await _plan(c, world["sa"], price_cents=12000)
        listed = await c.get(f"{BILLING}/plans", headers=bearer(world["sa"]))
    assert created["price_cents"] == 12000
    assert created["limits"] == {"max_users": 25}
    assert listed.status_code == 200
    assert [p["key"] for p in listed.json()] == ["pro"]


async def test_a_second_plan_cannot_reuse_a_key(app, world):
    """`key` is the soft reference subscriptions hold, so two plans sharing one make
    a subscription's price ambiguous."""
    async with api_client(app) as c:
        await _plan(c, world["sa"], key="starter")
        dup = await c.post(
            f"{BILLING}/plans", headers=bearer(world["sa"]),
            json={"key": "starter", "name": "Starter Again"},
        )
    assert dup.status_code == 409, dup.text


async def test_a_plan_with_live_subscribers_cannot_be_deleted(app, world):
    """Plan.key is a soft reference with no FK behind it, so deleting a subscribed
    plan leaves a tenant on a tier that no longer exists — priced at nothing and
    invisible in the MRR."""
    async with api_client(app) as c:
        await _plan(c, world["sa"], key="pro")
        subscribed = await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=bearer(world["sa"]), json={"plan_key": "pro", "status": "active"},
        )
        assert subscribed.status_code == 200, subscribed.text
        refused = await c.delete(f"{BILLING}/plans/pro", headers=bearer(world["sa"]))
        still_there = await c.get(f"{BILLING}/plans", headers=bearer(world["sa"]))
    assert refused.status_code == 409, refused.text
    assert [p["key"] for p in still_there.json()] == ["pro"]


async def test_an_unpriced_interval_is_refused_on_create_and_on_update(app, world):
    """MRR normalisation divides a yearly price by twelve and passes a monthly one
    through, so an unknown interval counts as monthly — a twelvefold overstatement
    with no error anywhere."""
    async with api_client(app) as c:
        bad = await c.post(
            f"{BILLING}/plans", headers=bearer(world["sa"]),
            json={"key": "weird", "name": "Weird", "interval": "fortnightly"},
        )
        await _plan(c, world["sa"], key="pro")
        bad_patch = await c.patch(
            f"{BILLING}/plans/pro", headers=bearer(world["sa"]),
            json={"interval": "fortnightly"},
        )
    assert bad.status_code == 422, bad.text
    assert bad_patch.status_code == 422, bad_patch.text


# --- subscriptions -----------------------------------------------------------
async def test_subscribing_applies_the_plan_to_that_tenant_and_no_other(app, world):
    """`apply_entitlements` replaces the tenant's features and limits from the plan,
    which is how a commercial tier becomes an enforced licence — so writing it onto
    the wrong tenant silently re-licences a customer who bought nothing."""
    async with api_client(app) as c:
        await _plan(c, world["sa"], key="pro")
        r = await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=bearer(world["sa"]),
            json={"plan_key": "pro", "status": "active", "apply_entitlements": True},
        )
        assert r.status_code == 200, r.text
        mine = await c.get(f"{PREFIX}/admin/tenants/{world['ta'].id}", headers=bearer(world["sa"]))
        theirs = await c.get(f"{PREFIX}/admin/tenants/{world['tb'].id}", headers=bearer(world["sa"]))
    assert r.json()["plan"]["key"] == "pro"
    assert mine.json()["plan"] == "pro"
    assert mine.json()["limits"] == {"max_users": 25}
    assert theirs.json()["plan"] is None
    assert theirs.json()["limits"] == {}


async def test_subscribing_twice_moves_the_tenant_rather_than_stacking_a_second_row(app, world):
    """One active subscription per tenant is a UNIQUE constraint, so an upgrade must
    upsert — inserting would 500 at the worst possible moment."""
    async with api_client(app) as c:
        await _plan(c, world["sa"], key="starter", price_cents=1000)
        await _plan(c, world["sa"], key="pro", price_cents=12000)
        url = f"{BILLING}/tenants/{world['ta'].id}/subscription"
        first = await c.put(url, headers=bearer(world["sa"]), json={"plan_key": "starter"})
        second = await c.put(url, headers=bearer(world["sa"]), json={"plan_key": "pro"})
        current = await c.get(url, headers=bearer(world["sa"]))
        summary = await c.get(f"{BILLING}/summary", headers=bearer(world["sa"]))
    assert first.status_code == 200 and second.status_code == 200, second.text
    assert first.json()["id"] == second.json()["id"], "a second subscription row was created"
    assert current.json()["plan_key"] == "pro"
    assert summary.json()["active_subscriptions"] == 1
    assert summary.json()["mrr_cents"] == 12000


async def test_a_subscription_for_a_tenant_that_does_not_exist_is_refused(app, world):
    """A typo in a uuid must not create commercial state addressed to nobody."""
    import uuid as _uuid

    async with api_client(app) as c:
        await _plan(c, world["sa"], key="pro")
        r = await c.put(
            f"{BILLING}/tenants/{_uuid.uuid4()}/subscription",
            headers=bearer(world["sa"]), json={"plan_key": "pro"},
        )
    assert r.status_code == 404, r.text


async def test_a_tenant_with_no_subscription_reads_as_null_not_as_an_error(app, world):
    """The billing page renders this for every tenant, including those on no plan. A
    404 would make "not a customer yet" indistinguishable from a bad id."""
    async with api_client(app) as c:
        r = await c.get(
            f"{BILLING}/tenants/{world['tb'].id}/subscription", headers=bearer(world["sa"])
        )
    assert r.status_code == 200
    assert r.json() is None


async def test_cancelling_marks_the_subscription_and_drops_it_out_of_mrr(app, world):
    async with api_client(app) as c:
        await _plan(c, world["sa"], key="pro", price_cents=12000)
        await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=bearer(world["sa"]), json={"plan_key": "pro"},
        )
        cancelled = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/subscription/cancel", headers=bearer(world["sa"])
        )
        summary = await c.get(f"{BILLING}/summary", headers=bearer(world["sa"]))
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "canceled"
    assert cancelled.json()["canceled_at"] is not None
    assert summary.json()["active_subscriptions"] == 0
    assert summary.json()["mrr_cents"] == 0


async def test_a_yearly_plan_is_normalised_to_a_monthly_figure(app, world):
    """MRR mixes intervals, and a yearly plan at full price puts a year of revenue
    into one month of the dashboard."""
    async with api_client(app) as c:
        await _plan(c, world["sa"], key="annual", price_cents=120_000, interval="yearly")
        await c.put(
            f"{BILLING}/tenants/{world['ta'].id}/subscription",
            headers=bearer(world["sa"]), json={"plan_key": "annual"},
        )
        summary = await c.get(f"{BILLING}/summary", headers=bearer(world["sa"]))
    assert summary.json()["mrr_cents"] == 10_000


# --- invoices ----------------------------------------------------------------
async def test_invoice_numbers_are_sequential_and_unique_within_a_year(app, world):
    """The number is the human handle on a statutory record; two invoices sharing one
    makes the books unreconcilable."""
    async with api_client(app) as c:
        a = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=bearer(world["sa"]), json={"amount_cents": 5000},
        )
        b = await c.post(
            f"{BILLING}/tenants/{world['tb'].id}/invoices",
            headers=bearer(world["sa"]), json={"amount_cents": 7000},
        )
    assert a.status_code == 201 and b.status_code == 201, b.text
    year = dt.datetime.now(dt.timezone.utc).year
    assert a.json()["number"] == f"INV-{year}-0001"
    assert b.json()["number"] == f"INV-{year}-0002"


async def test_the_invoice_list_filters_to_the_tenant_it_was_asked_for(app, world):
    """The ?tenant_id filter is how the operator answers "what does this customer
    owe". The page and the count are built as separate statements here, so a filter
    applied to one and not the other reports the wrong total."""
    async with api_client(app) as c:
        for _ in range(3):
            await c.post(
                f"{BILLING}/tenants/{world['ta'].id}/invoices",
                headers=bearer(world["sa"]), json={"amount_cents": 100},
            )
        await c.post(
            f"{BILLING}/tenants/{world['tb'].id}/invoices",
            headers=bearer(world["sa"]), json={"amount_cents": 999},
        )
        mine = await c.get(
            f"{BILLING}/invoices", headers=bearer(world["sa"]),
            params={"tenant_id": str(world["ta"].id)},
        )
        everything = await c.get(f"{BILLING}/invoices", headers=bearer(world["sa"]))
    assert mine.status_code == 200, mine.text
    assert mine.json()["total"] == 3
    assert {i["tenant_id"] for i in mine.json()["items"]} == {str(world["ta"].id)}
    assert all(i["tenant_name"] == "Acme" for i in mine.json()["items"])
    assert everything.json()["total"] == 4


async def test_a_voided_invoice_can_never_be_marked_paid(app, world):
    """Void is the correction of record for an invoice that should not have been
    issued; paying it afterwards resurrects a cancelled debt."""
    async with api_client(app) as c:
        inv = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=bearer(world["sa"]), json={"amount_cents": 5000},
        )
        inv_id = inv.json()["id"]
        voided = await c.post(f"{BILLING}/invoices/{inv_id}/void", headers=bearer(world["sa"]))
        paid = await c.post(f"{BILLING}/invoices/{inv_id}/mark-paid", headers=bearer(world["sa"]))
    assert voided.status_code == 200 and voided.json()["status"] == "void"
    assert paid.status_code == 422, paid.text


async def test_marking_paid_clears_the_invoice_out_of_outstanding(app, world):
    async with api_client(app) as c:
        inv = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=bearer(world["sa"]), json={"amount_cents": 5000, "status": "issued"},
        )
        before = await c.get(f"{BILLING}/summary", headers=bearer(world["sa"]))
        paid = await c.post(
            f"{BILLING}/invoices/{inv.json()['id']}/mark-paid", headers=bearer(world["sa"])
        )
        after = await c.get(f"{BILLING}/summary", headers=bearer(world["sa"]))
    assert before.json()["outstanding_cents"] == 5000
    assert paid.json()["paid_at"] is not None
    assert after.json()["outstanding_cents"] == 0
    assert after.json()["paid_last_30d_cents"] == 5000


async def test_an_invoice_status_outside_the_lifecycle_is_refused(app, world):
    """`status` drives the receivables arithmetic: a free-text value counts as
    neither outstanding nor paid, so the invoice vanishes from every total while
    still existing."""
    async with api_client(app) as c:
        r = await c.post(
            f"{BILLING}/tenants/{world['ta'].id}/invoices",
            headers=bearer(world["sa"]), json={"amount_cents": 100, "status": "maybe"},
        )
    assert r.status_code == 422, r.text
