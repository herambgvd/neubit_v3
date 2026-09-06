"""Shared setup for the ingest suite.

Ingest verifies core-minted JWTs with the kernel and has no user table, so tests
mint a token instead of logging in.

The DB is in-memory SQLite built from the real Base.metadata, with get_db
overridden — the routes run their real auth, scoping and transform code. NATS is
off, so publishing is a no-op.
"""

from __future__ import annotations

import datetime as dt
import os
import sys
import uuid
from pathlib import Path

import httpx
import jwt
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Import the kernel from the working tree, not the image's build-time snapshot at
# /opt/kernel — otherwise the suite tests code that is not the code being changed.
_KERNEL = Path(os.environ.get("VE_KERNEL_PATH") or "/src/kernel")
if (_KERNEL / "kernel" / "__init__.py").is_file():
    sys.path.insert(0, str(_KERNEL))

from kernel.config import get_settings  # noqa: E402

from app.db import Base, get_db  # noqa: E402

# Import the models so Base.metadata is complete — a table whose module has not
# been imported is silently missing from create_all.
import app.ingest.models  # noqa: E402,F401

PREFIX = "/api/v1"


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def sessionmaker_(engine):
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


@pytest_asyncio.fixture
async def session(sessionmaker_):
    async with sessionmaker_() as s:
        yield s


@pytest.fixture
def app(sessionmaker_):
    from app.main import create_app

    application = create_app()

    async def _override_db():
        async with sessionmaker_() as s:
            yield s

    application.dependency_overrides[get_db] = _override_db
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def token(*, tenant_id=None, permissions=None, is_superadmin=False) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    return jwt.encode(
        {
            "sub": str(uuid.uuid4()),
            "type": "access",
            "tenant_id": str(tenant_id) if tenant_id else None,
            "is_superadmin": is_superadmin,
            "permissions": ["*"] if is_superadmin else (permissions or []),
            "features": {"workflow": True},
            "license_state": "active",
            "tenant_status": "active",
            "iat": now,
            "exp": now + dt.timedelta(hours=1),
        },
        get_settings().jwt_secret,
        algorithm="HS256",
    )


def auth(**kw) -> dict:
    return {"Authorization": f"Bearer {token(**kw)}"}
