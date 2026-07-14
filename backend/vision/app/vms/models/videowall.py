"""Video-wall models — shared control-room display wall (VW-A).

An enterprise VMS (Milestone Smart Wall / Genetec / CP-Plus) offers a **shared,
centrally-managed control-room Video Wall** on top of a single operator's live grid: a
grid of physical monitors that operators drive from their workstation, with shared live
state, presets, tours and (VW-B) hardware-decoder push.

Shape (all tenant-scoped — nullable ``tenant_id``; NO PG enums — plain-string ``kind``):

  * ``VideoWall``  — a named display surface: a rows×cols grid of monitors. Its LIVE
    state (which camera shows in which monitor cell RIGHT NOW) is kept as a single JSON
    ``state`` column on THIS row — one atomic blob for one-shot broadcast + recall. The
    state maps ``{monitor_id: {cell_index(str): camera_id}}``. Keeping it on the wall row
    (rather than a per-cell table) makes every mutation a single-row write and every
    SSE broadcast / preset snapshot a single-row read — exactly what a "replace the whole
    wall" realtime model wants.
  * ``WallMonitor`` — one screen in the wall. ``kind`` is ``browser`` (a fullscreen kiosk
    browser rendering its cells live via MediaMTX) or ``decoder`` (a hardware decoder
    output driven over its SDK — VW-B). ``layout`` is the mini-grid key (1|4|9|16) of
    cells the monitor shows. ``decoder_id`` / ``decoder_channel`` are nullable stubs the
    VW-B decoder push fills in.
  * ``WallPreset`` — a saved snapshot of the whole wall's ``state`` (JSON), recall in one
    click. ``is_default`` marks the preset applied on wall open.
  * ``WallTour``   — a named ordered sequence of presets (``preset_ids``) cycled on a
    ``dwell_seconds`` interval (a "salvo").

⭐ Migration gotcha (project memory): this module is imported by BOTH
``migrations/env.py`` (via ``app.vms.models``) AND the ``0001_vision_baseline._tables()``
sweep AND landed on deployed DBs by ``0012_video_wall`` — a model whose module isn't
imported in all three is silently dropped on a fresh deploy. Keep ``models/__init__``
``__all__`` + the baseline list + ``0012`` in sync.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class VideoWall(Base):
    """A named, tenant-scoped shared display surface (rows×cols grid of monitors).

    ``state`` is the LIVE shared wall state — a single JSON blob mapping
    ``{monitor_id: {cell_index(str): camera_id}}``. It is the one source of truth every
    operator + display-client syncs to (over the wall SSE). Held here (not a per-cell
    table) so each mutation is one atomic row write and each broadcast is one row read.
    """

    __tablename__ = "video_walls"
    __table_args__ = (
        Index("ix_video_walls_tenant", "tenant_id"),
        Index("ix_video_walls_tenant_site", "tenant_id", "site_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    # Optional placement (a wall belongs to a control room on a site).
    site_id: Mapped[str | None] = mapped_column(String(36))

    # Grid geometry — how the monitors are arranged (rows×cols of screens).
    rows: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("2"))
    cols: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("2"))

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    # LIVE shared state: {monitor_id: {cell_index(str): camera_id}}. Empty = a blank wall.
    state: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class WallMonitor(Base):
    """One screen in a wall — a mini-grid (``layout``) of cells, each showing a camera.

    ``kind='browser'`` renders live via MediaMTX in a kiosk browser; ``kind='decoder'``
    is a hardware decoder output driven over its SDK (VW-B fills ``decoder_id`` /
    ``decoder_channel``). ``position`` is the monitor's index in the wall grid.
    """

    __tablename__ = "wall_monitors"
    __table_args__ = (
        Index("ix_wall_monitors_wall", "wall_id"),
        Index("ix_wall_monitors_tenant", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    wall_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # The monitor's index in the wall grid (0-based, row-major).
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    # 'browser' (kiosk browser via MediaMTX) | 'decoder' (hardware decoder — VW-B).
    kind: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'browser'"))
    # The mini-grid of cells this monitor shows (1 | 4 | 9 | 16).
    layout: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))

    # VW-B decoder push — nullable until a decoder monitor is wired to hardware.
    decoder_id: Mapped[str | None] = mapped_column(String(36))
    decoder_channel: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class WallPreset(Base):
    """A saved snapshot of a wall's whole ``state`` — recall in one click.

    ``state`` is a JSON copy of ``VideoWall.state`` at save time. ``is_default`` marks the
    preset a wall opens on / a tour cycles through.
    """

    __tablename__ = "wall_presets"
    __table_args__ = (
        Index("ix_wall_presets_wall", "wall_id"),
        Index("ix_wall_presets_tenant", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    wall_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # {monitor_id: {cell_index(str): camera_id}} snapshot.
    state: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class WallTour(Base):
    """A named ordered sequence of presets cycled on a dwell interval (a salvo).

    ``preset_ids`` is the ordered JSON list of ``WallPreset`` ids; ``dwell_seconds`` is
    how long each preset holds before advancing. The tour runner (VW-D operator console /
    a server-side cycler) applies each preset in turn.
    """

    __tablename__ = "wall_tours"
    __table_args__ = (
        Index("ix_wall_tours_wall", "wall_id"),
        Index("ix_wall_tours_tenant", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    wall_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Ordered list of preset ids to cycle through.
    preset_ids: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    dwell_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("10")
    )
    # Whether this tour is currently running (control-plane hint; the runner lives client
    # / cycler-side in VW-D — VW-A just records the operator's start/stop intent).
    is_running: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
