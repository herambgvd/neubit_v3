"""Phase 6 — kernel offboard erase (DPDP right-to-erase).

Proves ``kernel.lifecycle.erase_tenant_data`` wipes exactly one tenant's rows and
leaves other tenants untouched, generically (every table with a ``tenant_id``
column), using a throwaway in-memory Database.
"""

from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import Uuid, select
from sqlalchemy.orm import Mapped, mapped_column

from kernel.db import Database
from kernel.lifecycle import erase_tenant_data


def _run(coro):
    return asyncio.run(coro)


def test_erase_removes_only_target_tenant():
    db = Database("sqlite+aiosqlite:///:memory:")

    class Thing(db.Base):
        __tablename__ = "things"
        id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
        tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    class Shared(db.Base):  # a table WITHOUT tenant_id — must be left alone
        __tablename__ = "shared"
        id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)

    tenant_a, tenant_b = uuid.uuid4(), uuid.uuid4()

    async def scenario():
        async with db.get_engine().begin() as conn:
            await conn.run_sync(db.Base.metadata.create_all)
        async with db.get_sessionmaker()() as s:
            s.add_all(
                [
                    Thing(id=uuid.uuid4(), tenant_id=tenant_a),
                    Thing(id=uuid.uuid4(), tenant_id=tenant_a),
                    Thing(id=uuid.uuid4(), tenant_id=tenant_b),
                    Thing(id=uuid.uuid4(), tenant_id=None),  # platform/shared row
                    Shared(id=uuid.uuid4()),
                ]
            )
            await s.commit()

        removed = await erase_tenant_data(db, str(tenant_a))
        assert removed == 2  # only tenant A's two rows

        async with db.get_sessionmaker()() as s:
            things = (await s.execute(select(Thing))).scalars().all()
            tenants_left = {t.tenant_id for t in things}
            # Tenant A gone; tenant B and the platform/NULL row remain.
            assert tenant_a not in tenants_left
            assert tenant_b in tenants_left
            assert None in tenants_left
            # The non-tenant table is untouched.
            assert len((await s.execute(select(Shared))).scalars().all()) == 1

    _run(scenario())
