"""The database half: one batch in, one transaction out.

Same three rules the reading-writer's store implements, for the same reasons —
they are properties of the pipeline, not of the IoT domain:

**One INSERT per batch, never one per event.** A per-event INSERT is what kills
these systems. Everything here is set-based.

**`ON CONFLICT DO NOTHING` on the natural key.** Replay on a durable consumer is
expected and normal, not an error. The natural key (a projection declares it —
for access it is the source event's own id plus the event time) is what makes a
redelivery a no-op instead of a duplicate-key failure that would poison the whole
batch and then poison every retry of it.

**All-or-nothing.** One batch is one transaction, so a batch that fails mid-write
leaves NOTHING behind. That is exactly what makes "do not ack until it is durably
written" safe: the redelivered batch re-does the whole thing and the primary key
absorbs anything that did land.

WHY THE SQL IS BUILT AS TEXT
----------------------------
A projection's relation and columns are known only at runtime, so there is no ORM
model to insert against. Every identifier reaching this file has already been
validated against `^[A-Za-z_][A-Za-z0-9_]*$` by `spec.py` and is quoted; every
VALUE is a bound parameter and none is ever formatted into the statement.

Each placeholder carries an explicit `::type` cast. Not decoration: a batch whose
first row has NULL in a column gives the driver no way to infer that parameter's
type, and the insert fails with "could not determine data type of parameter" —
which looks like a bug in the data rather than in the statement.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .spec import PG_TYPE, Projection

log = logging.getLogger("projector.store")


class WriteResult:
    __slots__ = ("rows_attempted", "rows_inserted", "rows_enriched")

    def __init__(self, attempted: int, inserted: int, enriched: int = 0) -> None:
        self.rows_attempted = attempted
        self.rows_inserted = inserted
        # Rows that already existed and gained a value they did not have. Only a
        # projection with `on_conflict: enrich` can produce these; counted apart
        # from inserts so "20 alerts arrived" and "20 alerts were re-stated with
        # a category" never read as the same number.
        self.rows_enriched = enriched

    @property
    def duplicates(self) -> int:
        return max(self.rows_attempted - self.rows_inserted - self.rows_enriched, 0)


def _statement(proj: Projection, n_rows: int) -> str:
    t = proj.target
    cols = [c.name for c in t.columns]
    col_sql = ", ".join(f'"{c}"' for c in cols)
    casts = {c.name: PG_TYPE[c.type] for c in t.columns}
    tuples = []
    for i in range(n_rows):
        tuples.append(
            "(" + ", ".join(f"CAST(:r{i}_{j} AS {casts[c]})" for j, c in enumerate(cols)) + ")"
        )
    conflict = ", ".join(f'"{c}"' for c in t.natural_key)
    if t.on_conflict == "enrich":
        # Pipeline contract §12, "missing never clobbers", as SQL. Every non-key
        # column is COALESCEd against what is already stored, so a message that
        # says nothing about a field leaves it exactly as it was, and a message
        # that DOES carry one fills a column that was NULL because nobody had
        # published it yet.
        #
        # `WHERE` guard: without it every redelivery would rewrite an identical
        # row, tick the continuous-aggregate invalidation trigger, and make
        # `rows_inserted` a lie. `IS DISTINCT FROM` over the whole row is NULL-safe
        # and makes a true no-op cost nothing.
        sets = [
            f'"{c}" = COALESCE(excluded."{c}", "{t.relation}"."{c}")'
            for c in cols
            if c not in t.natural_key
        ]
        if not sets:
            action = "DO NOTHING"
        else:
            changed = " OR ".join(
                f'"{t.relation}"."{c}" IS DISTINCT FROM '
                f'COALESCE(excluded."{c}", "{t.relation}"."{c}")'
                for c in cols
                if c not in t.natural_key
            )
            action = f"DO UPDATE SET {', '.join(sets)} WHERE {changed}"
    else:
        action = "DO NOTHING"
    return (
        f'INSERT INTO "{t.relation}" ({col_sql}) VALUES '
        + ", ".join(tuples)
        + f" ON CONFLICT ({conflict}) {action}"
        # `xmax = 0` is true only for a tuple this statement INSERTed; an UPDATEd
        # one carries the locking transaction's id. Without it `rowcount` would
        # count enriched rows as new ones and the duplicate counter would read
        # zero on a replay that inserted nothing.
        + " RETURNING (xmax = 0) AS inserted"
    )


async def write_batch(session: AsyncSession, proj: Projection, rows: list[dict]) -> WriteResult:
    """Insert one batch of extracted rows in ONE transaction."""
    t = proj.target
    cols = [c.name for c in t.columns]

    # Deduplicate WITHIN the batch, keeping the last occurrence. ON CONFLICT DO
    # NOTHING tolerates a repeated key in one statement, but collapsing it here
    # makes `rows_inserted` honest and shrinks the statement.
    seen: dict[tuple, dict] = {}
    for r in rows:
        seen[tuple(r.get(k) for k in t.natural_key)] = r
    deduped = list(seen.values())
    if not deduped:
        return WriteResult(0, 0)

    params: dict = {}
    for i, row in enumerate(deduped):
        for j, c in enumerate(cols):
            params[f"r{i}_{j}"] = row.get(c)

    result = await session.execute(text(_statement(proj, len(deduped))).bindparams(**params))
    flags = [bool(r[0]) for r in result.fetchall()]
    inserted = sum(1 for f in flags if f)
    enriched = len(flags) - inserted
    await session.commit()
    return WriteResult(len(deduped), inserted, enriched)
