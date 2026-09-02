"""Event-linkage / action rules + fire-audit (P5-B).

A ``LinkageRule`` maps a trigger (a normalized event type + optional filter + a camera
scope) to an ordered list of actions (start_recording / notify / ptz_preset /
trigger_output / popup). The linkage engine (``app/vms/linkage/service.py``) matches an
incoming NATS event (a camera ``tenant.*.vms.>`` event OR an access ``tenant.*.access.>``
door event) against every enabled rule, honours the per-rule schedule window + cooldown,
and executes the action list — logging one ``LinkageFire`` row per fired rule (which rule
fired what, when, on which event, and per-action outcome).

Ported (shape + match/cooldown semantics) from ``gvd_nvr``
``events/models.py::LinkageRule`` + ``events/linkage_service.py``, adapted to the v3
tenant-scoped ORM conventions (nullable ``tenant_id``; NO PG enums — every
type/mode/status column is a plain string; JSON for the filter / scope / actions /
schedule blobs).

⭐ Migration gotcha (project memory): this module is imported by BOTH
``migrations/env.py`` (via ``app.vms.models``) AND the ``0001_vision_baseline._tables()``
sweep — a model whose module isn't imported in both is silently dropped on a fresh
deploy. Keep ``models/__init__`` ``__all__`` + the baseline list + ``0009`` in sync.
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


class LinkageRule(Base):
    """An event → action-list rule (trigger + filter + camera scope + actions), tenant-scoped."""

    __tablename__ = "linkage_rules"
    __table_args__ = (
        # The engine loads active rules by (tenant, trigger_event_type) on every event —
        # the primary access path. A second index on is_active for the estate-wide list.
        Index("ix_linkage_rules_tenant_trigger", "tenant_id", "trigger_event_type"),
        Index("ix_linkage_rules_active", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    # The normalized event this rule reacts to. Camera events use the P5-A vocabulary
    # (motion|tamper|video_loss|io_input|line_crossing|zone_intrusion|audio|…); access
    # door events use ``access_door_<type>`` (e.g. access_door_forced|access_door_held).
    trigger_event_type: Mapped[str] = mapped_column(String(48), nullable=False)

    # Optional match refinements (JSON) — e.g. {"severity": "alarm", "zone": "3",
    # "min_severity": "warning"}. Empty = match any event of the trigger type.
    trigger_filter: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )

    # Camera scope (JSON) — {"all": true} | {"camera_ids": [...]} | {"group_ids": [...]}.
    # For an ACCESS door trigger this is usually {"all": true}: the target camera is
    # resolved from the door (explicit door↔camera map or placement proximity), not the
    # scope. Empty/absent → treated as {"all": true}.
    camera_scope: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )

    # The ordered action list (JSON) — [{"type": "start_recording", "config": {...}}, …].
    # Action types: start_recording | notify | ptz_preset | trigger_output | popup.
    actions: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )

    # Don't re-fire this rule within N seconds of its last fire (per-rule debounce).
    cooldown_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    # Weekly active windows (JSON) — {"mon": [["08:00","18:00"]], …}. Empty = always on.
    schedule: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class LinkageFire(Base):
    """An audit row per rule-fire — which rule fired what, when, on which event.

    One row per (rule, triggering event) execution. ``actions_result`` records each
    action's outcome (``[{"type": ..., "ok": bool, "detail": ...}]``) so the operator /
    a report can see exactly what a rule did — an action that failed (device down) is
    logged here with ``ok=false`` and the engine continues.
    """

    __tablename__ = "linkage_fires"
    __table_args__ = (
        Index("ix_linkage_fires_rule_fired", "rule_id", "fired_at"),
        Index("ix_linkage_fires_tenant_fired", "tenant_id", "fired_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    rule_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    rule_name: Mapped[str | None] = mapped_column(String(255))

    # What triggered it: the normalized trigger type + the source event id + camera.
    trigger_event_type: Mapped[str] = mapped_column(String(48), nullable=False)
    # The VmsEvent id (camera event) OR the access event id (door event) that fired it.
    source_event_id: Mapped[str | None] = mapped_column(String(64), index=True)
    # The camera the actions targeted (resolved for a door event).
    camera_id: Mapped[str | None] = mapped_column(String(36), index=True)
    # For a door-triggered fire: the door/device ref that resolved to the camera.
    door_ref: Mapped[str | None] = mapped_column(String(64))

    # Per-action outcome list (JSON) — [{"type", "ok", "detail"}, …].
    actions_result: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )
    # A recording id produced by a start_recording action (evidence link), if any.
    recording_id: Mapped[str | None] = mapped_column(String(36), index=True)

    fired_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
