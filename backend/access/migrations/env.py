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
        # COMMIT EXPLICITLY. Without this every migration is a silent no-op:
        # alembic logs "Running upgrade X -> Y", the process exits 0, and
        # `alembic current` still reports X.
        #
        # SQLAlchemy 2.0 opens an implicit transaction on the first execute, so
        # by the time alembic's MigrationContext looks at the connection it is
        # ALREADY in one. Alembic reads that as "the caller manages
        # transactions" and declines to commit — correctly, since committing
        # someone else's transaction would be worse. Nobody then does, and
        # `async with connectable.connect()` rolls back on exit.
        #
        # Found in reporting, where an empty migration whose upgrade() was
        # `pass` printed "Running upgrade", exited 0 and changed nothing. Every
        # service shares this env.py shape, so every one of them would lose its
        # NEXT migration the same way.
        #
        # Safe when alembic DID commit: Connection.commit() with no transaction
        # open is a no-op in SQLAlchemy 2.0.
        await connection.commit()
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
