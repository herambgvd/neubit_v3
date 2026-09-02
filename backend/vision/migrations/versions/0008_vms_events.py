"""vms_events + camera event-subscription columns (P5-A)

Revision ID: 0008_vms_events
Revises: 0007_export_jobs
Create Date: 2026-07-09

Adds the ``vms_events`` table (one row per normalized camera device / system event
the P5-A event-supervisor ingests) and two ``cameras`` columns that gate + scope the
per-camera subscription: ``onvif_events_enabled`` (open a subscription for this
camera?) + ``onvif_event_topics`` (optional normalized-type allow-list).

Tenant-scoped; plain-string ``event_type`` / ``severity`` / ``source`` (no PG enum).
The dedup_key column carries a UNIQUE index so the supervisor's insert is idempotent
under a racing double-notification / at-least-once redelivery.

Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata (the v3
baseline pattern, matches ``0001``-``0007``). The two column adds are guarded so a
re-run / fresh-baseline deploy (which already has them from the baseline sweep) is a
no-op. A fresh deploy gets ``vms_events`` from the baseline sweep too (both list it);
this migration lands table + columns on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0008_vms_events"
down_revision = "0007_export_jobs"
branch_labels = None
depends_on = None


def _table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.vms.models import VmsEvent

    return VmsEvent.__table__


def _camera_columns() -> set[str]:
    bind = op.get_bind()
    return {c["name"] for c in inspect(bind).get_columns("cameras")}


def upgrade() -> None:
    bind = op.get_bind()
    # New table.
    _table().create(bind, checkfirst=True)

    # New cameras columns (guard so a baseline-fresh DB that already has them is a
    # no-op). Server defaults keep existing rows valid without a rewrite.
    existing = _camera_columns()
    from app.vms.models import Camera

    for name in ("onvif_events_enabled", "onvif_event_topics"):
        if name not in existing:
            op.add_column("cameras", Camera.__table__.c[name].copy())


def downgrade() -> None:
    bind = op.get_bind()
    existing = _camera_columns()
    for name in ("onvif_event_topics", "onvif_events_enabled"):
        if name in existing:
            op.drop_column("cameras", name)
    _table().drop(bind, checkfirst=True)
