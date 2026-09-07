"""Storage pools — tenant-scoped (P3-B).

Where recorded segments LIVE (local disk / NAS / S3). This is all that is left of
the storage domain: the DATA-PLANE (tiering rules, RAID monitoring, retention +
hot→cold movement) is owned by the standalone NVR — the recorder that writes the
segments and sits on the disks — so the ``TierRule`` and ``RaidArray`` models were
deleted (their tables dropped by ``0028_drop_raid_tier``). The pool row survives only
so a finalized recording can be stamped with a ``storage_pool_id``.

Ported (control-plane subset) from ``gvd_nvr`` ``storage/models.py`` adapted to the
v3 tenant-scoped ORM conventions:

  * nullable ``tenant_id`` (NULL = platform/system default pool);
  * plain-string ``pool_type`` / ``mount_state`` — NO PG enum (asyncpg add-column enum
    footgun, project memory);
  * secrets (SMB password, S3 secret key) are stored REVERSIBLY ENCRYPTED via
    ``app.vms.common.crypto`` — never plaintext at rest;
  * portable generic column types so the model works on Postgres AND SQLite (tests).

⭐ Migration gotcha: this module MUST be imported in ``app.vms.models.__init__`` (so it
registers on ``Base.metadata``), which is imported by BOTH ``migrations/env.py`` AND
``0001_vision_baseline._tables()`` — a table whose module is not imported in both is
silently dropped on a fresh deploy.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class StoragePool(Base):
    """A storage target for recorded segments — local dir, NAS mount, or S3 bucket.

    ``pool_type`` selects which field-set is meaningful:
      * ``local`` / ``nfs`` / ``smb`` → ``path`` is the on-disk root (for nfs/smb the
        mount point); the ``nas_*`` fields hold the mount descriptor.
      * ``s3`` → ``s3_bucket`` + ``s3_endpoint`` + ``s3_region`` + credentials; ``path``
        is an optional key-prefix inside the bucket.
    """

    __tablename__ = "storage_pools"
    __table_args__ = (
        # Name unique PER TENANT (not globally — two tenants may each have "default").
        UniqueConstraint("tenant_id", "name", name="uq_storage_pools_tenant_name"),
        Index("ix_storage_pools_tenant", "tenant_id"),
        Index("ix_storage_pools_tenant_default", "tenant_id", "is_default"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # local | nfs | smb | s3 (plain string, no PG enum).
    pool_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'local'")
    )
    # Local root / mount path (local/nfs/smb) OR optional key-prefix (s3).
    path: Mapped[str | None] = mapped_column(String(1024))

    priority: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )  # higher = preferred when choosing a write target
    max_size_bytes: Mapped[int | None] = mapped_column(BigInteger)  # null = unlimited
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    # ── NAS (nfs/smb) mount descriptor ──────────────────────────────────
    nas_server: Mapped[str | None] = mapped_column(String(255))  # IP or hostname
    nas_share: Mapped[str | None] = mapped_column(String(255))  # export / share
    nas_protocol: Mapped[str | None] = mapped_column(String(8))  # nfs | smb
    nas_username: Mapped[str | None] = mapped_column(String(255))  # SMB user
    # SMB password — REVERSIBLY ENCRYPTED (``enc:<nonce>:<ct>``), never plaintext.
    nas_enc_password: Mapped[str | None] = mapped_column(Text)
    nas_domain: Mapped[str | None] = mapped_column(String(128))  # SMB domain/workgroup
    nas_mount_options: Mapped[str | None] = mapped_column(Text)
    # unmounted | mounting | mounted | error (advisory; local pools stay null).
    mount_state: Mapped[str | None] = mapped_column(String(16))
    last_mount_error: Mapped[str | None] = mapped_column(Text)

    # ── S3 (s3) descriptor ──────────────────────────────────────────────
    s3_endpoint: Mapped[str | None] = mapped_column(String(512))  # MinIO/custom endpoint
    s3_bucket: Mapped[str | None] = mapped_column(String(255))
    s3_region: Mapped[str | None] = mapped_column(String(64))
    s3_access_key: Mapped[str | None] = mapped_column(String(255))
    # S3 secret key — REVERSIBLY ENCRYPTED, never plaintext.
    s3_enc_secret_key: Mapped[str | None] = mapped_column(Text)
    s3_use_ssl: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    # Whether reachability validated on last create/update (advisory).
    reachable: Mapped[bool | None] = mapped_column(Boolean)

    # ── RAID link (optional) ────────────────────────────────────────────
    # PURELY DOCUMENTARY labels: a local pool may sit on a software-RAID array, and
    # these record which one. Nothing in this VMS monitors RAID any more — the
    # ``raid_arrays`` health table these once cross-linked to is gone (dropped by
    # ``0028_drop_raid_tier``); the NVR owns array health. NULL = not on a RAID array.
    raid_level: Mapped[str | None] = mapped_column(String(16))  # raid1|raid5|raid6|raid10
    raid_device: Mapped[str | None] = mapped_column(String(64))  # /dev/md0

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
