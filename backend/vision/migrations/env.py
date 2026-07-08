"""Alembic environment (async) for the vision (VMS control-plane) service.

The DB URL comes from VE_DATABASE_URL (via kernel settings), not alembic.ini.
Import every domain model module below so ``Base.metadata`` is COMPLETE — a table
whose module isn't imported here is silently dropped from the metadata and never
created (project-memory gotcha). When the camera domain lands next module, add its
model module to the import block below AND to ``0001_baseline._tables()``.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from kernel.config import get_settings

from app.db import Base

# Import all model modules so their tables register on Base.metadata.
# vms domain (P1-A scaffold): VmsMeta placeholder. Camera / NVR / MediaProfile /
# CameraGroup / CameraACL / CameraHealth / MediaNode / StreamShard arrive next.
import app.vms.models  # noqa: E402,F401

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
