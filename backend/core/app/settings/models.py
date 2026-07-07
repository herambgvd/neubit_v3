"""AppSetting — a tiny key/value store for admin-editable system settings.

One row per setting key; the value is a portable JSON blob (bool/str/number), so
the same model works on Postgres and SQLite. Unknown/unset keys fall back to the
catalog defaults, so the table only ever holds values an admin actually changed.
"""

from __future__ import annotations

import uuid

from sqlalchemy import JSON, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class AppSetting(Base):
    __tablename__ = "app_settings"

    # A key can exist once per tenant, plus once for the platform default. The row
    # is keyed by a surrogate ``id`` (a plain ``key`` PK can't be shared across
    # tenants) and looked up by (key, tenant_id). ``tenant_id`` NULL = the
    # PLATFORM-DEFAULT row a tenant falls back to.
    __table_args__ = (UniqueConstraint("key", "tenant_id", name="uq_app_settings_key_tenant"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String, nullable=False, index=True)
    value: Mapped[object] = mapped_column(JSON, nullable=False)
    # --- multi-tenancy -----------------------------------------------------
    # Per-tenant override rows carry a tenant_id. NULL = the PLATFORM-DEFAULT row a
    # tenant falls back to. (Existing single-tenant rows stay NULL → the default.)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True,
    )
