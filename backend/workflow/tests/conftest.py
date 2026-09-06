"""Shared test setup for the workflow suite.

  * ``run_async`` — the tests are synchronous functions driving async code, so each
    owns its event loop via ``asyncio.run``. Not pytest-asyncio: there are no async
    fixtures, and adding a plugin plus a marker everywhere would change what runs.

  * ``make_sqlite_session`` — an in-memory aiosqlite engine holding only the tables
    a test names. The models use portable column types so they build on SQLite;
    creating the whole metadata would couple every test to every table.

pytest puts this directory on ``sys.path`` (no ``__init__.py``, default prepend
import mode), which is why the test modules import from ``conftest`` by name.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings

from app.db import Base


def run_async(coro):
    return asyncio.run(coro)


async def make_sqlite_session(*tables):
    """Build an in-memory SQLite engine holding exactly ``tables``.

    Returns ``(engine, sessionmaker)``. The engine is the caller's to dispose.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=list(tables)))
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    return engine, sm

# ── HTTP-level fixtures ──────────────────────────────────────────────────────
#
# The suite was entirely pure: 55 routes and not one of them had ever been
# CALLED. `test_route_permissions.py` walks `route.dependant` and asserts a gate is
# declared, which is the right check for "somebody forgot the gate" and is not the
# same question as "the gate answers" — a dependency can be declared and never
# reached. These fixtures are what let the second question be asked.
#
# The whole metadata is created here, unlike `make_sqlite_session`: a route can
# touch any table, so a per-test table list would be a list of what each route
# happens to touch today.

import datetime as _dt
import uuid as _uuid

import httpx
import jwt

PREFIX = "/api/v1"


@pytest_asyncio.fixture
async def http_sessionmaker():
    import app.workflow.tables  # noqa: F401 — registers every model on Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        # Dispose, or aiosqlite's worker thread outlives the loop and pytest
        # reports it as an unhandled thread exception.
        await engine.dispose()


@pytest.fixture
def app(http_sessionmaker):
    # Imported here, not at module load: create_app() reads settings and wires the
    # lifespan, and the overridden get_db has to be in place first.
    from app.db import get_db
    from app.main import create_app

    application = create_app()

    async def _override_db():
        async with http_sessionmaker() as session:
            yield session

    application.dependency_overrides[get_db] = _override_db
    return application


def client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def token(*, tenant_id, permissions=None, is_superadmin=False) -> str:
    """A core-shaped access token the kernel will verify.

    `features` and `license_state` satisfy the two gates main.py mounts the API
    behind; these tests are not exercising those.
    """
    now = _dt.datetime.now(_dt.timezone.utc)
    return jwt.encode(
        {
            "sub": str(_uuid.uuid4()),
            "type": "access",
            "tenant_id": str(tenant_id) if tenant_id else None,
            "is_superadmin": is_superadmin,
            "permissions": ["*"] if is_superadmin else (permissions or []),
            "features": {"workflow": True},
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
