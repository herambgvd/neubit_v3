"""workflow — threat_levels.set_by_name (WHO, in words)

Revision ID: 0009_threat_set_by_name
Revises: 0008_notnull_repair
Create Date: 2026-09-08

The posture card printed "by 3cd1c8ca-c927-41af-9101-c345241c7492". That is a
lookup nobody can perform from the screen it appears on, and this service has no
users table to perform it with.

So the name is STAMPED at write time, the way an audit row snapshots its actor —
core now carries the caller's display name in the access token, so it costs no
call. Nullable with no default: existing rows read as "name unknown" and the API
falls back to the id, which is exactly what they are. Postgres rewrites no rows.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_threat_set_by_name"
down_revision = "0008_notnull_repair"
branch_labels = None
depends_on = None

_TABLE = "threat_levels"
_COLUMN = "set_by_name"


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(c["name"] == column for c in insp.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, _TABLE, _COLUMN):
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(255), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
