"""POST /messaging/templates/{name}/render — the seam that makes a custom template real.

Before this endpoint, a template could be written, previewed and stored, and then
nothing outside core could turn one into an email. vision's linkage `notify` action
is the first caller and it holds a SERVICE token (no `users` row), so these tests
drive both principals: a service token and a real operator.
"""

from __future__ import annotations

import time
import uuid

import httpx
import jwt
import pytest

from app.app import create_base_app
from app.auth.security import create_access_token
from app.core.config import get_settings
from app.db.base import get_db
from app.messaging import template_store
from app.tenancy.models import Tenant
from conftest import make_role, make_user

pytestmark = pytest.mark.asyncio

PREFIX = "/api/v1"


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


def _service_auth(tenant_id=None) -> dict:
    """A token shaped exactly like vision's `mint_service_token` output."""
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": "00000000-0000-0000-0000-0000000000ec",
            "type": "access",
            "tenant_id": str(tenant_id) if tenant_id else None,
            "is_superadmin": True,
            "permissions": ["*"],
            "iat": now,
            "exp": now + 120,
        },
        get_settings().jwt_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


async def _tenant(db, slug: str) -> Tenant:
    t = Tenant(name=slug, slug=slug, status="active", features={}, limits={})
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


async def test_service_token_renders_a_custom_template(app, db):
    # A name that is NOT built in — exactly what an operator creates in the UI.
    await template_store.upsert_override(
        db, "gate_breach", "Gate: {{ title }}", "<p>{{ message }} ({{ severity }})</p>"
    )
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/gate_breach/render",
            headers=_service_auth(),
            json={"context": {"title": "Forced", "message": "Door forced", "severity": "High"}},
        )
    assert r.status_code == 200, r.text
    assert r.json()["subject"] == "Gate: Forced"
    body = r.json()["html"]
    assert "Door forced (High)" in body
    # wrap defaults on: the branded shell is what a real send delivers.
    assert "max-width:560px" in body


async def test_wrap_false_returns_the_bare_body(app, db):
    await template_store.upsert_override(db, "bare", "S", "<p>hi</p>")
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/bare/render",
            headers=_service_auth(),
            json={"context": {}, "wrap": False},
        )
    assert r.status_code == 200, r.text
    assert r.json()["html"] == "<p>hi</p>"


async def test_body_tenant_selects_that_tenants_override(app, db):
    acme = await _tenant(db, "render-acme")
    await template_store.upsert_override(db, "alert", "PLATFORM", "<p>platform</p>")
    await template_store.upsert_override(
        db, "alert", "ACME {{ title }}", "<p>acme</p>", tenant_id=acme.id
    )
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/alert/render",
            headers=_service_auth(acme.id),
            json={"context": {"title": "x"}, "tenant_id": str(acme.id)},
        )
    assert r.status_code == 200
    assert r.json()["subject"] == "ACME x"


async def test_operator_tenant_wins_over_the_body_tenant(app, db):
    """An operator cannot read another tenant's override by naming it in the body."""
    acme = await _tenant(db, "render-acme2")
    other = await _tenant(db, "render-other")
    await template_store.upsert_override(
        db, "alert", "ACME", "<p>acme</p>", tenant_id=acme.id
    )
    await template_store.upsert_override(
        db, "alert", "OTHER", "<p>other</p>", tenant_id=other.id
    )
    role = await make_role(db, "SettingsAdmin", ["settings.manage"])
    user = await make_user(db, "admin@acme.io", role)
    user.tenant_id = acme.id
    await db.commit()
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/alert/render",
            headers=_auth(user),
            json={"context": {}, "tenant_id": str(other.id)},
        )
    assert r.status_code == 200
    assert r.json()["subject"] == "ACME"


async def test_render_needs_settings_manage(app, db):
    role = await make_role(db, "Viewer", ["vms.live.view"])
    user = await make_user(db, "viewer@x.io", role)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/alert/render", headers=_auth(user), json={}
        )
    assert r.status_code == 403


async def test_unknown_template_is_refused_not_empty(app, db):
    """A typo must fail loudly; an empty email is the worst possible success."""
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/{uuid.uuid4().hex}/render",
            headers=_service_auth(),
            json={},
        )
    # 422: the app maps ValidationError there. Any 4xx keeps the caller from
    # sending an empty email — vision falls back to its plain text on >=400.
    assert r.status_code == 422


# ── the wildcard admin ────────────────────────────────────────────────────────
#
# `require_service_permission` short-circuited on `is_superadmin` or a `*` claim
# and returned None — the same value it returns for a service token. Every real
# deployment's Administrator role holds `*`, so for the account that actually
# writes templates the route saw NO caller: it resolved the PLATFORM tenant
# instead of theirs.
#
# What that did, in the two shapes it takes:
#   • a CUSTOM name (the whole point of the feature) rendered 422 "unknown
#     template", after storing, listing and previewing perfectly;
#   • an override OF A BUILT-IN rendered the code default with no error at all —
#     the customisation silently ignored, which is the worse of the two because
#     the send succeeds and looks right.


async def test_a_wildcard_admin_renders_their_own_custom_template(app, db):
    acme = await _tenant(db, "render-wild")
    await template_store.upsert_override(
        db, "gate_breach_wild", "Gate: {{ title }}", "<p>{{ message }}</p>", tenant_id=acme.id
    )
    role = await make_role(db, "WildAdmin", ["*"])
    user = await make_user(db, "admin@wild.io", role)
    user.tenant_id = acme.id
    await db.commit()

    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/gate_breach_wild/render",
            headers=_auth(user),
            json={"context": {"title": "Forced", "message": "Door forced"}},
        )
    assert r.status_code == 200, r.text
    assert r.json()["subject"] == "Gate: Forced"


async def test_a_wildcard_admins_override_of_a_builtin_is_the_one_that_renders(app, db):
    # No 422 here to catch it: the built-in exists, so a lost tenant means the
    # WRONG email goes out rather than none.
    acme = await _tenant(db, "render-wild2")
    await template_store.upsert_override(
        db, "alert", "ACME {{ title }}", "<p>acme</p>", tenant_id=acme.id
    )
    role = await make_role(db, "WildAdmin2", ["*"])
    user = await make_user(db, "admin@wild2.io", role)
    user.tenant_id = acme.id
    await db.commit()

    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/alert/render",
            headers=_auth(user),
            json={"context": {"title": "x"}},
        )
    assert r.status_code == 200, r.text
    assert r.json()["subject"] == "ACME x"


async def test_a_superadmin_token_with_no_user_row_still_authorises(app, db):
    # The service path must keep working: no `users` row, `*` in the claims.
    await template_store.upsert_override(db, "svc_only", "S", "<p>hi</p>")
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/messaging/templates/svc_only/render",
            headers=_service_auth(),
            json={"context": {}, "wrap": False},
        )
    assert r.status_code == 200, r.text
    assert r.json()["html"] == "<p>hi</p>"
