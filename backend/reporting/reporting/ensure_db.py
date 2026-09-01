"""Create `neubit_reporting` if it does not exist yet.

``deploy/postgres/init-service-dbs.sh`` creates the per-service databases, but
Postgres runs ``/docker-entrypoint-initdb.d/*`` only on a FRESH data volume — so
on an already-initialised stack (which is every existing dev machine) that script
never runs again and the new database would simply be missing. Every other
service inherited that problem and the fix was "create it by hand"; this one
creates its own, so `docker compose up -d reporting-migrate` works on a fresh
volume and an old one alike.

Connects to the maintenance database (`postgres`) on the same server with the
same credentials, so it needs no extra configuration.
"""

from __future__ import annotations

import asyncio
import logging
import sys

import asyncpg
from kernel.config import get_settings
from sqlalchemy.engine import make_url

log = logging.getLogger("reporting.ensure_db")


async def ensure_database() -> bool:
    """Create the configured database if absent. True if it was created."""
    url = make_url(get_settings().database_url)
    target = url.database
    if not target:
        raise RuntimeError("VE_DATABASE_URL has no database name")

    conn = await asyncpg.connect(
        host=url.host, port=url.port or 5432,
        user=url.username, password=url.password,
        database="postgres",
    )
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", target
        )
        if exists:
            log.info("database %s already exists", target)
            return False
        # CREATE DATABASE cannot be parameterised or run in a transaction.
        await conn.execute(f'CREATE DATABASE "{target}"')
        log.info("created database %s", target)
        return True
    finally:
        await conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    try:
        asyncio.run(ensure_database())
    except Exception as exc:  # startup gate: fail loudly, never silently.
        print(f"ensure_db failed: {exc}", file=sys.stderr)
        raise
