"""The live streams authenticate; they must also authorize.

Each of `/realtime/vms-events`, `/realtime/wall-events`, `/realtime/access-events`
and `/realtime/incidents` carries data whose REST equivalent is permission-gated, so
decoding the token and stopping there makes the stream a way around the permission
model. STREAMS below is the route-to-permission map, and it is asserted both ways.

Cross-tenant leaks are not the concern here: the NATS subject is built from the
caller's own tenant and fails closed to `tenant.__none__.…`.
"""


import pytest
import pytest_asyncio

from app.app import create_base_app
from app.db.base import get_db
from conftest import api_client, bearer, make_role, make_user

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"

STREAMS = {
    "/realtime/vms-events": "vms.camera.read",
    "/realtime/wall-events": "vms.wall.view",
    "/realtime/access-events": "access.read",
    "/realtime/incidents": "workflow.instance.read",
}


@pytest.fixture
def app(sessionmaker_, monkeypatch):
    application = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    application.dependency_overrides[get_db] = _override_db
    # authorize_stream opens its own short-lived session rather than taking one from
    # DI, because a StreamingResponse holds its dependencies for the life of the
    # stream. So the substitution here is of the sessionmaker, not the dependency.
    from app.db import base as db_base

    monkeypatch.setattr(db_base, "get_sessionmaker", lambda: sessionmaker_)
    return application


async def _status(app, path: str, headers: dict | None = None) -> int:
    """Status code of an SSE request, without ever waiting on the stream body.

    A refused request answers and ends; an accepted one opens a pipe and waits on
    NATS, of which there is none here, so a plain `c.get` would hang instead of
    failing. The request is raced against a short deadline and a timeout is reported
    as 200 — the stream opened, which is the failure being asserted against.
    """
    import asyncio

    async def _run() -> int:
        async with api_client(app) as c:
            async with c.stream("GET", f"{PREFIX}{path}", headers=headers or {}) as r:
                return r.status_code

    try:
        return await asyncio.wait_for(_run(), timeout=5.0)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return 200


@pytest_asyncio.fixture
async def nobody(db):
    """An ordinary, fully valid, entirely unprivileged user."""
    role = await make_role(db, "NoPerms", [])
    return await make_user(db, "nobody@x.io", role)


@pytest.mark.parametrize("path", sorted(STREAMS))
async def test_a_user_with_no_permissions_is_refused(app, nobody, path, db):
    """403 — authenticated, not authorized. The stream must not open."""
    assert await _status(app, path, bearer(nobody)) == 403, path


@pytest.mark.parametrize("perm", sorted(set(STREAMS.values())))
async def test_the_right_permission_passes_the_guard(app, db, perm, sessionmaker_):
    """The guard must not be "refuse everyone" — that would pass every test above.

    Calls the guard rather than opening the stream, because a 200 from an SSE route
    means the pipe is open and waiting on a broker that is not here. The route-to-key
    wiring is asserted separately in test_every_stream_is_wired_to_its_permission.
    """
    from app.core.sse_auth import authorize_stream

    role = await make_role(db, f"Holder-{perm}", [perm])
    user = await make_user(db, f"holder-{perm}@x.io", role)
    await authorize_stream({"sub": str(user.id)}, perm)  # must not raise


async def test_every_stream_is_wired_to_its_permission():
    """Each route calls authorize_stream with the key STREAMS names for it.

    Read from the source, because opening each stream needs a broker and hangs
    without one. Catches a stream gated on the wrong key, which reads as present.
    """
    import ast
    import pathlib as _pathlib

    core_dir = _pathlib.Path(__file__).resolve().parents[1] / "app" / "core"
    modules = {
        "/realtime/vms-events": "realtime_vms.py",
        "/realtime/wall-events": "realtime_wall.py",
        "/realtime/access-events": "realtime_access.py",
        "/realtime/incidents": "realtime_incidents.py",
    }
    from app.auth.permissions import CorePerm

    for path, filename in modules.items():
        tree = ast.parse((core_dir / filename).read_text())
        gated = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "authorize_stream":
                for arg in node.args[1:]:
                    if isinstance(arg, ast.Attribute):
                        gated.append(str(getattr(CorePerm, arg.attr)))
                    elif isinstance(arg, ast.Constant):
                        gated.append(arg.value)
        assert gated == [STREAMS[path]], f"{filename}: gated on {gated}, expected {STREAMS[path]}"


@pytest.mark.parametrize("path", sorted(STREAMS))
async def test_no_token_is_still_401(app, path):
    assert await _status(app, path) == 401, path


async def test_a_deactivated_user_cannot_open_a_stream(app, db):
    """The stream reads the live user row, not the token's claims. A stale token on
    REST costs one response; on a stream it is an open pipe until the token expires."""
    role = await make_role(db, "WasAllowed", ["vms.camera.read"])
    user = await make_user(db, "gone@x.io", role)
    token_headers = bearer(user)  # minted while the account was live
    user.is_active = False
    await db.commit()
    assert await _status(app, "/realtime/vms-events", token_headers) == 401


