"""Async SQLAlchemy engine / sessionmaker / get_db / Base factory.

Mirrors the platform core's ``app.db.base`` but takes the ``database_url`` as an
argument (or reads it from the shared Settings) so each service points at its OWN
Postgres database. A service builds one ``Database`` at import time and depends on
``db.get_db`` in its routes.

    from kernel.db import Database
    from kernel.config import get_settings

    database = Database(get_settings().database_url)
    Base = database.Base            # every ORM model inherits from this
    get_db = database.get_db        # FastAPI dependency

IMPORTANT: sessions do NOT auto-commit — a service that writes must call
``await session.commit()`` explicitly. Engine/sessionmaker are created lazily so
importing this module never requires a live database (tests/tooling import freely).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


def make_base() -> type[DeclarativeBase]:
    """A fresh declarative Base (its own metadata) for a service's models."""

    class Base(DeclarativeBase):
        """Declarative base every ORM model in this service inherits from."""

    return Base


class Database:
    """Per-service async DB handle: lazy engine, sessionmaker, Base, get_db dep.

    Also the DB-per-tenant router: ``sessionmaker_for(tenant_id)`` returns a pooled
    sessionmaker bound to the tenant's OWN database when ``db_per_tenant`` is on, and
    falls back to the shared engine otherwise (or when tenant_id is None). The shared
    ``get_db`` is unchanged — services on the default (shared-DB) model keep working
    exactly as before; the per-tenant path only engages once the flag is flipped.
    """

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self._engine: AsyncEngine | None = None
        self._sessionmaker: async_sessionmaker[AsyncSession] | None = None
        # Per-tenant sessionmakers, built lazily and pooled for the process lifetime.
        self._tenant_sessionmakers: dict[str, async_sessionmaker[AsyncSession]] = {}
        self.Base: type[DeclarativeBase] = make_base()

    def get_engine(self) -> AsyncEngine:
        if self._engine is None:
            self._engine = create_async_engine(self.database_url, pool_pre_ping=True)
        return self._engine

    def get_sessionmaker(self) -> async_sessionmaker[AsyncSession]:
        if self._sessionmaker is None:
            # expire_on_commit=False → objects stay usable after commit.
            self._sessionmaker = async_sessionmaker(
                self.get_engine(), expire_on_commit=False, class_=AsyncSession
            )
        return self._sessionmaker

    async def get_db(self) -> AsyncIterator[AsyncSession]:
        """FastAPI dependency: yields a session on the SHARED db, always closes it."""
        async with self.get_sessionmaker()() as session:
            yield session

    # --- DB-per-tenant routing (dormant until db_per_tenant is on) ----------
    def _per_tenant_enabled(self) -> bool:
        from .config import get_settings

        return bool(getattr(get_settings(), "db_per_tenant", False))

    def sessionmaker_for(self, tenant_id: str | None) -> async_sessionmaker[AsyncSession]:
        """The sessionmaker for ``tenant_id``'s database.

        Shared sessionmaker when per-tenant mode is off or ``tenant_id`` is None
        (super-admin / platform); otherwise a lazily-built, pooled sessionmaker on
        ``<base>_t_<tenant_hex>``.
        """
        if tenant_id is None or not self._per_tenant_enabled():
            return self.get_sessionmaker()
        key = str(tenant_id)
        sm = self._tenant_sessionmakers.get(key)
        if sm is None:
            from .provisioning import tenant_url

            engine = create_async_engine(tenant_url(self.database_url, key), pool_pre_ping=True)
            sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
            self._tenant_sessionmakers[key] = sm
        return sm

    async def get_db_for(self, tenant_id: str | None) -> AsyncIterator[AsyncSession]:
        """Yield a session bound to ``tenant_id``'s database (shared if flag off/None)."""
        async with self.sessionmaker_for(tenant_id)() as session:
            yield session
