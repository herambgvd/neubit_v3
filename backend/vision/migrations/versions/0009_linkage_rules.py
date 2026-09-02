"""linkage_rules + linkage_fires (P5-B)

Revision ID: 0009_linkage_rules
Revises: 0008_vms_events
Create Date: 2026-07-09

Adds the event-linkage tables:
  * ``linkage_rules`` — one row per event→action rule (trigger + filter + camera scope
    + ordered action list + cooldown + weekly schedule). The linkage engine loads active
    rules by (tenant, trigger_event_type) on every incoming NATS event.
  * ``linkage_fires`` — one audit row per rule-fire (which rule fired what, when, on
    which event, per-action outcome; + the produced recording id for evidence).

Tenant-scoped; plain-string trigger types (no PG enum); JSON for the filter / scope /
actions / schedule blobs. Idempotent — ``Table.create(checkfirst=True)`` off the live
model metadata (the v3 baseline pattern, matches ``0001``-``0008``). A fresh deploy gets
both tables from the baseline sweep too (both list them); this migration lands them on
already-deployed DBs.
"""

from alembic import op

revision = "0009_linkage_rules"
down_revision = "0008_vms_events"
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.vms.models import LinkageFire, LinkageRule

    return [LinkageRule.__table__, LinkageFire.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
