"""Shared setup for the reading-writer suite.

Most of this suite is PURE — the writer's decisions (which points earn a dimension
row, how a metric expression normalises, what a batch may say about last_seen_at)
are pure functions and are tested as such, with no database anywhere.

What was missing is the other half. The BI read API is 30 routes behind a JWT, a
module gate and a per-route permission, and not one of them had ever been CALLED.
A permission dependency can be declared and never reached; only the wire can tell.
These fixtures are what let that be asked.
"""

from __future__ import annotations

import datetime as _dt
import uuid as _uuid

import httpx
import jwt
import pytest

from kernel.config import get_settings

PREFIX = "/api/v1"


class _RefusedSession:
    """A session that fails if anything touches it.

    The route inventory asserts REFUSALS, and a refusal happens in a dependency
    before any query runs. Handing the app a working database would let a route
    pass the test by reaching the store and returning empty; handing it this one
    means a 401 or 403 is proof the request never got that far.

    It also sidesteps a real incompatibility: the reporting models use Postgres
    JSONB, which SQLite cannot compile, so `create_all` against sqlite fails
    outright. A test that needs the schema needs Postgres, and none here does.
    """

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __getattr__(self, name):
        raise AssertionError(
            f"the database was used (session.{name}) — this request should have "
            f"been refused before any query"
        )


@pytest.fixture
def app():
    # Imported here, not at module load: the app reads settings and wires a
    # lifespan that starts six consumers, and the overridden get_db has to be in
    # place first.
    from reporting.db import get_db

    from app.main import app as application

    async def _override_db():
        yield _RefusedSession()

    application.dependency_overrides[get_db] = _override_db
    try:
        yield application
    finally:
        application.dependency_overrides.clear()


def client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def token(*, tenant_id, permissions=None, is_superadmin=False) -> str:
    """A core-shaped access token the kernel will verify.

    `features` and `license_state` satisfy the two gates main.py mounts the BI API
    behind (the tenant's `analytics` module and an unexpired licence); these tests
    are not exercising those.
    """
    now = _dt.datetime.now(_dt.timezone.utc)
    return jwt.encode(
        {
            "sub": str(_uuid.uuid4()),
            "type": "access",
            "tenant_id": str(tenant_id) if tenant_id else None,
            "is_superadmin": is_superadmin,
            "permissions": ["*"] if is_superadmin else (permissions or []),
            "features": {"analytics": True},
            "license_state": "active",
            "tenant_status": "active",
            "iat": now,
            "exp": now + _dt.timedelta(hours=1),
        },
        get_settings().jwt_secret,
        algorithm="HS256",
    )


def auth(**kw) -> dict:
    return {"Authorization": f"Bearer {token(**kw)}"}
