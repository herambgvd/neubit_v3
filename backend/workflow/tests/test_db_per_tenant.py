"""Phase 7 — DB-per-tenant foundation.

Two layers:
  * pure unit — tenant DB-name/URL derivation + the flag-OFF routing fallback
    (deterministic, no database);
  * live Postgres — create → provision schema → drop a scratch tenant database
    (proves the provisioning primitives against a real server; skipped if no PG).

The flag defaults OFF, so the router falls back to the shared engine and nothing in
the running stack changes; this only exercises the machinery.
"""

from __future__ import annotations

import asyncio
import uuid

from kernel.db import Database
from kernel.provisioning import (
    create_tenant_db,
    drop_tenant_db,
    provision_tenant_schema,
    tenant_db_name,
    tenant_url,
)

_BASE = "postgresql+asyncpg://neubit:neubit@postgres:5432/neubit_workflow"


def _run(coro):
    return asyncio.run(coro)


# --- pure unit --------------------------------------------------------------
def test_tenant_db_name_is_hex_suffixed():
    tid = uuid.UUID("4e76bc18-ccd7-4d4a-af32-2840b191f88c")
    assert tenant_db_name("neubit_workflow", str(tid)) == (
        "neubit_workflow_t_4e76bc18ccd74d4aaf322840b191f88c"
    )
    # Postgres identifier limit.
    assert len(tenant_db_name("neubit_workflow", str(tid))) <= 63


def test_tenant_url_swaps_only_the_database():
    tid = "4e76bc18-ccd7-4d4a-af32-2840b191f88c"
    url = tenant_url(_BASE, tid)
    assert url.endswith("/neubit_workflow_t_4e76bc18ccd74d4aaf322840b191f88c")
    assert "neubit:neubit@postgres:5432" in url  # host/creds untouched


def test_router_falls_back_to_shared_when_flag_off():
    db = Database(_BASE)
    shared = db.get_sessionmaker()
    # Flag defaults OFF → both None and a real tenant id resolve to the shared maker.
    assert db.sessionmaker_for(None) is shared
    assert db.sessionmaker_for(str(uuid.uuid4())) is shared


# --- live Postgres (create → provision → drop) ------------------------------
def test_provision_and_drop_tenant_db_live():
    tid = str(uuid.uuid4())
    # Use the SERVICE's real database handle + models so create_all builds the actual
    # workflow schema (a fresh Database() has an empty metadata → no tables).
    import app.workflow.models  # noqa: F401 — registers models on app.db.Base
    from app.db import database as db

    async def scenario():
        import asyncpg
        from sqlalchemy.engine import make_url

        base = db.database_url
        name = tenant_db_name(make_url(base).database, tid)

        async def _db_exists() -> bool:
            u = make_url(base)
            conn = await asyncpg.connect(
                host=u.host, port=u.port or 5432, user=u.username,
                password=u.password, database="postgres",
            )
            try:
                return bool(await conn.fetchval("SELECT 1 FROM pg_database WHERE datname=$1", name))
            finally:
                await conn.close()

        try:
            # create + build this service's schema
            await provision_tenant_schema(base, db.Base.metadata, tid)
            assert await _db_exists()
            # a known workflow table should exist in the new tenant DB
            from sqlalchemy import text
            from sqlalchemy.ext.asyncio import create_async_engine

            eng = create_async_engine(tenant_url(base, tid))
            try:
                async with eng.connect() as conn:
                    found = await conn.scalar(
                        text("SELECT to_regclass('public.notification_channels')")
                    )
                    assert found is not None
            finally:
                await eng.dispose()
        finally:
            await drop_tenant_db(base, tid)
        assert not await _db_exists()

    try:
        _run(scenario())
    except Exception as exc:  # no reachable Postgres in this env → skip, don't fail
        import pytest

        if "connect" in str(exc).lower() or "refused" in str(exc).lower():
            pytest.skip(f"no Postgres reachable: {exc}")
        raise
