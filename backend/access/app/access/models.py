"""Access-control ORM — tenant-scoped, ported from neubit_v2 gates.

Every table carries a nullable ``tenant_id`` (owning tenant; NULL = a
platform/super-admin/system row) — the kernel multi-tenancy pattern. Reads and
by-id lookups go through ``kernel.auth.scoped`` / ``assert_owned`` so isolation
lives in one place.

Mapping to v2 (``neubit_v2/backend/gates``):
  * ``Instance``     ← ``module/instance/models.InstanceDocument`` (+ ``brand``,
                       ``tenant_id`` added for v3; secret stored reversibly
                       encrypted as one string instead of the v2 nonce/ct struct).
  * ``AccessMirror`` ← ``module/mirror/orm.DDSMirrorORM`` (single JSONB DTO table,
                       unique (instance_id, collection, remote_uid)).
  * ``Door``         ← v2 ``module/door`` local door catalog (subset; floor/zone
                       stubs nullable — floor-plan linkage is a later phase).
  * ``AccessGroup``  ← v2 ``module/access_groups`` LOCAL access-group catalog
                       (repository CRUD, NOT DDS write-through). Instance-scoped.
  * ``Schedule``     ← v2 ``module/access_groups`` LOCAL schedule catalog (embedded
                       TimeWindow array + holidays; repository CRUD). Instance-scoped.
  * ``AccessEvent``  ← v2 ``module/event/orm.AccessEventORM`` + ``HubEventORM``
                       (merged: persists the SignalR events; ``published`` flag
                       tracks NATS emission).
  * ``SyncJob``      ← v2 ``module/event/orm.SyncJobORM`` (reconcile run history).

Portable generic types (String/Boolean/DateTime/Uuid/JSON) keep the model working
on Postgres and SQLite (tests). No PG enum columns — plain strings dodge the
asyncpg add-column enum footgun (see project memory).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Instance(Base):
    """A registered access controller (v2 InstanceDocument, tenant-scoped)."""

    __tablename__ = "access_instances"
    __table_args__ = (Index("ix_access_instances_tenant_active", "tenant_id", "is_active"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    # The controller brand → selects the connector (only "dds" implemented now).
    brand: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'dds'"), index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)
    # "basic" | "jwt" (v2 auth_type). Plain string, no PG enum.
    auth_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'basic'")
    )
    username: Mapped[str] = mapped_column(String(255), nullable=False, server_default=text("''"))
    # Reversibly-encrypted secret (enc:...); decrypted only to build a connector.
    secret_enc: Mapped[str | None] = mapped_column(String(1024))
    verify_tls: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    # online | offline | unknown (v2 InstanceStatus subset; string, no enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'unknown'"), index=True
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )

    # Optional site linkage (floor-plan wiring is a later phase — column only).
    site_id: Mapped[str | None] = mapped_column(String(36), index=True)

    # Reconcile / connection bookkeeping (v2 fields).
    last_connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(2048))
    reconciler_cron: Mapped[str | None] = mapped_column(
        String(64), server_default=text("'0 3 * * *'")
    )
    version_info: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class AccessMirror(Base):
    """Single-table JSONB mirror of controller entities (v2 DDSMirrorORM).

    DDS (the controller) is source-of-truth; the reconciler upserts the verbatim
    DTO here keyed by (instance_id, collection, remote_uid). ``collection`` ∈
    cardholders | cards | access_groups | schedules | scheduled_mags |
    scheduled_readers.
    """

    __tablename__ = "access_mirror"
    __table_args__ = (
        UniqueConstraint(
            "instance_id", "collection", "remote_uid",
            name="uq_access_mirror_inst_coll_uid",
        ),
        Index("ix_access_mirror_inst_coll", "instance_id", "collection"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: mirrors the owning instance's tenant. ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    instance_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("access_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    collection: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    remote_uid: Mapped[str | None] = mapped_column(String(128), index=True)
    dto: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    last_synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class Door(Base):
    """A LOCAL door entity (v2 module/door). Floor/zone linkage stubbed nullable."""

    __tablename__ = "access_doors"
    __table_args__ = (Index("ix_access_doors_inst", "instance_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy. ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    instance_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("access_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # The controller-side door/reader UID this local door maps to.
    remote_ref: Mapped[str | None] = mapped_column(String(128), index=True)

    # Floor-plan linkage stubs (wired in a later phase — columns only).
    site_id: Mapped[str | None] = mapped_column(String(36), index=True)
    floor_id: Mapped[str | None] = mapped_column(String(36))
    zone_id: Mapped[str | None] = mapped_column(String(36))

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    metadata_json: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class AccessEvent(Base):
    """A persisted controller event (v2 AccessEventORM + HubEventORM merged).

    Written by the SignalR ingestion path. ``published`` flags whether it was
    emitted on the NATS spine (``tenant.<id>.access.<category>.<type>``).
    """

    __tablename__ = "access_events"
    __table_args__ = (
        Index("ix_access_events_tenant_occurred", "tenant_id", "occurred_at"),
        Index("ix_access_events_inst_occurred", "instance_id", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: mirrors the owning instance's tenant. ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    instance_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("access_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # access | alarm | comm | technical | audit | general | io | health.
    category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(128), nullable=False)
    # granted | denied | unknown | forced | ... (v2 AccessResult; string, no enum).
    result: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'unknown'"), index=True
    )
    remote_uid: Mapped[str | None] = mapped_column(String(128), index=True)
    door_ref: Mapped[str | None] = mapped_column(String(128), index=True)
    cardholder_ref: Mapped[str | None] = mapped_column(String(128), index=True)
    site_id: Mapped[str | None] = mapped_column(String(36))

    raw: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
    published: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class AccessGroup(Base):
    """A LOCAL access-group catalog entry — instance-scoped (v2 AccessGroupDocument).

    Faithful port of ``neubit_v2/backend/gates/app/module/access_groups`` — a LOCAL
    repository catalog (NOT a DDS write-through). ``door_ids`` and ``schedule_id``
    are local associations the operator UI's Access Groups tab manages. Every row
    carries ``tenant_id`` + ``instance_id`` (v2 was instance-scoped; v3 adds tenant).
    """

    __tablename__ = "access_groups"
    __table_args__ = (Index("ix_access_groups_tenant_inst", "tenant_id", "instance_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    instance_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("access_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    # Door | Lift | Park | ELSGW (v2 default "Door"; plain string, no PG enum).
    access_group_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'Door'")
    )
    api_key: Mapped[str | None] = mapped_column(String(200))
    door_ids: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )
    schedule_id: Mapped[str | None] = mapped_column(String(36))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class Schedule(Base):
    """A LOCAL schedule catalog entry — instance-scoped (v2 ScheduleDocument).

    Faithful port of ``neubit_v2/backend/gates/app/module/access_groups`` schedules
    — a LOCAL repository catalog (NOT a DDS write-through). ``windows`` is an
    embedded array of ``{days:[0..6], start_time, end_time}`` (0=Sun..6=Sat);
    ``holidays`` is a list of ``YYYY-MM-DD`` strings. Instance- + tenant-scoped.
    """

    __tablename__ = "access_schedules"
    __table_args__ = (Index("ix_access_schedules_tenant_inst", "tenant_id", "instance_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    instance_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("access_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    timezone: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'Asia/Kolkata'")
    )
    # Embedded TimeWindow array: [{days:[int], start_time:str, end_time:str}, ...].
    windows: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )
    # YYYY-MM-DD strings.
    holidays: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class SyncJob(Base):
    """A reconcile run record (v2 SyncJobORM), tenant-scoped."""

    __tablename__ = "access_sync_jobs"
    __table_args__ = (Index("ix_access_sync_jobs_inst_started", "instance_id", "started_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: mirrors the owning instance's tenant. ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    instance_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("access_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # full | collection.
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'full'")
    )
    # succeeded | partial | failed | running.
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'running'"), index=True
    )
    trigger: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'manual'")
    )

    created_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    updated_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    deleted_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    error_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    # Per-collection counts + per-entity error detail (JSONB blobs, v2 shape).
    counts: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    errors: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    error: Mapped[str | None] = mapped_column(String(2048))

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
