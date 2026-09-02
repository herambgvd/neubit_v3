"""Per-tenant database provisioning (DB-per-tenant, ARCHITECTURE.md §10).

When ``db_per_tenant`` is on, each tenant's operational data lives in its OWN
physical database per service — ``<base_db>_t_<tenant_hex>``. Provisioning a tenant
= ``CREATE DATABASE`` + build the schema; offboarding = ``DROP DATABASE`` (a trivial,
complete erase — the strongest right-to-erase story).

These are the low-level primitives; the request-time router lives in ``kernel.db``
and the lifecycle wiring in ``kernel.lifecycle``. DDL uses a raw asyncpg admin
connection to the ``postgres`` maintenance database (CREATE/DROP DATABASE cannot run
inside a transaction, and asyncpg connections are autocommit by default).

The derived name is UUID-hex based (safe chars only, ≤63 for Postgres), so string
interpolation of the identifier carries no injection risk.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

log = logging.getLogger("kernel.provisioning")


def tenant_db_name(base_database: str, tenant_id: str) -> str:
    """`neubit_workflow` + tenant → `neubit_workflow_t_<32-hex>` (≤63 chars)."""
    return f"{base_database}_t_{uuid.UUID(str(tenant_id)).hex}"


def tenant_url(base_url: str, tenant_id: str) -> str:
    """The base service URL with its database swapped for the tenant's DB name."""
    url = make_url(base_url)
    return url.set(database=tenant_db_name(url.database, tenant_id)).render_as_string(
        hide_password=False
    )


async def _admin_connect(base_url: str):
    """A raw asyncpg connection to the `postgres` maintenance DB (for CREATE/DROP)."""
    import asyncpg

    url = make_url(base_url)
    return await asyncpg.connect(
        host=url.host,
        port=url.port or 5432,
        user=url.username,
        password=url.password,
        database="postgres",
    )


async def create_tenant_db(base_url: str, tenant_id: str) -> bool:
    """CREATE DATABASE for the tenant if absent. Returns True if it was created."""
    name = tenant_db_name(make_url(base_url).database, tenant_id)
    conn = await _admin_connect(base_url)
    try:
        if await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name):
            return False
        await conn.execute(f'CREATE DATABASE "{name}"')
        log.info("provisioned tenant database %s", name)
        return True
    finally:
        await conn.close()


async def drop_tenant_db(base_url: str, tenant_id: str) -> bool:
    """DROP DATABASE for the tenant (FORCE-disconnects sessions). Idempotent."""
    name = tenant_db_name(make_url(base_url).database, tenant_id)
    conn = await _admin_connect(base_url)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        log.info("dropped tenant database %s", name)
        return True
    finally:
        await conn.close()


async def provision_tenant_schema(base_url: str, base_metadata, tenant_id: str) -> None:
    """Create the tenant DB (if needed) and build this service's schema in it.

    Uses ``metadata.create_all`` — the same ORM-metadata baseline each service builds
    on a fresh DB — so a newly provisioned tenant DB matches the current schema.
    """
    await create_tenant_db(base_url, tenant_id)
    engine = create_async_engine(tenant_url(base_url, tenant_id))
    try:
        async with engine.begin() as conn:
            await conn.run_sync(base_metadata.create_all)
    finally:
        await engine.dispose()
