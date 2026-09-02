"""Shared pytest fixtures for core tests.

Builds an in-memory SQLite database with the full ORM metadata (create_all), a
session factory bound to it, and helpers to seed a role + user so the security
tests can run without Postgres or Docker.
"""

from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

# Deterministic secrets so Fernet encryption is stable across the test process.
os.environ.setdefault("VE_SECRETS_KEY", "test-secrets-key")
os.environ.setdefault("VE_JWT_SECRET", "test-jwt-secret")

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from app.auth.models import Role, User  # noqa: E402
from app.auth.permissions import WILDCARD  # noqa: E402
from app.auth.security import hash_password  # noqa: E402
from app.db.base import Base  # noqa: E402


def _import_all_models() -> None:
    import app.auth.models  # noqa: F401
    import app.branding.models  # noqa: F401
    import app.core.audit  # noqa: F401
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
