"""workflow — 16 columns the models call NOT NULL and the table left nullable

The first line above is the revision MESSAGE and Alembic prints it on every
upgrade, so it stays one line. Everything below is for the reader of the file.

WHY THIS EXISTS AT ALL, AND WHY IT IS NOT COSMETIC

``alembic revision --autogenerate`` has never once come back empty on this service.
It reported the same 16 ``SET NOT NULL`` operations every time, which means nobody
could use autogenerate to review a REAL schema change: the one line that mattered
would have arrived in a diff of sixteen that did not, and the reviewer's eye is the
only thing standing between a bad column and production. A permanently noisy
detector is a detector that is off. This turns it back on.

THE ROOT CAUSE, so it does not come back. ``0001_workflow.py`` writes these columns
as ``sa.Column("is_initial", sa.Boolean(), server_default=sa.text("false"))``.
``sa.Column`` defaults to ``nullable=True``; the models declare the same columns as
non-``Optional`` ``Mapped[bool]``, which is NOT NULL. A ``server_default`` looks
like it settles the question and does not — it decides what an omitted value
becomes, not whether NULL may be written. 0001 is NOT edited to fix this: it has
run on every existing estate and rewriting history that has already executed makes
the schema depend on which version of a file an installation happened to apply. The
repair is a new revision, which is the only kind that is true everywhere.

ON THIS ESTATE EVERY ONE OF THESE TABLES IS EMPTY, so the backfills below are
no-ops here and prove nothing by running. They are written for the estates where
they are not: a ``SET NOT NULL`` against a column holding a single NULL raises and
takes the whole deploy down with it, and that failure lands on someone else's
system, at their upgrade, not ours. Each backfill is therefore chosen by asking
what an EXISTING NULL means and what the code reading it does today — not by
copying the model's default, which is only sometimes the same answer.

PER-COLUMN, WHAT A NULL BECOMES AND WHY

 * Thirteen columns take the model's own default because the code that reads them
   ALREADY treats NULL as exactly that value, so the backfill changes no
   behaviour, only the type:
     - the booleans (``notification_channels.is_default``,
       ``workflow_instances.is_sla_breached``, ``workflow_states.is_initial /
       is_terminal / is_cancellation``, ``workflow_transitions.requires_note /
       confirmation_required``) → ``false``. Every read is a Python truth test —
       ``if not inst.is_sla_breached`` in instances/jobs.py is the load-bearing one
       — under which None and False are the same. ``is_initial`` also has 0007's
       partial unique index ``WHERE is_initial``, which excludes NULL and false
       alike, so no row newly collides.
     - ``workflow_states.color`` → ``'#6366F1'`` and ``alert_formats.color_code`` →
       ``'#6B7280'``: cosmetic, and the frontend already substitutes these.
     - ``workflow_states.position_x / position_y`` → ``0``: the diagram origin,
       which is where a state with no stored position already renders.
     - ``workflow_instances.sop_version`` → ``1``. NULL here means "launched before
       the column was populated", and 1 is not a guess so much as the only version
       that existed then. Note this backfill FIXES a latent 500: instances/schemas.py
       declares ``sop_version: int``, so a NULL row already fails response
       validation on read.
     - ``workflow_triggers.priority`` → ``'medium'``, the value the enum's default
       and every UI dropdown agree on.
     - ``workflow_triggers.event_source`` → ``''``. Nothing matches on it; it is
       descriptive.
 * ``workflow_triggers.event_type`` → ``''`` is the same mechanical answer and a
   DIFFERENT question, so it is called out. Empty string means MATCH ANY EVENT TYPE
   (correlation/engine.py: ``if not t.event_type or t.event_type in event_types``),
   so this backfill hands a wildcard to every trigger that has a NULL. That is not
   a wildcard being introduced — ``not None`` is already true, so those triggers
   fire on everything TODAY and this only writes down what they do. The tempting
   alternative, treating a NULL event_type as a broken trigger and disabling it,
   would silently stop incidents being raised on an estate that has been relying on
   them, and a migration must never be the thing that quietly stops an alarm.
 * ``workflow_states.order`` does NOT take the model default of 0, and this is the
   one place where copying it would be wrong. States are listed
   ``ORDER BY "order" ASC, created_at ASC`` (sops/service.py); Postgres sorts NULLs
   LAST in an ASC ordering, so every NULL-ordered state currently renders at the END
   of its SOP. Writing 0 would move all of them to the FRONT and silently reorder
   an operator's diagram — a data-visible change, dressed as a type fix. Instead
   each NULL gets a value ABOVE every non-NULL order in the SAME SOP, ranked among
   themselves by ``created_at`` — the tiebreak the query already uses. The rendered
   order after this migration is byte-for-byte the order before it.

LOCKING, AND WHY THERE IS NO ``CHECK ... NOT VALID`` DANCE HERE

``ALTER TABLE ... SET NOT NULL`` takes ACCESS EXCLUSIVE and, on PG < 12 or with no
validated CHECK to lean on, scans the whole table while holding it. The escape is
``ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID`` (brief lock) → ``VALIDATE
CONSTRAINT`` (SHARE UPDATE EXCLUSIVE, readers and writers unblocked) → ``SET NOT
NULL``, which on PG12+ proves itself from the valid CHECK and skips the scan. It is
deliberately NOT used, for two reasons that have to hold together:

 * Fifteen of these columns live on CONFIG tables — states, transitions, triggers,
   alert formats, channels — whose row counts are bounded by what operators type.
   Hundreds of rows, low thousands at the outside. The scan is sub-millisecond and
   the dance would replace one ACCESS EXCLUSIVE acquisition with three, each of
   which is another chance to queue behind a long transaction.
 * ``workflow_instances`` is the only table here that grows without an operator,
   at one row per incident. A busy estate at ~1k incidents/day for three years is
   ~1M rows; a sequential scan of a table that narrow is a few hundred
   milliseconds to about a second. That lock is taken inside a window that is
   already a maintenance window — compose runs ``alembic upgrade head`` before
   uvicorn binds and the worker is gated on the API being healthy, so the service
   is not serving while this runs.

WHAT WOULD CHANGE THAT ANSWER, since it is the next person's decision and not a
law: an estate past roughly 10^8 instance rows (tens of seconds of scan), or any
deployment that migrates WITHOUT stopping the API. Either one, and
workflow_instances should be split out into its own autocommit-block revision doing
the three-step. The other fifteen would still not need it.

``SET LOCAL lock_timeout`` is set instead, and it is the real safety property here.
Without it an ACCESS EXCLUSIVE request that cannot be granted sits in the lock queue
AND blocks every query arriving behind it — a migration that waits becomes a
migration that takes the table down. With it, a migration that cannot get the lock
promptly fails; Alembic's transactional DDL rolls the whole revision back as one
unit, nothing is half-applied, and the operator retries. A loud failure the operator
can re-run beats a silent stall nobody can attribute.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_notnull_repair"
down_revision = "0007_one_initial_state"
branch_labels = None
depends_on = None

# (table, column, the SQL literal an existing NULL becomes). Everything here takes
# the model's own default because the read path already reads NULL as that value —
# see the module docstring for the two that do not, and why.
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

# ``order`` is a reserved word, hence the quoting throughout. Ranked by created_at
# because that is the tiebreak sops/service.py already sorts on, and offset past the
# SOP's existing maximum so the NULL rows stay where ``NULLS LAST`` puts them today.
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
# is reported rather than absorbed. See the docstring for why any value beats none.
_LOCK_TIMEOUT = sa.text("SET LOCAL lock_timeout = '5s'")

_ALL = _BACKFILL + [("workflow_states", "order", None)]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite (the test engine) builds its tables from the models, so it already
        # has the NOT NULLs this revision is adding and cannot ALTER them anyway.
        return

    op.execute(_LOCK_TIMEOUT)

    for table, column, value in _BACKFILL:
        op.execute(sa.text(f'UPDATE {table} SET "{column}" = {value} WHERE "{column}" IS NULL'))
    op.execute(_ORDER_BACKFILL)

    for table, column, _ in _ALL:
        op.execute(sa.text(f'ALTER TABLE {table} ALTER COLUMN "{column}" SET NOT NULL'))


def downgrade() -> None:
    """Drop the NOT NULLs, restoring 0001's shape exactly (nullable, defaults intact).

    It does NOT put the NULLs back, and could not: the values that replaced them are
    indistinguishable from the ones that were always there. That is the ordinary
    property of a backfill and the reason this direction exists only to unblock a
    rollback of the code, not to undo the repair.
    """
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute(_LOCK_TIMEOUT)
    for table, column, _ in _ALL:
        op.execute(sa.text(f'ALTER TABLE {table} ALTER COLUMN "{column}" DROP NOT NULL'))
