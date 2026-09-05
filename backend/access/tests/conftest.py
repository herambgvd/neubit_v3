"""Shared setup for the access suite — the first tests this service has.

The pattern is core's (backend/core/tests/conftest.py), adapted to a satellite:

  * Access verifies core-minted JWTs locally with the kernel — there is no user
    table here — so a test does not "log in", it MINTS a token with the same
    HS256 secret the running service verifies against (VE_JWT_SECRET, set by
    run-tests.sh). ``token()`` builds one for a given tenant / permission set;
    that is the whole auth surface.

  * The DB is an in-memory aiosqlite engine holding ONLY the access tables, built
    from the real ``Base.metadata``. The app's ``get_db`` is overridden to it, so
    the routes run their real service/scope/ownership code against a real (if
    ephemeral) database — nothing is mocked below the HTTP edge.

  * NATS is off (VE_NATS_URL empty): ``bus.connect`` is a no-op and ``emit`` is
    best-effort, so event publishing neither blocks nor fails a test. The
    ingestion supervisor is never started because tests drive ``create_app`` and
    the ASGI transport directly, not the lifespan.
"""

from __future__ import annotations

import datetime as dt
import os
import sys
import uuid
from pathlib import Path

# --- the kernel under test is the WORKING TREE's, not the image's ------------
#
# Every satellite image installs the kernel editable from /opt/kernel, a snapshot
# taken at build time. run-tests.sh mounts the working tree at /src, so without
# this the suite would import the kernel the image was BUILT with and quietly pass
# against code that is not the code being changed — the exact shape of "green for
# the wrong reason" these tests exist to prevent. Prepended, so /src/kernel wins.
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

    `features`/`license_state` are set so `require_feature("access")` and
    `require_active_license()` — the two gates main.py mounts the whole API behind
    — pass; a test is not exercising those here.
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
