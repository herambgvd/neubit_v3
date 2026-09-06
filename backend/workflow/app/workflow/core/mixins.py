"""The ORM column mixin every tenant-scoped workflow table carries.

Columns only, not a ``Base`` subclass, so ``core`` stays free of ``app.db``. Every
table but ``correlation_dedup`` mixes this in; that one's key already embeds a
tenant-scoped trigger id and must not gain a ``tenant_id``.

NULL ``tenant_id`` means a platform row. Isolation is enforced by ``kernel.auth``
against this column, so a table without the mixin leaks.
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

