"""reporting: a point can be SUPERSEDED by the point that replaced it

Revision ID: 0024_point_supersede
Revises: 0023_iot_alerts_ack
Create Date: 2026-09-19

THE PROBLEM, MEASURED
---------------------
`points` on this deployment holds 766 rows with `retired_at IS NULL` and only
475 distinct `(device_tag, point_tag)` pairs. 283 pairs are duplicated, across
574 of those rows.

Nothing is wrong with the gateway's behaviour and nothing here can stop it. A
conflux connection that is deleted and re-created mints a NEW `point_id` for
every point behind it — the id is the connection's, not the meter's — and the
writer's upsert (contract §6) creates a dimension row for an id it has never
seen, which is exactly what it must do. Sometimes the tag spelling changes too.
So one physical register accumulates a generation per rebuild, all of them
`retired_at IS NULL`, all of them counted in every estate figure forever.

The retirement horizon from 0006 does NOT cover this. It is applied at QUERY
time on `last_seen_at`, so a ghost does stop being counted after
VE_READINGS_RETIRE_AFTER_DAYS — but it stays in the browse list, it stays
`retired_at IS NULL`, nothing records that it was superseded, and its history is
unreachable from the point that replaced it. The horizon answers "is this
reporting"; it cannot answer "which row IS this meter now".

WHAT THIS MIGRATION DOES NOT DO: MOVE ANY READINGS
--------------------------------------------------
The obvious repair is to re-point the ghost's readings at the survivor and
delete the ghost. It is not done and must not be.

`readings` is a compressed TimescaleDB hypertable with PK `(point_id, ts)`.
Re-pointing means decompressing chunks, rewriting the primary key of hundreds of
thousands of rows, and hitting a unique violation on every timestamp both
generations happen to share — during a cutover, both DO report. The gain is
cosmetic: a single `point_id` for a chart that could have joined instead.

So history is joined LOGICALLY. `superseded_by` is a continuity chain: the ghost
keeps every reading it ever produced under its own id, and anything that wants
the whole series walks the chain. Nothing is rewritten, nothing is deleted, and
the operation is reversible because it only ever wrote two nullable columns.

THE TWO COLUMNS, AND WHY THE SECOND ONE EXISTS
----------------------------------------------
``superseded_by``  uuid, the point that REPLACED this one. NULL means nothing
                   claims to have replaced it — the state of almost every row.

``retire_reason``  varchar(32), WHO retired it and by which route. The collapse
                   writes `'ghost'`. An operator's explicit retire through
                   `/bi/points/{id}/retire` writes nothing and leaves it NULL,
                   which is the pre-existing behaviour and stays correct.

`retire_reason` is what makes the undo safe. Without it, "restore these points"
would be indistinguishable from "un-retire whatever I name", and a bulk undo of
a collapse would silently resurrect every meter an operator had decommissioned
by hand. With it, restore can refuse anything not marked `'ghost'` — so the undo
reaches exactly the rows the collapse wrote and nothing else.

NULLABLE, NO BACKFILL, NO FOREIGN KEY
-------------------------------------
Nullable because NULL is the honest value for every existing row: nobody has
said this point was superseded. No backfill, because deciding which of three
generations is the survivor is the operator judgement this feature exists to
ASK for — 264 of the 283 duplicated pairs have exactly one member reporting in
the last 15 minutes and can be proposed automatically, and 19 have none, which
no rule can settle.

No foreign key to `points.point_id`, deliberately. A self-referential FK would
make the DPDP erasure walk (`kernel.lifecycle.erase_tenant_data`) order-
dependent on a chain it knows nothing about, and would turn a legitimate
purge of an old generation into a constraint violation on a row that merely
pointed at it. A dangling `superseded_by` reads as "the survivor is gone", which
is information, not corruption.

NOT REGISTERED AS A DIMENSION
-----------------------------
Same reasoning as 0021 and 0022: `superseded_by` is a raw uuid and nothing can
turn one into a name yet. `retire_reason` is low cardinality and would group
cleanly, but it is MUTABLE — a restore clears it — and 0023 already recorded why
a mutable value must not enter a rollup's GROUP BY.
"""

from __future__ import annotations

from alembic import op

revision = "0024_point_supersede"
down_revision = "0023_iot_alerts_ack"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS, kept for a reason that has since changed shape.
    #
    # It was written this way because `0001_reporting_baseline` did not spell its
    # tables out — it called `Point.__table__.create(bind, checkfirst=True)`, so
    # a FRESH database got every column the model had TODAY straight from the
    # baseline, and the plain `op.add_column` that was supposed to introduce one
    # then failed with DuplicateColumnError on the way up. (Measured: a fresh
    # timescaledb:2.17.2-pg16 stopped at 0003 with `column "device_type" of
    # relation "points" already exists`; 0008 and 0022 had the same shape.)
    #
    # 0001 has since been rewritten to create the schema as it stood at 0001,
    # explicitly, so a fresh database no longer arrives here with these columns
    # already present and a plain `op.add_column` would now be correct.
    #
    # The guard stays anyway, and only because of the databases in between: any
    # environment that was built on the OLD baseline while sitting below 0024
    # does have `superseded_by` and `retire_reason` already, and IF NOT EXISTS is
    # what lets it cross this revision instead of stalling on it. It is the
    # exception this chain tolerates, not the pattern — every other revision
    # states its step plainly, and so does 0001 now.
    op.execute("ALTER TABLE points ADD COLUMN IF NOT EXISTS superseded_by uuid")
    op.execute("ALTER TABLE points ADD COLUMN IF NOT EXISTS retire_reason varchar(32)")
    # "what did this point absorb" — the reverse direction of the chain, which is
    # what a survivor's history view and the restore worklist both ask. PARTIAL:
    # `superseded_by` is NULL on all but the collapsed tail, so the index costs
    # almost nothing to carry and the scan it replaces is the whole table.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_points_superseded_by "
        "ON points (superseded_by) WHERE superseded_by IS NOT NULL"
    )


def downgrade() -> None:
    """Drops both columns and the index.

    This DOES lose the continuity chain — a collapse applied before the
    downgrade leaves its ghosts retired with no record of what replaced them.
    That is stated rather than worked around: restoring the chain would mean
    inventing survivors, and the collapse is undone with
    `POST /bi/points/ghosts/restore` while the columns still exist, not by
    stepping the schema backwards.
    """
    op.execute("DROP INDEX IF EXISTS ix_points_superseded_by")
    op.execute("ALTER TABLE points DROP COLUMN IF EXISTS retire_reason")
    op.execute("ALTER TABLE points DROP COLUMN IF EXISTS superseded_by")
