"""Shared test setup for the workflow suite.

  * ``run_async`` — the tests are synchronous functions driving async code, so each
    owns its event loop via ``asyncio.run``. Not pytest-asyncio: there are no async
    fixtures, and adding a plugin plus a marker everywhere would change what runs.

  * ``make_sqlite_session`` — an in-memory aiosqlite engine holding only the tables
    a test names. The models use portable column types so they build on SQLite;
    creating the whole metadata would couple every test to every table.

pytest puts this directory on ``sys.path`` (no ``__init__.py``, default prepend
import mode), which is why the test modules import from ``conftest`` by name.
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
