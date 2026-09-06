"""Pytest config for the VMS driver tests.

NO live devices are touched — every network boundary is monkeypatched with fabricated
fixtures (SOAP objects mimicking python-onvif-zeep return shapes, ISAPI XML, Dahua CGI
text, Lumina JSON). ``pytest-asyncio`` in auto mode (``asyncio_mode = "auto"`` in
pyproject) runs the ``async def test_*`` coroutines — no per-test marker needed.
"""

from __future__ import annotations

# ── HTTP-level fixtures ──────────────────────────────────────────────────────
#
# The suite drives services and drivers directly and never called a ROUTE. That is
# fine for a driver test and not fine for a gate: a permission dependency can be
# declared and never reached, and nothing here could tell the difference. These
# build the real app with `get_db` overridden.

import datetime as _dt
import uuid as _uuid

import httpx
import jwt
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings

from app.db import Base

PREFIX = "/api/v1"


@pytest_asyncio.fixture
async def http_sessionmaker():
    # Import every model package FIRST. A table whose module has not been imported
    # is silently absent from Base.metadata, and create_all then builds a schema
    # that is missing exactly the table the test is about.
    import app.vms.models  # noqa: F401

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        # Dispose, or aiosqlite's worker thread outlives the loop this ran on and
        # pytest reports it as an unhandled thread exception.
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

    `features` and `license_state` satisfy the gates main.py mounts the API behind;
    these tests are not exercising those.
    """
    now = _dt.datetime.now(_dt.timezone.utc)
    return jwt.encode(
        {
            "sub": str(_uuid.uuid4()),
            "type": "access",
            "tenant_id": str(tenant_id) if tenant_id else None,
            "is_superadmin": is_superadmin,
            "permissions": ["*"] if is_superadmin else (permissions or []),
            "features": {"vms": True, "vision": True},
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
