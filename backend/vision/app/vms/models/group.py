"""Camera grouping + per-camera ACL — tenant-scoped.

``CameraGroup`` is a LOCAL grouping catalog (name unique per tenant); membership is
held as a ``camera_ids`` JSON list (mirrors the access service's ``door_ids`` style
— flat, no association table). ``CameraACL`` is the VMS-owned per-camera access
list, keyed on CORE subject IDs (role/user/group) — coarse RBAC stays in core, VMS
owns only the fine-grained per-camera/per-group privilege grants.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class CameraGroup(Base):
    """A LOCAL camera grouping catalog entry (name unique per tenant)."""

    __tablename__ = "camera_groups"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_camera_groups_tenant_name"),
        Index("ix_camera_groups_tenant", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[str | None] = mapped_column(String(16))
    description: Mapped[str | None] = mapped_column(String(1024))
    # Membership as a JSON list of camera ids (flat, like access door_ids).
    camera_ids: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class CameraACL(Base):
    """A VMS-owned per-camera/per-group privilege grant, keyed on core subject IDs."""

    __tablename__ = "camera_acl"
    __table_args__ = (
        Index("ix_camera_acl_tenant_target", "tenant_id", "target_type", "target_id"),
        Index("ix_camera_acl_subject", "subject_type", "subject_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    # role | user | group (the core subject kind; plain string, no PG enum).
    subject_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # The CORE subject id (role/user/group id) this grant is for.
    subject_id: Mapped[str] = mapped_column(String(64), nullable=False)

    # camera | group (the VMS target kind; plain string, no PG enum).
    target_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # The target camera id or camera-group id.
    target_id: Mapped[str] = mapped_column(String(36), nullable=False)

    # Privilege list: view_live | playback | export | ptz | config.
    privileges: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )

    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
