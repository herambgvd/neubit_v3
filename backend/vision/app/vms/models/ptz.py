"""PTZ operator-control models — presets + patrols/guard-tours (G1).

A PTZ camera's full operator surface (continuous move / zoom / focus / presets /
patrols) needs two persisted catalogs on top of the transient driver commands:

  * ``PtzPreset`` — a NAMED saved viewpoint. The driver stores the physical preset on
    the device (``SetPreset`` → a device ``preset_token``); THIS row is the tenant-scoped
    catalog entry the UI lists + recalls (goto). ``preset_token`` is the on-device token
    the driver recalls; ``position`` is a best-effort {pan,tilt,zoom} snapshot (drivers
    that report absolute position fill it — most don't, so it is nullable/advisory only).
  * ``PtzPatrol`` — a guard-tour: an ORDERED list of stops (``[{preset_id, dwell_seconds},
    ...]``) cycled by the server-side patrol cycler (``ptz.cycler``). ``is_running`` records
    the operator's start/stop INTENT + is the flag the cycler restarts from; the actual
    asyncio cycler task is process-local (a process restart drops running tasks — the
    service re-arms them from ``is_running`` on the next start, and a running patrol lost to
    a restart is an accepted caveat, documented in the service). ``schedule`` is an optional
    time-window/cron blob for future scheduled auto-start (advisory; not driven yet).

Both are tenant-scoped (nullable ``tenant_id``; NULL = platform/system row) and use
plain-string / JSON columns — NO PG enums (the asyncpg add-column enum footgun, project
memory).

⭐ Migration gotcha (project memory): this module must be imported by BOTH
``migrations/env.py`` (via ``app.vms.models``) AND the ``0001_vision_baseline._tables()``
sweep AND landed on deployed DBs by ``0014_ptz`` — a model whose module isn't imported in
all three is silently dropped on a fresh deploy. Keep ``models/__init__`` ``__all__`` + the
baseline list + ``0014`` in sync.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class PtzPreset(Base):
    """A named, tenant-scoped saved PTZ viewpoint for a camera.

    ``preset_token`` is the on-device token the driver ``goto_preset`` recalls (assigned by
    the camera's ``SetPreset`` at create time). ``position`` is an advisory {pan,tilt,zoom}
    snapshot (nullable — most drivers can't report absolute position). Uniqueness is enforced
    in the service (name unique per camera within a tenant), not by a DB constraint (keeps the
    portable-SQLite baseline simple).
    """

    __tablename__ = "ptz_presets"
    __table_args__ = (
        Index("ix_ptz_presets_tenant", "tenant_id"),
        Index("ix_ptz_presets_camera", "camera_id"),
        Index("ix_ptz_presets_tenant_camera", "tenant_id", "camera_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    camera_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # On-device preset token the driver GotoPreset recalls (None until the device stores it).
    preset_token: Mapped[str | None] = mapped_column(String(255))
    # Advisory {pan, tilt, zoom} snapshot (nullable — most devices don't report position).
    position: Mapped[dict | None] = mapped_column(JSON)

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class PtzPatrol(Base):
    """A guard-tour: an ordered list of preset stops cycled on per-stop dwell.

    ``stops`` is the ordered JSON list ``[{"preset_id": <PtzPreset.id>, "dwell_seconds": N},
    ...]`` — the cycler goto-presets each stop in turn, holding ``dwell_seconds`` between
    advances. ``is_running`` records the operator's start/stop INTENT (the process-local
    asyncio cycler task is keyed off it; a process restart drops the task but the flag lets an
    operator re-start it). ``schedule`` is an optional advisory time-window blob for future
    scheduled auto-start.
    """

    __tablename__ = "ptz_patrols"
    __table_args__ = (
        Index("ix_ptz_patrols_tenant", "tenant_id"),
        Index("ix_ptz_patrols_camera", "camera_id"),
        Index("ix_ptz_patrols_tenant_camera", "tenant_id", "camera_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    camera_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Ordered stops: [{"preset_id": str, "dwell_seconds": int}, ...].
    stops: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    # PTZ move speed (0..1) the cycler passes to goto (device dependent).
    speed: Mapped[float] = mapped_column(
        Float, nullable=False, server_default=text("0.5")
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    # Operator start/stop intent — the cycler re-arms from this.
    is_running: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    # Optional advisory schedule blob (time windows / cron) for future auto-start.
    schedule: Mapped[dict | None] = mapped_column(JSON)

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
