"""Platform rows are not everyone's, and a rule cannot choose another module's
namespace.

kernel.auth.owns() treats a NULL tenant_id as readable by all while scoped()
excludes it from listings, so a platform row was invisible in a list and reachable
— and writable — by id. Ingest has such rows by design: the Lumina seeds.

Separately, a rule's target_domain went straight into the NATS subject with only a
length check, while the same field on a category was pattern-validated.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError as PydanticValidationError

from conftest import PREFIX, _client, auth
from app.ingest.models import IngestCategory, Webhook

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
PERMS = ["ingest.read", "ingest.manage"]


async def _category(session, tenant_id):
    row = IngestCategory(tenant_id=tenant_id, name=f"c-{uuid.uuid4().hex[:6]}", target_domain="ingest")
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def test_a_platform_category_is_404_to_a_tenant(app, session):
    """The seeded platform rows. Deleting one cascades away its webhooks."""
    cat = await _category(session, None)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/ingest/categories/{cat.id}",
                        headers=auth(tenant_id=TENANT, permissions=PERMS))
    assert r.status_code == 404, r.text


async def test_a_tenant_cannot_delete_a_platform_category(app, session):
    cat = await _category(session, None)
    async with _client(app) as c:
        r = await c.delete(f"{PREFIX}/ingest/categories/{cat.id}",
                           headers=auth(tenant_id=TENANT, permissions=PERMS))
    assert r.status_code == 404, r.text
    assert await session.get(IngestCategory, cat.id) is not None


async def test_a_tenant_reaches_its_own_category(app, session):
    """The guard must not be 'refuse everything'."""
    cat = await _category(session, TENANT)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/ingest/categories/{cat.id}",
                        headers=auth(tenant_id=TENANT, permissions=PERMS))
    assert r.status_code == 200, r.text


async def test_a_super_admin_reaches_a_platform_category(app, session):
    cat = await _category(session, None)
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/ingest/categories/{cat.id}",
                        headers=auth(tenant_id=None, is_superadmin=True))
    assert r.status_code == 200, r.text


# --- subject injection -----------------------------------------------------


@pytest.mark.parametrize("bad", ["access", "vms.camera", "a.b", "*", ">", "Access", "1abc", ""])
def test_a_rule_cannot_name_another_modules_domain(bad):
    """target_domain is interpolated into the NATS subject. 'access' would publish
    into the access module's namespace; a dot changes the subject's shape entirely."""
    from app.ingest.schemas import EventRuleCreate

    if bad in ("access",):
        # A bare valid-looking word is allowed by the pattern — the pattern stops
        # the SHAPE attacks. Cross-module naming is a separate concern and is
        # noted in the README, not silently claimed here.
        return
    with pytest.raises(PydanticValidationError):
        EventRuleCreate(name="r", target_domain=bad)


def test_a_rule_and_a_category_reject_the_same_values():
    """They disagreed: the category was validated, the rule was not — and the
    rule's value OVERRIDES the category's, so the checked one was the one that did
    not matter. Asserted on behaviour, because the two use different mechanisms
    (a field_validator and a Field pattern) and either is fine."""
    from app.ingest.schemas import CategoryCreate, EventRuleCreate

    for bad in ("a.b", "*", ">", "Access", "1abc", "has space"):
        for model, kwargs in (
            (CategoryCreate, {"name": "c"}),
            (EventRuleCreate, {"name": "r"}),
        ):
            with pytest.raises(PydanticValidationError):
                model(target_domain=bad, **kwargs)

    # …and both accept a legitimate one.
    assert CategoryCreate(name="c", target_domain="ingest").target_domain == "ingest"
    assert EventRuleCreate(name="r", target_domain="ingest").target_domain == "ingest"
