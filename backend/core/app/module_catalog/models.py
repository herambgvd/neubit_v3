"""Module — the platform registry of toggleable features/modules.

This is the CATALOG a super-admin manages: each row is one feature area (vms,
access, fire, …). The catalog keys become the keys of every tenant's
``features`` dict — the super-admin enables a module for a tenant by setting
``tenant.features[key] = true`` (see ``app.tenancy.features``).

The table is platform-global (NOT tenant-scoped): there is one catalog for the
whole deployment. Sensible defaults are seeded on startup (idempotently); a
super-admin can add/edit/remove non-system modules via ``/admin/modules``.

Portable generic types (Uuid/String/Boolean) keep the same model on Postgres and
SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class Module(Base):
    """One toggleable platform module/feature in the catalog."""

    __tablename__ = "modules"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Stable machine key used as the tenant.features flag key (e.g. "vms", "anpr").
    key: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    # Human-facing name + description shown in the admin UI.
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False, default="")
    # Grouping label for the admin UI (e.g. "Security", "Operations").
    category: Mapped[str] = mapped_column(String, nullable=False, default="General")
    # Whether a newly created tenant gets this module on by default (advisory — the
    # per-tenant toggle is authoritative; used to pre-fill new-tenant feature maps).
    default_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # System modules ship with the platform and cannot be deleted (only toggled).
    is_system: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
