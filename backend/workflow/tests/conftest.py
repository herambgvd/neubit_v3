"""Shared test setup for the workflow suite.

Every file here duplicated the same two pieces of boilerplate before this existed.
They are moved, not rewritten — same bodies, one copy:

  * ``run_async`` — these tests are synchronous functions driving async code, so
    each one owns its event loop via ``asyncio.run``. Deliberately NOT
    ``pytest-asyncio``: the suite has no async fixtures and adding a plugin +
    marker to every test would be a change to what runs, not to where it lives.

  * ``make_sqlite_session`` — an in-memory aiosqlite engine with ONLY the tables a
    test names. The models use portable generic column types so they build on
    SQLite, and creating the whole metadata would silently couple every test to
    every table; each caller still names its own.

pytest puts this directory on ``sys.path`` (no ``__init__.py``, default
``prepend`` import mode), which is why the test modules import from ``conftest``
by name.
"""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

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
