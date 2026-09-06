"""workflow — 16 columns the models call NOT NULL and the table left nullable

Keep the line above to one line: Alembic prints it on every upgrade.

``alembic revision --autogenerate`` never came back empty on this service — it
reported the same 16 ``SET NOT NULL`` operations every time, which made it useless
for reviewing a real schema change. This turns the detector back on.

Root cause: ``0001_workflow.py`` writes these as
``sa.Column(..., server_default=...)``, which defaults to ``nullable=True``. A
server_default decides what an omitted value becomes, not whether NULL may be
written. 0001 is not edited — it has already run on every estate.

The tables are empty here, so the backfills are no-ops on this estate. They are
written for the ones where they are not: ``SET NOT NULL`` against a column holding
one NULL takes the deploy down. Each backfill was chosen by asking what an existing
NULL means to the code reading it today, not by copying the model default.

Thirteen columns do take the model default, because the read path already treats
NULL as that value (boolean truth tests, cosmetic colours, the diagram origin,
``sop_version`` → 1, ``priority`` → 'medium', ``event_source`` → ''). Two are worth
calling out:

 * ``workflow_triggers.event_type`` → ``''`` means MATCH ANY EVENT TYPE
   (``if not t.event_type or ...`` in correlation/engine.py). That is not a new
   wildcard — a NULL already matches everything today, so this only writes down
   what those triggers already do. Disabling them instead would silently stop
   incidents being raised.
 * ``workflow_states.order`` does NOT take the model default of 0. States sort
   ``ORDER BY "order" ASC, created_at ASC`` and Postgres puts NULLs last, so
   writing 0 would move every NULL-ordered state to the front and silently reorder
   an operator's diagram. Each NULL instead gets a value above every non-NULL order
   in the same SOP, ranked by ``created_at``, so the rendered order is unchanged.

No ``CHECK ... NOT VALID`` dance. Fifteen of these are config tables with hundreds
of rows, where the scan is sub-millisecond and the dance would replace one ACCESS
EXCLUSIVE acquisition with three. ``workflow_instances`` is the only one that grows
on its own (~1M rows at three years of a busy estate, a scan of about a second),
and this runs before uvicorn binds, with the worker gated on the API being healthy.

Revisit that if an estate passes ~10^8 instance rows, or if anyone migrates without
stopping the API; then split workflow_instances into its own autocommit revision
doing the three-step. The other fifteen still would not need it.

``SET LOCAL lock_timeout`` is the real safety property: without it a lock request
that cannot be granted blocks every query queued behind it. With it the migration
fails promptly, Alembic rolls the revision back whole, and the operator retries.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_notnull_repair"
down_revision = "0007_one_initial_state"
branch_labels = None
depends_on = None

# (table, column, the SQL literal an existing NULL becomes). All take the model's
# own default; see the module docstring for the two that do not.
_BACKFILL: list[tuple[str, str, str]] = [
    ("alert_formats", "color_code", "'#6B7280'"),
    ("notification_channels", "is_default", "false"),
    ("workflow_instances", "sop_version", "1"),
    ("workflow_instances", "is_sla_breached", "false"),
    ("workflow_states", "color", "'#6366F1'"),
    ("workflow_states", "position_x", "0"),
    ("workflow_states", "position_y", "0"),
    ("workflow_states", "is_initial", "false"),
    ("workflow_states", "is_terminal", "false"),
    ("workflow_states", "is_cancellation", "false"),
    ("workflow_transitions", "requires_note", "false"),
    ("workflow_transitions", "confirmation_required", "false"),
    ("workflow_triggers", "event_source", "''"),
    ("workflow_triggers", "event_type", "''"),
    ("workflow_triggers", "priority", "'medium'"),
]

# ``order`` is a reserved word, hence the quoting. Ranked by created_at (the
# tiebreak sops/service.py sorts on) and offset past the SOP's existing maximum, so
# the NULL rows stay where NULLS LAST puts them today.
_ORDER_BACKFILL = sa.text("""
    WITH ranked AS (
        SELECT s.state_id,
               COALESCE(m.max_order, 0)
                 + ROW_NUMBER() OVER (PARTITION BY s.sop_id
                                      ORDER BY s.created_at, s.state_id) AS new_order
          FROM workflow_states s
          LEFT JOIN (SELECT sop_id, MAX("order") AS max_order
                       FROM workflow_states
                      WHERE "order" IS NOT NULL
                      GROUP BY sop_id) m ON m.sop_id = s.sop_id
         WHERE s."order" IS NULL
    )
    UPDATE workflow_states t
       SET "order" = r.new_order
      FROM ranked r
     WHERE t.state_id = r.state_id
""")

# Long enough to ride out a normal statement, short enough that a stuck migration
# is reported rather than absorbed.
_LOCK_TIMEOUT = sa.text("SET LOCAL lock_timeout = '5s'")

_ALL = _BACKFILL + [("workflow_states", "order", None)]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite (the test engine) builds tables from the models, so it already has
        # these NOT NULLs and cannot ALTER them anyway.
        return

    op.execute(_LOCK_TIMEOUT)

    for table, column, value in _BACKFILL:
        op.execute(sa.text(f'UPDATE {table} SET "{column}" = {value} WHERE "{column}" IS NULL'))
    op.execute(_ORDER_BACKFILL)

    for table, column, _ in _ALL:
        op.execute(sa.text(f'ALTER TABLE {table} ALTER COLUMN "{column}" SET NOT NULL'))


def downgrade() -> None:
    """Drop the NOT NULLs, restoring 0001's shape (nullable, defaults intact).

    It does not put the NULLs back and could not — the backfilled values are
    indistinguishable from ones that were always there. This exists to unblock a
    code rollback, not to undo the repair.
    """
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute(_LOCK_TIMEOUT)
    for table, column, _ in _ALL:
        op.execute(sa.text(f'ALTER TABLE {table} ALTER COLUMN "{column}" DROP NOT NULL'))
