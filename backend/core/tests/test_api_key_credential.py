"""The scoped service credential — what a key can do, and what it must never do.

Every test here is named for a property the credential is supposed to have, not
for a function, because the properties are the deliverable: a peer product is
going to hold one of these instead of a human's password, and each of the
assertions below is one of the reasons that is an improvement.

Driven through the real HTTP surface (httpx ASGITransport over the base app,
in-memory SQLite) rather than against the service methods, because half of what
is being asserted lives in the wiring — which dependency a route hangs off, which
claim a token carries, which path a 401 comes out of. A service-level test would
pass with the interactive login path wide open to a key.
"""

from __future__ import annotations

import datetime as dt

import httpx
import jwt
import pytest

from app.app import create_base_app
from app.auth.models import ApiKey
from app.auth.security import create_access_token, decode_token
from app.auth.service import AuthService
from app.core.audit import AuditLog
from app.db.base import get_db
from conftest import make_role, make_user
from sqlalchemy import select

pytestmark = pytest.mark.asyncio

PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def _fresh_rate_limit_buckets():
    """The limiter is a module-level dict keyed by client IP, and every test here
    arrives from the same ASGI "testclient" address. Without this the suite's own
    exchanges accumulate into one bucket and a later test 429s for a reason that
    has nothing to do with what it asserts — a failure that would read as a bug in
    the credential."""
    from app.core import ratelimit

    ratelimit._hits.clear()
    yield
    ratelimit._hits.clear()


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


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _admin(db):
    """An operator who can mint keys and holds every scope handed to one below —
    a creator can never grant more than they hold, so this list bounds the tests."""
    role = await make_role(db, "KeyAdmin", ["apikey.manage", "bi.read", "user.manage", "audit.read"])
    return await make_user(db, "keyadmin@x.io", role)


async def _mint(c, actor, **body) -> dict:
    body.setdefault("name", "DashForge BI reader")
    r = await c.post(f"{PREFIX}/auth/api-keys", headers=_auth(actor), json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def _exchange(c, raw: str) -> httpx.Response:
    return await c.post(f"{PREFIX}/auth/token", json={"api_key": raw})


# --- the credential's shape --------------------------------------------------
async def test_secret_is_shown_once_and_stored_only_as_a_hash(app, db):
    """Creation is the only moment the secret exists outside the caller."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        raw = created["key"]
        assert raw.startswith("nbk_")

        listed = await c.get(f"{PREFIX}/auth/api-keys", headers=_auth(actor))
        assert listed.status_code == 200
        (row,) = listed.json()["items"]
        assert "key" not in row
        # Not merely absent from the projection — absent from the response at all,
        # so a future field added to ApiKeyOut cannot leak it by accident.
        assert raw not in listed.text

    key = (await db.execute(select(ApiKey))).scalar_one()
    # The prefix is a dedicated id segment, NOT a slice of the secret: it is
    # printed in every listing, so anything it contains is public.
    assert key.prefix == raw[:12]
    assert raw[12:] not in key.key_hash
    assert key.key_hash != raw


async def test_a_key_cannot_hold_the_wildcard_by_any_route(app, db):
    """The unbounded machine credential must not be reachable at all.

    Two ways in: asking for "*" directly, and asking for it sideways by naming the
    built-in Administrator role, which is how the pre-2026-09-05 form produced one
    without anybody typing a wildcard.
    """
    actor = await _admin(db)
    admin_role = await make_role(db, "Administrator-wild", ["*"])
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/auth/api-keys", headers=_auth(actor),
            json={"name": "everything", "scopes": ["*"]},
        )
        assert r.status_code == 422 and "wildcard" in r.text

        r = await c.post(
            f"{PREFIX}/auth/api-keys", headers=_auth(actor),
            json={"name": "everything", "role_id": str(admin_role.id)},
        )
        assert r.status_code == 422 and "wildcard" in r.text


async def test_a_key_cannot_be_wider_than_its_creator(app, db):
    """Otherwise the facility is a privilege-escalation primitive: 'I cannot do X,
    but I can issue a credential that does X and then use it.'"""
    role = await make_role(db, "BiKeyMaker", ["apikey.manage", "bi.read"])
    actor = await make_user(db, "narrow@x.io", role)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/auth/api-keys", headers=_auth(actor),
            json={"name": "sneaky", "scopes": ["bi.read", "user.manage"]},
        )
        assert r.status_code == 422 and "user.manage" in r.text
        # The scope the creator DOES hold is still grantable — the rule narrows,
        # it does not just refuse.
        assert (await _mint(c, actor, scopes=["bi.read"]))["scopes"] == ["bi.read"]


