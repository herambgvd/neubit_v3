"""The ORM column mixin every tenant-scoped workflow table carries.

Not a ``Base`` subclass and deliberately not one: it declares columns only, so
``core`` stays free of ``app.db`` and a feature's ``models`` module decides what
is a table. Every table but ``correlation_dedup`` mixes this in —
``correlation_dedup``'s key already embeds a tenant-scoped trigger id, so it has
no ``tenant_id`` of its own and must NOT gain one here.

``tenant_id`` NULL means a platform / super-admin / system row. Tenant isolation
is enforced by ``kernel.auth`` (``scoped`` / ``assert_owned``) against this
column, so a table that omits the mixin is a table that leaks.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from .primitives import utcnow


class _TenantTimestamped:
    """Shared columns: tenant scope + created/updated audit stamps."""

    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

