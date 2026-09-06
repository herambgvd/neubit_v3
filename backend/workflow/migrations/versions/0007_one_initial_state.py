"""workflow — at most one initial state per SOP, and a pointer that agrees with it

Revision ID: 0007_one_initial_state
Revises: 0006_notification_claim
Create Date: 2026-09-05

``sops.initial_state`` and the ``is_initial`` flag could disagree, because the
service assigned the pointer on some write paths and not others. The service fix
derives the pointer from the flag everywhere; this migration repairs the rows that
are already wrong and adds the half of the invariant a schema can hold.

The index is on (tenant_id, sop_id), not sop_id, so it says exactly what
``_clear_initial`` enforces through ``scoped`` — a state row carrying a foreign
tenant_id is corruption and must not fail the innocent tenant's next write. NULLS
NOT DISTINCT (PG 15+) because a NULL tenant_id is a real platform row here.

Not a trigger: "this column equals the id of the child flagged is_initial" is not
expressible as a constraint, and a PL/pgSQL trigger would be Postgres-only and so
invisible to a suite that runs on SQLite.

Safe on a live table. Both repairs only touch rows that are already wrong, and the
index is built CONCURRENTLY after the duplicates are demoted — a concurrent build
that hits a duplicate leaves an INVALID index behind.

A SOP with several initial states keeps one: the one the pointer already names if
it is among them, else the oldest. A pointer naming a deleted or foreign state is
set to the flagged state, or NULL when there is none — that SOP cannot be launched,
and it could not before either.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_one_initial_state"
down_revision = "0006_notification_claim"
branch_labels = None
depends_on = None

INDEX = "uq_workflow_states_one_initial_per_sop"

# Demote every initial state but one per (tenant_id, sop_id). Window PARTITION BY
# groups NULL tenant_ids together, which is what NULLS NOT DISTINCT then enforces.
# LEFT JOIN so a state orphaned by a deleted SOP is deduped too.
_DEMOTE_DUPLICATES = sa.text("""
    WITH ranked AS (
        SELECT s.state_id,
               row_number() OVER (
                   PARTITION BY s.tenant_id, s.sop_id
                   ORDER BY (p.initial_state IS NOT DISTINCT FROM s.state_id) DESC,
                            s.created_at ASC, s.state_id ASC
               ) AS rn
          FROM workflow_states s
          LEFT JOIN sops p ON p.sop_id = s.sop_id
         WHERE s.is_initial
    )
    UPDATE workflow_states t
       SET is_initial = false
      FROM ranked r
     WHERE t.state_id = r.state_id AND r.rn > 1
""")

_FLAGGED = """
    SELECT s.state_id FROM workflow_states s
     WHERE s.sop_id = p.sop_id AND s.is_initial
       AND s.tenant_id IS NOT DISTINCT FROM p.tenant_id
     LIMIT 1
"""

_REPOINT = sa.text(f"""
    UPDATE sops p
       SET initial_state = ({_FLAGGED})
     WHERE p.initial_state IS DISTINCT FROM ({_FLAGGED})
""")


def _has_index(bind, table: str, index: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(ix["name"] == index for ix in insp.get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("workflow_states"):
        return
    if bind.dialect.name != "postgresql":
        # SQLite (tests) builds its schema from the models, which already carry the
        # index; there is nothing here that a non-Postgres deployment needs.
        return

    op.execute(_DEMOTE_DUPLICATES)
    op.execute(_REPOINT)

    if not _has_index(bind, "workflow_states", INDEX):
        # CONCURRENTLY cannot run inside a transaction block.
        with op.get_context().autocommit_block():
            op.execute(sa.text(
                f"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS {INDEX} "
                "ON workflow_states (tenant_id, sop_id) NULLS NOT DISTINCT "
                "WHERE is_initial"
            ))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql" and _has_index(bind, "workflow_states", INDEX):
        with op.get_context().autocommit_block():
            op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX}"))
    # The two repairs are NOT undone: re-introducing a dangling pointer or a second
    # initial state is not a rollback, it is the bug.
