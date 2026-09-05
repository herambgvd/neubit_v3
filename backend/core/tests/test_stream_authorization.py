"""The live streams authenticate; they must also authorize.

`/realtime/vms-events`, `/realtime/wall-events`, `/realtime/access-events` and
`/realtime/incidents` each decoded the caller's token and stopped there. A tenant
user holding NO permissions at all received a live feed of camera events, operator
popups, video-wall state, door and cardholder access events and workflow incidents —
data whose REST equivalents are gated (`vms.camera.read` is enforced at 26 sites in
the vision service). The stream was the way AROUND the permission model.

There is no cross-tenant leak in either version: the NATS subject is built from the
caller's own tenant and fails closed to `tenant.__none__.…`. This is about a
permission model that two whole surfaces did not participate in.
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

from app.app import create_base_app
from app.auth.security import create_access_token
from app.db.base import get_db
from conftest import make_role, make_user

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
    # authorize_stream opens its OWN short-lived session rather than taking one from
    # DI, because a StreamingResponse holds its dependencies for the life of the
    # stream and these streams last hours. So the factory is what gets substituted
    # here — the code under test is unchanged, only where it gets a connection.
    from app.db import base as db_base

    monkeypatch.setattr(db_base, "get_sessionmaker", lambda: sessionmaker_)
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def _auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user, sid='test')}"}


async def _status(app, path: str, headers: dict | None = None) -> int:
    """Status code of an SSE request, without ever waiting on the stream body.

    A REFUSED request answers and ends. An ACCEPTED one opens a pipe and waits on
    NATS, and there is no NATS here — a plain `c.get` would buffer the body and the
    test would HANG rather than fail. That matters: the way this suite reports "the
    gate was removed" must be a red test, not a stuck one. So the request is raced
    against a short deadline and a timeout is reported AS 200 — the stream opened,
    which is exactly the failure the caller is asserting against.
    """
    import asyncio

    async def _run() -> int:
        async with _client(app) as c:
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
    assert await _status(app, path, _auth(nobody)) == 403, path


@pytest.mark.parametrize("perm", sorted(set(STREAMS.values())))
async def test_the_right_permission_passes_the_guard(app, db, perm, sessionmaker_):
    """The guard must not be "refuse everyone" — that would pass every test above
    while breaking the product.

    This calls the guard rather than opening the stream. A 200 from an SSE route
    means the pipe is open and waiting on NATS, and there is no NATS here; the
    request would hang rather than fail, which is worse than a red test. The
    ROUTE-to-KEY wiring is asserted separately, by reading the source, in
    test_every_stream_is_wired_to_its_permission.
    """
    from app.core.sse_auth import authorize_stream

    role = await make_role(db, f"Holder-{perm}", [perm])
    user = await make_user(db, f"holder-{perm}@x.io", role)
    await authorize_stream({"sub": str(user.id)}, perm)  # must not raise


def test_every_stream_is_wired_to_its_permission():
    """Each route calls authorize_stream with the key STREAMS names for it.

    Read from the source, because the alternative — opening each stream and
    asserting 200 — needs a broker and answers by hanging when there is not one.
    This catches the failure that matters: a stream gated on the WRONG key, which
    is a permission check that looks present in review and is not.
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
    """The stream reads the LIVE user row, not the token's claims. A stream is where
    a stale token is most expensive: one REST call with a stale token is one
    response, a stream is an open pipe for the life of the token."""
    role = await make_role(db, "WasAllowed", ["vms.camera.read"])
    user = await make_user(db, "gone@x.io", role)
    token_headers = _auth(user)  # minted while the account was live
    user.is_active = False
    await db.commit()
    assert await _status(app, "/realtime/vms-events", token_headers) == 401


async def test_a_suspended_tenant_cannot_open_a_stream(app, db):
    """`require_tenant_active`'s guarantee, which streams did not have. Core refuses
    a suspended tenant at LOGIN; without this, a token minted before the suspension
    keeps a feed of that tenant's data open until it expires."""
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
    assert await _status(app, "/realtime/vms-events", _auth(user)) == 403
