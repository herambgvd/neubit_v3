"""Async SQLAlchemy engine, session factory, declarative Base, and the get_db dep.

Every scenario's domain models inherit from ``Base``; every route that touches the
DB depends on ``get_db`` (a per-request session, closed automatically).

IMPORTANT: the session does NOT auto-commit. A service that writes must call
``await session.commit()`` explicitly — a bare flush is rolled back on teardown.

The engine/sessionmaker are created lazily on first use so importing this module
never requires a live database (tests and tooling can import models freely).

Every pooled connection carries `VE_DB_STATEMENT_TIMEOUT_MS` as a per-statement
ceiling when one is set — see ``engine_kwargs``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from ..core.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


class Base(DeclarativeBase):
    """Declarative base every ORM model in every scenario inherits from."""


def engine_kwargs(database_url: str, statement_timeout_ms: int) -> dict:
    """Engine kwargs carrying `statement_timeout` when one is configured.

    The same shape as `kernel.db.Database._engine_kwargs`, which is how every
    other service in the estate gets its ceiling — core does not use the kernel,
    so the alternative was core being the one service whose queries run forever.

    asyncpg SETs `server_settings` on each new connection, so the timeout covers
    the whole pool. Exceeding it raises `QueryCanceledError`: a failed query is
    reported and retried, a hung one silently holds a connection out of fifteen.

    0 means no timeout (see the setting), and the argument is only meaningful to
    asyncpg — psycopg and aiosqlite would reject `server_settings` outright, and
    the test suite runs on SQLite.
    """
    if statement_timeout_ms <= 0 or "asyncpg" not in database_url:
        return {}
    return {"connect_args": {"server_settings": {"statement_timeout": str(statement_timeout_ms)}}}


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.database_url,
            pool_pre_ping=True,
            **engine_kwargs(settings.database_url, settings.db_statement_timeout_ms),
        )
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        # expire_on_commit=False → objects stay usable after commit (no lazy re-fetch).
        _sessionmaker = async_sessionmaker(
            get_engine(), expire_on_commit=False, class_=AsyncSession
        )
    return _sessionmaker


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: yields a session, always closes it."""
    async with get_sessionmaker()() as session:
        yield session