async def test_a_scope_nothing_enforces_is_refused(app, db):
    """A key granting a permission no code checks reads as a restriction and is
    not one. Same failure the ingest.read note in permissions.py records."""
    actor = await _admin(db)
    async with _client(app) as c:
        r = await c.post(
            f"{PREFIX}/auth/api-keys", headers=_auth(actor),
            json={"name": "typo", "scopes": ["bi.raed"]},
        )
        assert r.status_code == 422 and "bi.raed" in r.text


# --- the exchange ------------------------------------------------------------
async def test_exchange_yields_an_ordinary_access_token_carrying_only_the_scopes(app, db):
    """The claim shape is the contract with eight untouched services.

    ``kernel.auth.verify_token`` is not changed by this feature and must not need
    to be: whatever a satellite reads off a person's token it reads off a key's.
    """
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        r = await _exchange(c, created["key"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["token_type"] == "bearer" and body["scopes"] == ["bi.read"]
        # 15 minutes, not the 12 hours a person gets: this number is the width of
        # the window in which a revoked key still works at the satellites.
        assert body["expires_in"] == 15 * 60

        claims = decode_token(body["access_token"])

    assert claims["type"] == "access"
    assert claims["permissions"] == ["bi.read"]
    assert claims["act"] == "apikey"
    # Hardcoded at the mint, never read off the creating admin, so a super-admin
    # cannot issue a key that inherits their reach.
    assert claims["is_superadmin"] is False
    assert claims["aud"] == "neubit-tenant"
    assert claims["role_id"] is None
    # ``sub`` is the KEY row, which is what makes the interactive path below refuse.
    key = (await db.execute(select(ApiKey))).scalar_one()
    assert claims["sub"] == str(key.id)


async def test_no_refresh_token_is_issued(app, db):
    """A refresh token would be a second long-lived credential with its own
    revocation story, surviving the revocation of the key that produced it."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        r = await _exchange(c, created["key"])
        assert "refresh_token" not in r.json()
        assert "nb_refresh" not in r.headers.get("set-cookie", "")


@pytest.mark.parametrize(
    "mangle",
    [
        pytest.param(lambda raw: "not-a-key", id="malformed"),
        pytest.param(lambda raw: "nbk_deadbeef_" + "x" * 43, id="unknown-prefix"),
        pytest.param(lambda raw: raw[:13] + "x" + raw[14:], id="wrong-secret"),
        pytest.param(lambda raw: "", id="empty"),
        pytest.param(lambda raw: "nbk_", id="prefix-only"),
    ],
)
async def test_every_bad_credential_fails_closed_and_identically(app, db, mangle):
    """One status, one message. A caller must not be able to learn from the
    response which keys exist, which prefixes are real, or which were revoked."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        r = await _exchange(c, mangle(created["key"]))
        assert r.status_code == 401
        assert r.json()["error"]["message"] == "invalid API key"


async def test_an_expired_key_is_refused(app, db):
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        assert (await _exchange(c, created["key"])).status_code == 200
        key = (await db.execute(select(ApiKey))).scalar_one()
        key.expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
        await db.commit()
        assert (await _exchange(c, created["key"])).status_code == 401


async def test_last_used_is_stamped_so_a_forgotten_key_is_visible(app, db):
    """'Issued 14 months ago' is normal. 'Issued 14 months ago, never used' is a
    credential to delete, and nothing else in the row can say it."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        key = (await db.execute(select(ApiKey))).scalar_one()
        assert key.last_used_at is None
        await _exchange(c, created["key"])
        await db.refresh(key)
        assert key.last_used_at is not None


# --- what a key must never be able to do -------------------------------------
async def test_a_key_cannot_sign_in_to_the_console(app, db):
    """The interactive path resolves ``sub`` to a users row and there is none.

    Not a check someone has to remember to write — a consequence of the shape. If
    this ever passes, somebody has taught ``get_current_user`` about API keys.
    """
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read", "user.manage"])
        token = (await _exchange(c, created["key"])).json()["access_token"]
        for path in ("/auth/me", "/auth/me/sessions", "/auth/me/2fa"):
            r = await c.get(f"{PREFIX}{path}", headers=_bearer(token))
            assert r.status_code == 401, f"{path} let a service key in: {r.text}"


async def test_a_key_is_confined_to_its_scopes_on_core_routes(app, db):
    """The BI-read key must not be able to create a user. Same 403, same line, as
    an under-privileged human — the credential kind only changes where the
    permission list is read from."""
    actor = await _admin(db)
    role = await make_role(db, "Target", ["bi.read"])
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["bi.read"])
        token = (await _exchange(c, created["key"])).json()["access_token"]

        r = await c.post(
            f"{PREFIX}/auth/users", headers=_bearer(token),
            json={"email": "made-by-a-key@x.io", "password": "Passw0rd!",
                  "full_name": "Nope", "role_id": str(role.id)},
        )
        assert r.status_code == 403 and "user.manage" in r.text

        # ...and cannot mint itself a wider key either.
        r = await c.post(
            f"{PREFIX}/auth/api-keys", headers=_bearer(token),
            json={"name": "bootstrap", "scopes": ["user.manage"]},
        )
        assert r.status_code == 403


async def test_a_key_can_reach_what_it_is_scoped_for(app, db):
    """The other half: a scope that IS held authorizes, or the facility is just an
    elaborate way of refusing everything."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["audit.read", "apikey.manage"])
        token = (await _exchange(c, created["key"])).json()["access_token"]
        r = await c.get(f"{PREFIX}/audit", headers=_bearer(token))
        assert r.status_code == 200, r.text


async def test_a_token_carrying_an_unknown_credential_kind_is_refused(app, db):
    """``act`` is a closed set. An unrecognised value must not fall through to the
    user branch, which is the branch with more reach."""
    actor = await _admin(db)
    forged = jwt.encode(
        {**decode_token(create_access_token(actor, sid="t")), "act": "something-new"},
        "test-jwt-secret",
        algorithm="HS256",
    )
    async with _client(app) as c:
        r = await c.get(f"{PREFIX}/audit", headers=_bearer(forged))
        assert r.status_code == 401


# --- revocation --------------------------------------------------------------
async def test_revocation_is_immediate_and_touches_no_user_account(app, db):
    """The reason nobody ever revokes anything is that the safe action disables a
    person. Here it disables one credential and nothing else."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["audit.read"])
        token = (await _exchange(c, created["key"])).json()["access_token"]
        assert (await c.get(f"{PREFIX}/audit", headers=_bearer(token))).status_code == 200

        r = await c.delete(f"{PREFIX}/auth/api-keys/{created['id']}", headers=_auth(actor))
        assert r.status_code == 204

        # The token that was already minted stops working on core AT ONCE, because
        # core re-reads the key row exactly as it re-reads a user row.
        assert (await c.get(f"{PREFIX}/audit", headers=_bearer(token))).status_code == 401
        # And no further token can be obtained.
        assert (await _exchange(c, created["key"])).status_code == 401

        # The operator who created it is untouched.
        assert (await c.get(f"{PREFIX}/auth/me", headers=_auth(actor))).status_code == 200

    key = (await db.execute(select(ApiKey))).scalar_one()
    assert key.is_active is False and key.revoked_at is not None


# --- the audit trail ---------------------------------------------------------
async def test_a_keys_action_is_not_recorded_as_a_persons(app, db):
    """A credential that cannot be told apart from a person in the trail has not
    solved the problem it was built for."""
    actor = await _admin(db)
    async with _client(app) as c:
        created = await _mint(c, actor, scopes=["apikey.manage", "bi.read"])
        token = (await _exchange(c, created["key"])).json()["access_token"]
        r = await c.post(
            f"{PREFIX}/auth/api-keys", headers=_bearer(token),
            json={"name": "second key, made by the first", "scopes": ["bi.read"]},
        )
        assert r.status_code == 201, r.text

    rows = (await db.execute(select(AuditLog).order_by(AuditLog.ts))).scalars().all()
    by_key = [r for r in rows if r.actor_type == "apikey"]
    by_person = [r for r in rows if r.actor_type == "user"]
    assert len(by_key) == 1 and len(by_person) == 1

    (machine,) = by_key
    assert machine.action == "apikey.create"
    assert str(machine.actor_id) == created["id"]
    # No email, because a key has no email. The row is visibly not a person even
    # before actor_type is read.
    assert machine.actor_email is None
    assert machine.actor_name == "DashForge BI reader"
    # The scopes are in the meta so the trail stays legible after the key row is
    # revoked and purged.
    assert machine.meta["scopes"] == ["bi.read"]

    (person,) = by_person
    assert person.actor_email == "keyadmin@x.io" and person.actor_type == "user"


async def test_system_actions_are_classified_as_system_not_as_users(db):
    """The actor-less rows always meant 'system'; actor_type is the first place it
    could be said, and saying 'user' there would have been a new lie."""
    from app.core.audit import record

    entry = await record(db, actor=None, action="tenant.offboard", target_type="tenant")
    assert entry.actor_type == "system"


# --- the additive guarantee --------------------------------------------------
async def test_a_login_token_behaves_exactly_as_before(app, db):
    """This feature is verified by nine services continuing to work, not by the
    tests above passing. This is the part of that claim a unit test can hold: a
    token with no ``act`` claim takes an unchanged path.
    """
    actor = await _admin(db)
    claims = decode_token(create_access_token(actor, sid="t"))
    assert "act" not in claims
    async with _client(app) as c:
        assert (await c.get(f"{PREFIX}/auth/me", headers=_auth(actor))).status_code == 200
        assert (await c.get(f"{PREFIX}/auth/api-keys", headers=_auth(actor))).status_code == 200
        # A permission the role does not hold is still a 403 and not a 401: the
        # rewritten require_permission resolves the actor first and refuses on the
        # permission, exactly as the get_current_user-based version did.
        narrow = await make_user(
            db, "narrowest@x.io", await make_role(db, "NoAudit", ["user.read"])
        )
        assert (await c.get(f"{PREFIX}/audit", headers=_auth(narrow))).status_code == 403


async def test_service_method_refuses_a_key_with_no_scopes_at_all(db):
    """Belt and braces on the storage default: an empty scope list grants nothing,
    so a row that somehow arrives without scopes is inert rather than permissive."""
    key = ApiKey(name="inert", prefix="nbk_00000000", key_hash="x", scopes=[])
    assert key.grants("bi.read") is False
    assert key.grants("*") is False

    from app.core.errors import ValidationError
    from app.auth.schemas import ApiKeyCreateIn

    with pytest.raises(ValidationError):
        await AuthService(db)._resolve_scopes(
            ApiKeyCreateIn(name="inert", scopes=[]), None, None
        )
