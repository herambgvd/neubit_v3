"""Alembic environment (async) for the workflow service.

The DB URL comes from VE_DATABASE_URL (via kernel settings), not
alembic.ini. ``Base.metadata`` must be COMPLETE before ``target_metadata`` is read
below, or autogenerate will propose dropping the tables it cannot see; that
completeness is delegated to ``app.workflow.tables``.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from kernel.config import get_settings

from app.db import Base

# Import every model module so its tables register on Base.metadata. The models
# live in one package per feature, so ONE import here would only ever cover one of
# them — and a model Alembic cannot see is not reported as missing, it is proposed
# for DROP. ``app.workflow.tables`` is the single list that has to be complete;
# keep the indirection rather than naming packages here, so there is one place to
# get wrong instead of two.
# Tables: sops / workflow_states / workflow_transitions / workflow_triggers /
# workflow_instances / workflow_forms / notification_templates /
# notification_channels / notifications / device_tokens / threat_levels /
# alert_formats / correlation_dedup.
import app.workflow.tables  # noqa: F401,E402

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
