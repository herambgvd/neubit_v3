"""The database session every scheduled job body runs under.

Shared by ``instances.jobs``, ``notifications.jobs`` and ``correlation.jobs``
rather than copied into each, so none of them can drift back to the pooled engine.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings


@asynccontextmanager
async def task_session():
    """Yield an ``AsyncSession`` bound to a fresh, per-run NullPool engine.

    Each Celery task body runs under its own ``asyncio.run()`` loop, so the
    process-wide pooled engine would hand back connections bound to a dead loop
    ("Future attached to a different loop"). NullPool, disposed on exit, avoids it.
    """
    engine = create_async_engine(get_settings().database_url, poolclass=pool.NullPool)
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with sm() as session:
            yield session
    finally:
        await engine.dispose()
