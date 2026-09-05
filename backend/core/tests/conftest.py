"""Shared pytest fixtures for core tests.

Builds an in-memory SQLite database with the full ORM metadata (create_all), a
session factory bound to it, and helpers to seed a role + user so the security
tests can run without Postgres or Docker.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

# Deterministic secrets so Fernet encryption is stable across the test process.
os.environ.setdefault("VE_SECRETS_KEY", "test-secrets-key")
os.environ.setdefault("VE_JWT_SECRET", "test-jwt-secret")

# --- the shared kernel, for the ONE cross-package test in this suite ----------
#
# ``test_token_role_id.py`` asserts a two-sided contract: core MINTS the
# ``role_id`` claim and the shared kernel READS it back onto a Principal. It has
# to import both halves, and core's image installs only one of them — deliberately.
# Core is the identity provider; ``kernel`` is the SDK the satellites embed
# (every satellite Dockerfile does `COPY kernel /opt/kernel` + an editable
# install, core's does not, and core's build context is backend/core so the
# package is not even reachable). Making core depend on the kernel at runtime
# would invert that relationship to make a test convenient.
#
# The consequence was worse than one unverified contract: an ImportError at
# COLLECTION aborts the whole run, so `pytest tests` in the core container
# reported "1 error during collection" and ran NONE of the security suite —
# tenant isolation, dual-auth, entitlements, all of it silently unrun behind one
# missing module.
#
# So the sibling package is put on sys.path when it is not already importable:
# backend/kernel in a source checkout, /opt/kernel where every satellite image
# installs it, or VE_KERNEL_PATH. Deliberately NOT a try/except-and-skip in the
# test module — a contract test that quietly skips itself is the same class of
# lie this comment exists to end. If the kernel is genuinely not on disk the
# import still fails, loudly, and it should.
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
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


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
