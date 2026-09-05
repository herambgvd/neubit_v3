"""The database session every scheduled job body runs under.

Lifted out of the old flat ``tasks`` module unchanged when the sweeps moved to
the features that own them (``instances.jobs``, ``notifications.jobs``,
``correlation.jobs``). It is here rather than duplicated three times because the
failure it prevents is subtle and shared: three copies is three chances for one
of them to quietly go back to the pooled engine.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings


@asynccontextmanager
async def task_session():
    """Yield an ``AsyncSession`` bound to a fresh, per-run NullPool engine.

    Each Celery task body runs under its own ``asyncio.run()`` loop. Reusing the
    process-wide pooled engine leaks connections bound to a previous loop and
    raises "Future attached to a different loop". A per-run NullPool engine (no
    cross-loop connection reuse), disposed on exit, keeps each sweep loop-safe.
    """
    engine = create_async_engine(get_settings().database_url, poolclass=pool.NullPool)
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with sm() as session:
            yield session
    finally:
        await engine.dispose()
