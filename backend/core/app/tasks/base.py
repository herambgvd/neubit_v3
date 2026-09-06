"""Task helpers: the ``@task`` decorator + a sync DB session for workers.

Celery workers run tasks in a normal, non-async call stack, so they get their own
synchronous engine against the same database rather than driving the app's async
one through a per-task event loop (fragile, and asyncpg does not like short-lived
loops). The URL comes from ``settings.database_url`` with the async driver
stripped:

    postgresql+asyncpg://…   →   postgresql://…      (psycopg2 / psycopg)
    sqlite+aiosqlite://…     →   sqlite://…          (stdlib sqlite3)

The engine and sessionmaker are built lazily, so importing this in the web process
costs nothing.
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from ..core.config import get_settings
from .app import celery_app

# Re-export so callers can do ``from app.tasks.base import celery_app``.
__all__ = ["celery_app", "task", "get_sync_session"]


def task(*args, **kwargs):
    """Passthrough to ``celery_app.task`` so callers import one symbol.

    Usage mirrors Celery exactly::

        @task
        def do_work(x): ...

        @task(bind=True, max_retries=3)
        def flaky(self): ...
    """
    return celery_app.task(*args, **kwargs)


# Lazily-built sync engine + sessionmaker (see module docstring for the rationale).
_sync_engine: Engine | None = None
_sync_sessionmaker: sessionmaker[Session] | None = None


def _sync_database_url() -> str:
    """Convert the app's async DB URL to its synchronous-driver equivalent."""
    url = get_settings().database_url
    # Strip the async driver so a plain blocking driver is used in the worker.
    return url.replace("+asyncpg", "").replace("+aiosqlite", "")


def _get_sync_sessionmaker() -> sessionmaker[Session]:
    global _sync_engine, _sync_sessionmaker
    if _sync_sessionmaker is None:
        _sync_engine = create_engine(_sync_database_url(), pool_pre_ping=True)
        # expire_on_commit=False keeps ORM objects usable after commit, matching
        # the async sessionmaker's behaviour in db/base.py.
        _sync_sessionmaker = sessionmaker(
            _sync_engine, expire_on_commit=False, class_=Session
        )
    return _sync_sessionmaker


def get_sync_session() -> Session:
    """Return a fresh synchronous Session for use inside a Celery task.

    The caller owns the lifecycle. It does not auto-commit, same as the async
    path::

        with get_sync_session() as db:
            ... ; db.commit()
    """
    return _get_sync_sessionmaker()()
