"""The ONE statement that carries a role across a recorded succession.

It lives in the `reporting` package, beside `placement.py`, for exactly the same
reason and with exactly the same shape: it has TWO callers and they must never
disagree about what a succession MEANS.

* the **repoint API** (`reading-writer`'s `app/api/succession.py`) runs it in the
  same transaction that writes `points.superseded_by`, so the operator's move
  takes effect immediately and through this statement rather than through a
  second, subtly different INSERT;
* the **writer** (`reading-writer`'s `app/store.py`) runs it over the points it
  just upserted, so a point a succession already NAMES inherits the role when it
  comes into existence or starts reporting, instead of making a human repeat the
  binding after the next gateway rebuild.

WHAT A SUCCESSION IS, AND WHY THIS IS NOT INFERENCE
---------------------------------------------------
`points.superseded_by` (0024) is written by exactly two things, and both of them
are a HUMAN's statement about identity:

* `POST /bi/points/ghosts/collapse` — an operator collapsed a duplicated
  `(device_tag, point_tag)` onto a survivor they chose or confirmed;
* `POST /bi/points/roles/repoint` — an operator named the point that replaced a
  renamed one.

So this statement reads a recorded decision and applies it. It parses no tag, it
scores nothing, it has no threshold, and it cannot reach a pair of points that
nobody ever connected. That is the same line `placement.py` draws: the writer
calls it, but every value it writes came from something an operator asserted.

WHAT IT MAY AND MAY NOT DO
--------------------------
**It never overwrites a role.** The heir must carry NO role for anything to
happen (`NOT EXISTS`, and the `ON CONFLICT DO NOTHING` behind it for the race).
`point_roles` is keyed by `point_id` alone, so a heir that already carries a role
is an operator's own assertion about the point that replaced the old one, and an
older generation's binding may not speak over it. The donor keeps its row in that
case — the role is not silently discarded, it simply has not moved, and the
repoint API reports that as a conflict.

**It MOVES, it does not copy.** One physical measurement must not be bound twice:
two live points carrying `inlet_water_temp` on one chiller would make every
metric that selects the role ambiguous, and nothing downstream could tell which
number it got. The insert and the delete are one statement for that reason.

**It carries the assertion verbatim.** `role_source`, `confirmed_by` and
`confirmed_at` are copied unchanged — this is the SAME assertion moved onto the
row that now carries the measurement, not a new one made by the platform, and a
`confirmed_by` rewritten to "system" would erase who actually decided it. Ghost
collapse's `_MIGRATE_ROLE_SQL` copies the same four columns for the same reason.

**It is idempotent and cheap in the steady state.** In the ordinary case the heir
already has its role (or there is no succession naming it at all) and the CTE
selects nothing, so a run over a 500-point batch costs one indexed lookup on
`ix_points_superseded_by` and writes nothing. That is what makes it safe on the
hot write path.

HOW OFTEN THE WRITER PATH ACTUALLY FIRES — SAID PLAINLY
--------------------------------------------------------
Rarely, and that is not an argument against it. Both routes that record a
succession today also call this statement in the same transaction, so by the time
the writer sees the heir the role is normally already there and the guard is a
no-op. The writer path is what covers the orderings those two routes cannot:
a succession recorded while the heir carried a conflicting role that an operator
later cleared, a `superseded_by` written by a future importer or by hand, and the
heir that has a `points` row but has not reported since (`/bi/intake`'s
`awaiting_first_reading`). Without it, a recorded succession would be a note the
system does not act on — and a note nothing reads is one that drifts until
somebody trusts it.

DELIBERATELY NOT DONE: INHERITING BY TAG
----------------------------------------
The case this does NOT cover is the second rebuild: the heir dies in its turn and
the gateway mints a THIRD id under the same `(device_tag, point_tag)`. Nothing
points at that new row, so nothing here reaches it and an operator repoints
again.

Making it reach would mean treating "same device tag, same point tag" as
sufficient to move a role — which is binding the meaning of a number to a naming
convention, the exact fabrication `app/api/units.py` and
`app/metric_registry/roles.py` both refuse (and pipeline contract §17 records for
floor prefixes). A duplicated `(device_tag, point_tag)` already has a home: ghost
collapse groups on precisely that pair and migrates the role with an operator's
confirmation. The rename case is what has no home, and the answer to it is the
repoint proposal — a human confirming a scored candidate — not a rule.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# One statement, three data-modifying CTEs, one snapshot.
#
# `donor` picks, for each heir in scope, the role to carry. DISTINCT ON with the
# newest `confirmed_at` first settles the case where SEVERAL superseded points
# name the same heir and more than one of them still carries a role: at most one
# can land (`point_roles` is keyed by point alone), and the most recent human
# statement is the better one to keep. Ghost collapse's `_MIGRATE_ROLE_SQL` makes
# the identical choice with `ORDER BY r.confirmed_at DESC LIMIT 1`; the two must
# not disagree about which assertion wins.
#
# The tenant isolation is in the JOIN — `g.tenant_id = heir.tenant_id` — not only
# in the optional `:tenant` bind, for the same reason `placement.py` says so out
# loud: the writer calls this with the points of one BATCH, and a batch routinely
# spans tenants, so there is no single tenant it could name.
#
# `placed` is the insert, and its RETURNING is what makes the delete honest: only
# a donor whose role ACTUALLY landed on the heir loses its row. If the insert
# hits the conflict (a role appeared on the heir between the CTE's snapshot and
# the write), nothing is deleted and the donor keeps its binding.
_INHERIT_SQL = text(
    """
    WITH donor AS (
        SELECT DISTINCT ON (heir.point_id)
               heir.point_id  AS heir_id,
               r.point_id     AS donor_id,
               heir.tenant_id AS tenant_id,
               r.role, r.role_source, r.confirmed_by, r.confirmed_at
          FROM points heir
          JOIN points g
            ON g.superseded_by = heir.point_id
           AND g.tenant_id = heir.tenant_id
          JOIN point_roles r
            ON r.point_id = g.point_id
         WHERE (CAST(:tenant AS uuid) IS NULL OR heir.tenant_id = CAST(:tenant AS uuid))
           AND (CAST(:point_ids AS uuid[]) IS NULL
                OR heir.point_id = ANY(CAST(:point_ids AS uuid[])))
           -- The whole of the no-overwrite rule. A heir that already carries a
           -- role is an operator's own statement about the point that replaced
           -- the old one, and an older generation may not speak over it.
           AND NOT EXISTS (
               SELECT 1 FROM point_roles h WHERE h.point_id = heir.point_id
           )
         ORDER BY heir.point_id, r.confirmed_at DESC
    ),
    placed AS (
        INSERT INTO point_roles
            (point_id, tenant_id, role, role_source, confirmed_by, confirmed_at)
        SELECT d.heir_id, d.tenant_id, d.role, d.role_source,
               d.confirmed_by, d.confirmed_at
          FROM donor d
        ON CONFLICT (point_id) DO NOTHING
        RETURNING point_id
    )
    DELETE FROM point_roles r
     USING donor d, placed pl
     WHERE r.point_id = d.donor_id
       AND pl.point_id = d.heir_id
    RETURNING r.point_id AS donor_id, d.heir_id, d.role
    """
)


def _arr(values: Sequence[uuid.UUID] | None) -> list[str] | None:
    if values is None:
        return None
    return [str(v) for v in values]


async def inherit_roles(
    session: AsyncSession,
    tenant: uuid.UUID | None = None,
    *,
    point_ids: Sequence[uuid.UUID] | None = None,
) -> list[dict]:
    """Carry each named heir's role across the succession that named it.

    Returns one row per role that MOVED — `{donor_id, heir_id, role}` — so a
    caller can report the move rather than assume it. An empty list is the
    ordinary answer and is not an error: it means every heir in scope either has
    its own role already or is not named by any succession.

    Does NOT commit. It runs inside the caller's transaction, which is what makes
    the writer's "nothing is acked until it is durably written" guarantee cover
    this too, and what lets the repoint API roll the whole move back if the role
    will not land.

    `point_ids` is the scope and it is effectively mandatory: passing None means
    "every heir in the tenant", which is a legitimate repair operation but must
    never happen on the write path, where it would turn a 500-row batch into a
    full scan of the dimension table. Both callers pass an explicit list.

    `tenant` IS NOT WHAT KEEPS TENANTS APART — the join is (see the SQL above).
    It is a narrowing for the API path, which knows one tenant; the writer path
    cannot name one, because a batch is whatever came off
    `tenant.*.iot.reading.>` and that is several tenants at a time.
    """
    if point_ids is not None and not point_ids:
        return []
    result = await session.execute(
        _INHERIT_SQL,
        {
            "tenant": str(tenant) if tenant else None,
            "point_ids": _arr(point_ids),
        },
    )
    return [dict(r) for r in result.mappings().all()]