async def test_a_suspended_tenant_cannot_open_a_stream(app, db):
    """Streams need `require_tenant_active`'s guarantee too. Suspension is enforced
    at login, so a token minted before it would otherwise keep the feed open."""
    from app.tenancy.models import Tenant

    tenant = Tenant(name="Susp", slug="susp", status="active", features={}, limits={})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)
    role = await make_role(db, "Watcher", ["vms.camera.read"])
    user = await make_user(db, "watcher@x.io", role)
    user.tenant_id = tenant.id
    await db.commit()

    from fastapi import HTTPException

    from app.core.sse_auth import authorize_stream

    claims = {"sub": str(user.id)}
    await authorize_stream(claims, "vms.camera.read")  # control: fine while active

    tenant.status = "suspended"
    await db.commit()
    with pytest.raises(HTTPException) as caught:
        await authorize_stream(claims, "vms.camera.read")
    assert caught.value.status_code == 403
    assert caught.value.detail["code"] == "TENANT_SUSPENDED"

    # And over HTTP, so the refusal is what a client actually sees.
    assert await _status(app, "/realtime/vms-events", bearer(user)) == 403


# --- the stream is re-checked while it is open -------------------------------
#
# A check that runs only at connect leaves the pipe open for the life of the token,
# so deactivating a user or suspending a tenant would not touch the feed they
# already have.


@pytest_asyncio.fixture
async def always_revalidate(monkeypatch):
    """Interval 0, so every call re-checks. The real default is 60s."""
    from app.core import config

    monkeypatch.setenv("VE_SSE_REVALIDATE_SECONDS", "0")
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


async def test_a_guard_keeps_a_still_valid_stream_open(app, db, always_revalidate):
    from app.core.sse_auth import StreamGuard

    role = await make_role(db, "Watcher-ok", ["vms.camera.read"])
    user = await make_user(db, "watch-ok@x.io", role)
    guard = StreamGuard({"sub": str(user.id)}, "vms.camera.read")
    assert await guard.still_allowed() is True


async def test_a_guard_closes_a_stream_whose_user_was_deactivated(app, db, always_revalidate):
    from app.core.sse_auth import StreamGuard

    role = await make_role(db, "Watcher-deact", ["vms.camera.read"])
    user = await make_user(db, "watch-deact@x.io", role)
    guard = StreamGuard({"sub": str(user.id)}, "vms.camera.read")
    assert await guard.still_allowed() is True  # control

    user.is_active = False
    await db.commit()
    assert await guard.still_allowed() is False


async def test_a_guard_closes_a_stream_whose_permission_was_revoked(app, db, always_revalidate):
    from app.core.sse_auth import StreamGuard

    role = await make_role(db, "Watcher-revoked", ["vms.camera.read"])
    user = await make_user(db, "watch-rev@x.io", role)
    guard = StreamGuard({"sub": str(user.id)}, "vms.camera.read")
    assert await guard.still_allowed() is True

    role.permissions = []
    await db.commit()
    assert await guard.still_allowed() is False


async def test_a_guard_closes_a_stream_whose_tenant_was_suspended(app, db, always_revalidate):
    from app.core.sse_auth import StreamGuard
    from app.tenancy.models import Tenant

    tenant = Tenant(name="S", slug="guard-susp", status="active", features={}, limits={})
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)
    role = await make_role(db, "Watcher-susp", ["vms.camera.read"])
    user = await make_user(db, "watch-susp@x.io", role)
    user.tenant_id = tenant.id
    await db.commit()

    guard = StreamGuard({"sub": str(user.id)}, "vms.camera.read")
    assert await guard.still_allowed() is True

    tenant.status = "suspended"
    await db.commit()
    assert await guard.still_allowed() is False


async def test_a_guard_does_not_recheck_before_its_interval(app, db, monkeypatch):
    """The guard re-checks only every VE_SSE_REVALIDATE_SECONDS, to avoid a database
    round-trip per stream per keepalive. Ignoring the interval passes every other
    test in this file."""
    from app.core import config
    from app.core.sse_auth import StreamGuard

    monkeypatch.setenv("VE_SSE_REVALIDATE_SECONDS", "3600")
    config.get_settings.cache_clear()
    try:
        role = await make_role(db, "Watcher-lazy", ["vms.camera.read"])
        user = await make_user(db, "watch-lazy@x.io", role)
        guard = StreamGuard({"sub": str(user.id)}, "vms.camera.read")
        user.is_active = False
        await db.commit()
        # Deactivated, but the interval has not elapsed. The bounded staleness is
        # the deliberate trade of polling over a signal.
        assert await guard.still_allowed() is True
    finally:
        config.get_settings.cache_clear()


async def test_every_relay_uses_the_guard():
    """Four relays, four copies of the same loop — the guard has to be in all four."""
    import pathlib

    core_dir = pathlib.Path(__file__).resolve().parents[1] / "app" / "core"
    for name in ("realtime_vms.py", "realtime_wall.py", "realtime_access.py", "realtime_incidents.py"):
        src = (core_dir / name).read_text()
        assert "StreamGuard(" in src, f"{name} never constructs a guard"
        assert "await guard.still_allowed()" in src, f"{name} never asks the guard"
