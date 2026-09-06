"""Shared pytest fixtures for core tests.

Builds an in-memory SQLite database with the full ORM metadata (create_all), a
session factory bound to it, and helpers to seed a role + user so the security
tests can run without Postgres or a Docker network.

Run the suite with `./backend/core/run-tests.sh` from anywhere in the repo. A bare
`pytest` on the host has none of core's dependencies installed, and a bare `pytest`
inside the running core container is missing the shared kernel one test needs.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

# Deterministic secrets so Fernet encryption is stable across the test process.
#
# The JWT secret is >=32 bytes because that is what `_enforce_secrets` requires of
# a real deployment (RFC 7518 §3.2 for HS256) and because PyJWT warns below it —
# the old 15-byte value produced an InsecureKeyLengthWarning on every token this
# suite minted. A test key that a production boot would refuse is a test key that
# is not exercising the shipped configuration.
os.environ.setdefault("VE_SECRETS_KEY", "test-secrets-key-deterministic")
os.environ.setdefault(
    "VE_JWT_SECRET", "test-jwt-secret-deterministic-and-long-enough-for-hs256"
)

# The rate limiter defaults to Redis and this suite runs with `--network none`, so
# select the per-process window explicitly rather than letting every request take
# the fail-open path. test_rate_limit.py drives the Redis backend directly, against
# an in-process double.
os.environ.setdefault("VE_RATE_LIMIT_BACKEND", "memory")

# --- the shared kernel, for the ONE cross-package test in this suite ----------
#
# `test_token_role_id.py` asserts a two-sided contract: core mints the `role_id`
# claim and the shared kernel reads it back onto a Principal. Core's image installs
# only core, deliberately — core is the identity provider and `kernel` is the SDK
# the satellites embed, so a runtime dependency on it would invert that.
#
# So put the sibling package on sys.path when it is not already importable:
# backend/kernel relative to this file (what run-tests.sh mounts), /opt/kernel where
# satellite images install it, or VE_KERNEL_PATH. Deliberately not a
# try/except-and-skip in the test module, because a contract test that skips itself
# proves nothing; if the kernel is genuinely absent the import fails loudly, and
# `--continue-on-collection-errors` in pyproject.toml keeps that one module's error
# from aborting the rest of the suite.
def _ensure_kernel_importable() -> None:
    try:
        import kernel  # noqa: F401
        return
    except ImportError:
        pass
    here = Path(__file__).resolve()
    candidates = [
        Path(p) for p in (os.environ.get("VE_KERNEL_PATH"),) if p
    ] + [
        # backend/core/tests/conftest.py -> backend/kernel
        here.parent.parent.parent / "kernel",
        Path("/opt/kernel"),
    ]
    for cand in candidates:
        if (cand / "kernel" / "__init__.py").is_file():
            sys.path.insert(0, str(cand))
            return


_ensure_kernel_importable()

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from app.auth.models import Role, User  # noqa: E402
from app.auth.permissions import WILDCARD  # noqa: E402
from app.auth.security import hash_password  # noqa: E402
from app.db.base import Base  # noqa: E402


def _import_all_models() -> None:
    import app.auth.models  # noqa: F401
    import app.branding.models  # noqa: F401
    import app.core.audit  # noqa: F401
    import app.dashforge.models  # noqa: F401
    import app.device_brands.models  # noqa: F401
    import app.messaging  # noqa: F401
    import app.module_catalog.models  # noqa: F401
    import app.reports.models  # noqa: F401
    import app.security.models  # noqa: F401
    import app.settings.models  # noqa: F401
    import app.sites.device.models  # noqa: F401
    import app.sites.floor.models  # noqa: F401
    import app.sites.site.models  # noqa: F401
    import app.sites.zone.models  # noqa: F401
    import app.tags.models  # noqa: F401
    import app.tenancy.models  # noqa: F401


@pytest_asyncio.fixture
async def sessionmaker_() -> async_sessionmaker[AsyncSession]:
    _import_all_models()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        # Dispose, or aiosqlite's connection worker THREAD outlives the event loop
        # this fixture ran on. The thread then calls call_soon_threadsafe on a
        # closed loop and dies, which pytest reports as
        # PytestUnhandledThreadExceptionWarning — 50 of them in this suite. None
        # was a bug in the code under test, and that is the problem: 50 warnings
        # of a kind that is USUALLY worth reading is where a real one hides.
        await engine.dispose()


@pytest_asyncio.fixture
async def db(sessionmaker_) -> AsyncSession:
    async with sessionmaker_() as session:
        yield session


async def make_role(db: AsyncSession, name: str, perms: list[str]) -> Role:
    role = Role(name=name, permissions=perms)
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return role


async def make_user(
    db: AsyncSession, email: str, role: Role, *, password: str = "Passw0rd!", superadmin: bool = False
) -> User:
    user = User(
        email=email,
        full_name=email.split("@")[0],
        role_id=role.id,
        password_hash=hash_password(password),
        is_active=True,
        is_superadmin=superadmin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    # eager-load the role relationship for permission checks
    await db.refresh(user, attribute_names=["role"])
    return user


@pytest_asyncio.fixture
async def admin_role(db) -> Role:
    return await make_role(db, "Administrator-test", [WILDCARD])
