"""Core's pool carries a per-statement ceiling, like every other service's.

`kernel/db.py` puts `db_statement_timeout_ms` into asyncpg's `server_settings` for
the whole pool, and the deployment sets a value per service. Core does not use the
kernel, so it was the one service where a runaway query could hold a pooled
connection — one of fifteen — until somebody noticed.

Two things are pinned: the value reaches asyncpg in the shape asyncpg understands,
and 0 still means "no timeout" (the kernel's meaning, and the shipped default).
The SSE relays are the reason the default is not a number picked for the REST
paths — see the last test.
"""


import pytest

from app.db.base import engine_kwargs

PG = "postgresql+asyncpg://u:p@db:5432/neubit_control"


def test_a_configured_timeout_reaches_asyncpg():
    assert engine_kwargs(PG, 30_000) == {
        "connect_args": {"server_settings": {"statement_timeout": "30000"}}
    }


def test_zero_means_no_timeout():
    """The kernel's default means this, and a setting that quietly meant something
    else here would be worse than the gap it closes."""
    assert engine_kwargs(PG, 0) == {}


def test_a_driver_that_would_reject_the_argument_never_sees_it():
    """`server_settings` is asyncpg's. psycopg and aiosqlite raise on it, and the
    test suite itself runs on SQLite."""
    assert engine_kwargs("sqlite+aiosqlite:///:memory:", 30_000) == {}


def test_the_engine_is_built_with_the_configured_ceiling(monkeypatch):
    """The setting is wired, not merely declared."""
    from app.core import config
    from app.db import base

    seen = {}

    def fake_create(url, **kwargs):
        seen["url"] = url
        seen.update(kwargs)
        return object()

    monkeypatch.setenv("VE_DATABASE_URL", PG)
    monkeypatch.setenv("VE_DB_STATEMENT_TIMEOUT_MS", "12345")
    config.get_settings.cache_clear()
    monkeypatch.setattr(base, "create_async_engine", fake_create)
    monkeypatch.setattr(base, "_engine", None)
    try:
        base.get_engine()
        assert seen["url"] == PG
        assert seen["connect_args"] == {"server_settings": {"statement_timeout": "12345"}}
    finally:
        base._engine = None
        config.get_settings.cache_clear()


@pytest.mark.asyncio
async def test_a_cancelled_query_does_not_drop_an_open_sse_stream():
    """A statement timeout cannot cut the live streams, and this is why.

    The relays hold no query for the life of the stream: `authorize_stream` opens a
    session, does two primary-key reads and closes it, every
    `VE_SSE_REVALIDATE_SECONDS`. The STREAM is long, its queries are milliseconds.
    And if one of those reads were cancelled by the timeout anyway, `StreamGuard`
    treats it as a database blip and keeps the stream rather than dropping every
    open dashboard in the estate.
    """
    from asyncpg.exceptions import QueryCanceledError

    from app.core import sse_auth

    guard = sse_auth.StreamGuard({"sub": "00000000-0000-0000-0000-000000000001"}, "vms.read")
    # Force the revalidation to actually run on this call.
    guard._checked_at -= guard._interval + 1

    async def cancelled(*a, **k):
        raise QueryCanceledError("canceling statement due to statement timeout")

    original = sse_auth.authorize_stream
    sse_auth.authorize_stream = cancelled
    try:
        assert await guard.still_allowed() is True
    finally:
        sse_auth.authorize_stream = original
