"""Alembic environment (async) for the access-control service.

The DB URL comes from VE_DATABASE_URL (via kernel settings), not alembic.ini.
Import every domain model module below so ``Base.metadata`` is COMPLETE — a table
whose module isn't imported here is silently dropped from the metadata and never
created (project-memory gotcha). All access tables live in one module.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from kernel.config import get_settings

from app.db import Base

# Import all model modules so their tables register on Base.metadata.
# access domain: Instance + AccessMirror + Door + AccessEvent + SyncJob
#                + AccessGroup + Schedule (local instance-scoped catalogs).
import app.access.models  # noqa: E402,F401

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_online():
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_offline():
    context.configure(
        url=get_settings().database_url, target_metadata=target_metadata, literal_binds=True
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    asyncio.run(run_online())
