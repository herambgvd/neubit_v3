"""Phase 1 — effective entitlements resolver + token claims.

Covers tenancy.entitlements.effective_entitlements (the one resolver),
token_entitlements (what goes into the access token), and that
create_access_token bakes features/limits into the JWT.
"""

from __future__ import annotations

import datetime as dt

import pytest

from app.auth.security import create_access_token, decode_token
from app.module_catalog.service import DEFAULT_MODULES, seed_modules
from app.module_catalog.service import ModuleCatalogService
from app.tenancy.entitlements import effective_entitlements, token_entitlements
from app.tenancy.models import Tenant

from conftest import make_role, make_user

pytestmark = pytest.mark.asyncio


def _tenant(**kw) -> Tenant:
    """A Tenant instance (not persisted) with sensible defaults for resolver tests."""
    base = dict(name="Acme", slug="acme", status="active", features={}, limits={}, grace_days=0)
    base.update(kw)
    return Tenant(**base)


async def _catalog(db):
    await seed_modules(db)
    return await ModuleCatalogService(db).list_modules()


# --- effective_entitlements -------------------------------------------------
async def test_resolver_reflects_tenant_toggles_and_limits(db):
    modules = await _catalog(db)
    tenant = _tenant(plan="pro", features={"vms": True, "access": False}, limits={"max_cameras": 100})

    ent = effective_entitlements(tenant, modules)

    assert ent["plan"] == "pro"
    assert ent["limits"] == {"max_cameras": 100}
    assert ent["license_state"] == "active"
    by_key = {m["key"]: m["enabled"] for m in ent["modules"]}
    assert by_key["vms"] is True
    assert by_key["access"] is False
    # A catalog module with no explicit toggle resolves to disabled.
    assert by_key["fire"] is False
    # Every catalog module is represented.
    assert set(by_key) == {m["key"] for m in DEFAULT_MODULES}


async def test_resolver_superadmin_gets_everything(db):
    modules = await _catalog(db)
    ent = effective_entitlements(None, modules, is_superadmin=True)

    assert ent["license_state"] == "active"
    assert ent["limits"] == {}
    assert all(m["enabled"] for m in ent["modules"])


async def test_resolver_expired_and_grace_states(db):
    modules = await _catalog(db)
    now = dt.datetime(2026, 1, 10, tzinfo=dt.timezone.utc)
    past = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

    expired = effective_entitlements(_tenant(license_expires_at=past, grace_days=0), modules, now=now)
    assert expired["license_state"] == "expired"

    grace = effective_entitlements(_tenant(license_expires_at=past, grace_days=30), modules, now=now)
    assert grace["license_state"] == "grace"

    active = effective_entitlements(
        _tenant(license_expires_at=dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)),
        modules,
        now=now,
    )
    assert active["license_state"] == "active"


# --- token_entitlements -----------------------------------------------------
async def test_token_entitlements_returns_tenant_dicts(db, admin_role):
    tenant = _tenant(features={"vms": True}, limits={"max_users": 5})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    user = await make_user(db, "u@acme.com", admin_role)
    user.tenant_id = tenant.id
    await db.commit()

    features, limits, license_state, tenant_status = await token_entitlements(db, user)
    assert features == {"vms": True}
    assert limits == {"max_users": 5}
    assert license_state == "active"
    assert tenant_status == "active"


async def test_token_entitlements_suspended_tenant_status(db, admin_role):
    tenant = _tenant(status="suspended", features={"vms": True})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    user = await make_user(db, "susp@acme.com", admin_role)
    user.tenant_id = tenant.id
    await db.commit()

    _, _, _, tenant_status = await token_entitlements(db, user)
    assert tenant_status == "suspended"


async def test_token_entitlements_expired_license_state(db, admin_role):
    past = dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)
    tenant = _tenant(features={"vms": True}, license_expires_at=past, grace_days=0)
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    user = await make_user(db, "exp@acme.com", admin_role)
    user.tenant_id = tenant.id
    await db.commit()

    _, _, license_state, _ = await token_entitlements(db, user)
    assert license_state == "expired"


async def test_token_entitlements_empty_for_superadmin(db, admin_role):
    sa = await make_user(db, "sa@platform.com", admin_role, superadmin=True)
    features, limits, license_state, tenant_status = await token_entitlements(db, sa)
    assert features == {} and limits == {} and license_state == "active" and tenant_status == "active"


async def test_token_entitlements_empty_for_tenantless_user(db, admin_role):
    user = await make_user(db, "nt@acme.com", admin_role)  # tenant_id is None
    features, limits, license_state, tenant_status = await token_entitlements(db, user)
    assert features == {} and limits == {} and license_state == "active" and tenant_status == "active"


# --- token claims -----------------------------------------------------------
async def test_access_token_carries_features_and_limits(db, admin_role):
    user = await make_user(db, "claims@acme.com", admin_role)
    token = create_access_token(
        user,
        features={"vms": True, "access": False},
        limits={"max_cameras": 100},
        license_state="grace",
        tenant_status="suspended",
    )
    payload = decode_token(token)

    assert payload["features"] == {"vms": True, "access": False}
    assert payload["limits"] == {"max_cameras": 100}
    assert payload["license_state"] == "grace"
    assert payload["tenant_status"] == "suspended"


async def test_access_token_defaults_to_empty_entitlements(db, admin_role):
    user = await make_user(db, "empty@acme.com", admin_role)
    payload = decode_token(create_access_token(user))
    assert payload["features"] == {}
    assert payload["limits"] == {}
    assert payload["license_state"] == "active"
    assert payload["tenant_status"] == "active"
