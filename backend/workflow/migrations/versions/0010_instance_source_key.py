"""workflow — workflow_instances.source_key: a finding raises work once

Revision ID: 0010_instance_source_key
Revises: 0009_threat_set_by_name
Create Date: 2026-09-19

Building Intelligence's gate 6 raises work from a FINDING — a chiller's ΔT band,
a silent slot, a gateway alert — and a finding that already has open work must
return that work rather than raise a second incident. Nothing on the row could
say what an incident is ABOUT: ``event_id`` is a bus envelope id and
``trigger_data`` is an opaque envelope. So the producer names it, in a column of
its own, and a partial unique index holds at most one OPEN incident per
(tenant, key). Closing the incident frees the key.

The predicate is the complement of ``core.enums.CLOSED_STATUSES`` spelled as a
literal, because an index predicate cannot call Python; the model carries the
same literal and ``tests/test_instances_source_key.py`` pins that they agree.
NULLS NOT DISTINCT (PG 15+) for the reason 0007 gives: a NULL tenant_id is a real
platform row here.

DDL is written out rather than derived from the model, so this revision says the
same thing forever however the model grows.

Safe on a live table. The column is nullable with no default, so Postgres adds it
without rewriting a row, and every existing incident has NULL — which the
predicate excludes, so the index cannot fail to build on today's data. It is
still built CONCURRENTLY: ``workflow_instances`` is the one table here that grows,
and a plain CREATE INDEX would hold writes off it for the length of the build.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_instance_source_key"
down_revision = "0009_threat_set_by_name"
branch_labels = None
depends_on = None

_TABLE = "workflow_instances"
_COLUMN = "source_key"
INDEX = "uq_workflow_instances_open_source_key"


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(c["name"] == column for c in insp.get_columns(table))


def _has_index(bind, table: str, index: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(ix["name"] == index for ix in insp.get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table(_TABLE):
        return
    if not _has_column(bind, _TABLE, _COLUMN):
        op.execute(sa.text(f"ALTER TABLE {_TABLE} ADD COLUMN {_COLUMN} VARCHAR(255)"))
    if bind.dialect.name != "postgresql":
        # SQLite (tests) builds its schema from the models, which carry the index.
        return
    if not _has_index(bind, _TABLE, INDEX):
        # CONCURRENTLY cannot run inside a transaction block.
        with op.get_context().autocommit_block():
            op.execute(sa.text(
                f"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS {INDEX} "
                f"ON {_TABLE} (tenant_id, {_COLUMN}) NULLS NOT DISTINCT "
                f"WHERE {_COLUMN} IS NOT NULL "
                "AND status NOT IN ('resolved', 'cancelled')"
            ))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql" and _has_index(bind, _TABLE, INDEX):
        with op.get_context().autocommit_block():
            op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX}"))
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
