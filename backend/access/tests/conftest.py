"""Shared setup for the access suite.

Access verifies core-minted JWTs with the kernel and has no user table, so tests
mint a token with the same HS256 secret instead of logging in.

The DB is in-memory SQLite built from the real Base.metadata, with get_db
overridden — routes run their real scope/ownership code, nothing below the HTTP
edge is mocked. NATS is off, so event publishing is a no-op.
"""

from __future__ import annotations

import datetime as dt
import os
import sys
import uuid
from pathlib import Path

# Import the kernel from the working tree, not the image's build-time snapshot at
# /opt/kernel — otherwise the suite tests code that is not the code being changed.
_KERNEL = Path(os.environ.get("VE_KERNEL_PATH") or "/src/kernel")
if (_KERNEL / "kernel" / "__init__.py").is_file():
    sys.path.insert(0, str(_KERNEL))

import httpx
import jwt
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings

from app.db import Base, get_db

# Import the models so Base.metadata is complete. A table whose module has not
# been imported is silently missing from create_all — the same gotcha
# migrations/env.py documents.
import app.access.models  # noqa: E402,F401

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
    # Import here, not at module load: create_app() reads settings and wires the
    # lifespan, and we want the overridden get_db in place first.
    from app.main import create_app

    application = create_app()

    async def _override_db():
        async with sessionmaker_() as s:
            yield s

    application.dependency_overrides[get_db] = _override_db
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def token(
    *,
    tenant_id: uuid.UUID | None,
    permissions: list[str] | None = None,
    is_superadmin: bool = False,
) -> str:
    """A core-shaped access token the kernel will verify.

    features/license_state are set so the two gates main.py mounts the API behind
    pass; these tests are not exercising them.
    """
    now = dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": str(uuid.uuid4()),
        "type": "access",
        "tenant_id": str(tenant_id) if tenant_id else None,
        "is_superadmin": is_superadmin,
        "permissions": ["*"] if is_superadmin else (permissions or []),
        "features": {"access": True},
        "license_state": "active",
        "tenant_status": "active",
        "iat": now,
        "exp": now + dt.timedelta(hours=1),
    }
    return jwt.encode(claims, get_settings().jwt_secret, algorithm="HS256")


def auth(**kw) -> dict:
    return {"Authorization": f"Bearer {token(**kw)}"}
