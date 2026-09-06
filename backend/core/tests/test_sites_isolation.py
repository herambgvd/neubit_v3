"""Cross-tenant isolation on the sites surface — the first HTTP tests it has.

The asymmetry to watch for across `sites/`, `floors/` and `zones/`: create vets
`parent_id`'s tenancy while update runs a cycle check and then blind-`setattr`s the
body. `Site.parent_id` has no ForeignKey, so the database will not object either,
and the resulting cross-tenant edge is republished on NATS to reporting and BI.

Same harness as test_tenant_isolation.py: the full base app on in-memory SQLite.
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select

from app.app import create_base_app
from app.auth.models import User
from app.auth.security import create_access_token, hash_password
from app.db.base import get_db
from app.sites.floor.models import Floor
from app.sites.site.models import Site
from app.tenancy.models import Tenant
from conftest import make_role

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


@pytest_asyncio.fixture
async def world(db):
    """Two tenants, an admin each, and one site per tenant."""
    role = await make_role(
        db, "SiteAdmin", ["sites.read", "sites.create", "sites.update", "sites.delete"]
    )
    ta = Tenant(name="Tenant A", slug="site-a", status="active", features={}, limits={})
    tb = Tenant(name="Tenant B", slug="site-b", status="active", features={}, limits={})
    db.add_all([ta, tb])
    await db.commit()
    await db.refresh(ta)
    await db.refresh(tb)

    async def _user(email, tenant_id):
        u = User(
            email=email,
            full_name=email.split("@")[0],
            role_id=role.id,
            password_hash=hash_password("Passw0rd!"),
            is_active=True,
            tenant_id=tenant_id,
        )
        db.add(u)
        await db.commit()
        await db.refresh(u)
        await db.refresh(u, attribute_names=["role"])
        return u

    async def _site(name, tenant_id):
        s = Site(tenant_id=tenant_id, name=name, site_type="building", is_active=True)
        db.add(s)
        await db.commit()
        await db.refresh(s)
        return s

    return {
        "ta": ta,
        "tb": tb,
        "a_admin": await _user("a-site@x.io", ta.id),
        "b_admin": await _user("b-site@x.io", tb.id),
        "a_site": await _site("A Tower", ta.id),
        "b_site": await _site("B Tower", tb.id),
        # A platform-scoped site: `owns()` must not treat NULL tenant_id as owned by
        # everyone, which would make this updatable and deletable by any tenant.
        "platform_site": await _site("Shared Campus", None),
    }


async def test_create_rejects_a_parent_in_another_tenant(app, world):
    """The check that already existed — kept as the control for the one that didn't."""
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/sites",
            headers=_auth(world["a_admin"]),
            json={"name": "Child", "parent_id": str(world["b_site"].site_id)},
        )
    assert r.status_code == 409, r.text


async def test_update_rejects_a_parent_in_another_tenant(app, world, db):
    """The one that did not. The row is re-read because a 409 alone would not catch a
    blind setattr that had already persisted the edge.
    """
    a_id = world["a_site"].site_id
    async with _client(app) as c:
        r = await c.patch(
            f"{PREFIX}/sites/{a_id}",
            headers=_auth(world["a_admin"]),
            json={"parent_id": str(world["b_site"].site_id)},
        )
    assert r.status_code == 409, r.text
    db.expire_all()
    row = (await db.execute(select(Site).where(Site.site_id == a_id))).scalar_one()
    assert row.parent_id is None


async def test_update_still_allows_a_parent_in_the_same_tenant(app, world, db):
    """Re-parenting is supported and must survive the guard, or the tests above pass
    against a version that refuses every parent.
    """
    a_id = world["a_site"].site_id
    async with _client(app) as c:
        child = await c.post(
            f"{PREFIX}/sites", headers=_auth(world["a_admin"]), json={"name": "A Annexe"}
        )
        assert child.status_code in (200, 201), child.text
        child_id = child.json()["site_id"]
        r = await c.patch(
            f"{PREFIX}/sites/{child_id}",
            headers=_auth(world["a_admin"]),
            json={"parent_id": str(a_id)},
        )
    assert r.status_code == 200, r.text
    assert r.json()["parent_id"] == str(a_id)


async def test_a_tenant_cannot_read_or_write_a_platform_site(app, world, db):
    """NULL tenant_id is a tenancy, not a wildcard."""
    pid = world["platform_site"].site_id
    async with _client(app) as c:
        got = await c.get(f"{PREFIX}/sites/{pid}", headers=_auth(world["a_admin"]))
        patched = await c.patch(
            f"{PREFIX}/sites/{pid}", headers=_auth(world["a_admin"]), json={"name": "Seized"}
        )
        deleted = await c.delete(f"{PREFIX}/sites/{pid}", headers=_auth(world["a_admin"]))
    assert got.status_code == 404, got.text
    assert patched.status_code == 404, patched.text
    assert deleted.status_code in (404, 405), deleted.text
    db.expire_all()
    row = (await db.execute(select(Site).where(Site.site_id == pid))).scalar_one()
    assert row.name == "Shared Campus"


async def test_cross_tenant_site_by_id_is_404(app, world):
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/sites/{world['b_site'].site_id}", headers=_auth(world["a_admin"]))
    assert r.status_code == 404


async def test_site_list_is_tenant_scoped(app, world):
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/sites", headers=_auth(world["a_admin"]))
    assert r.status_code == 200
    body = r.json()
    names = {s["name"] for s in (body["items"] if isinstance(body, dict) else body)}
    assert "A Tower" in names
    assert "B Tower" not in names
    assert "Shared Campus" not in names


# --- the immutable-field guard (app/sites/mutation.py) ----------------------
#
# The floor and zone update schemas happen to omit site_id/floor_id, so a blind
# setattr loop is safe only by accident — one added field from a structural move.
# apply_update states the rule instead. These call the helper directly, since the
# schemas do refuse the field at the HTTP edge today.


def test_apply_update_refuses_a_structural_move():
    from app.core.errors import ValidationError
    from app.sites.mutation import apply_update

    class Row:
        site_id = "own"
        name = "before"

    row = Row()
    with pytest.raises(ValidationError):
        apply_update(row, {"name": "after", "site_id": "someone-elses"})
    # Refused as a whole: the permitted field must not have landed either.
    assert row.site_id == "own"
    assert row.name == "before"


def test_apply_update_writes_everything_else():
    from app.sites.mutation import apply_update

    class Row:
        name = "before"
        parent_id = None

    row = Row()
    apply_update(row, {"name": "after"})
    assert row.name == "after"
    # `allow` re-permits a key the caller has already validated.
    apply_update(row, {"parent_id": "vetted"}, allow=frozenset({"parent_id"}))
    assert row.parent_id == "vetted"
