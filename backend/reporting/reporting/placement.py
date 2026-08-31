"""The ONE statement that derives `points`' spatial columns from `device_locations`.

It lives in the `reporting` package rather than in either caller because it has
TWO callers and they must never disagree:

* the **placement API** (`reading-writer`'s `app/api/placement.py`) runs it after
  writing or clearing a `device_locations` row, so the change is visible to
  `/bi/summary` and `/bi/query` in the same transaction that made it;
* the **writer** (`reading-writer`'s `app/store.py`) runs it over the points it
  just upserted, so a point that reports for the FIRST TIME inherits the
  placement its device already has.

That second caller is the only reason this is not a one-off UPDATE inside the
API. The writer creates a `points` row the moment an unknown `point_id` reports
(pipeline contract §6), and without the reconcile a placed estate would silently
un-place itself one new point at a time, with nothing saying so.

WHAT IT MAY AND MAY NOT DO
--------------------------
**It never invents.** Its only source is `device_locations`, one row per device,
written only by an operator through the placement API. There is no tag parsing,
no inheritance from a sibling device, no "nearest floor". A device with no row
has its points' placement set to NULL — unplaced — which is a statement, not a
gap to be filled.

**It never overwrites an explicit point-level placement.** A row with
`placement_source = 'point'` is an operator saying that THIS point is not where
its device is; recomputing it would quietly discard that. The WHERE clause
excludes it, and that exclusion is the whole of the override mechanism.

**It is idempotent and cheap in the steady state.** The `IS DISTINCT FROM` guard
means a run over points that already agree with their device updates zero rows,
which is what makes it safe to call on the hot write path.

**It is not a no-clobber exception.** Pipeline contract §11's rule is that a
MESSAGE must not overwrite an operator's statement. Nothing here reads a message:
the writer calls it, but every value it writes came from `device_locations`. A
reading can still neither carry a placement nor move one.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# One statement, two shapes of scope, and both are always bounded:
#
#   :point_ids   the writer's path — exactly the points it upserted in this batch
#   :device_ids  the API's path — every point of the devices whose placement changed
#
# A NULL array means "not scoped by this", and at least one must be given; the
# callers below enforce that. An unbounded rewrite of the whole dimension table
# is deliberately not reachable from here.
_RECONCILE_SQL = text(
    """
    UPDATE points p
       SET site_id    = d.site_id,
           site_name  = d.site_name,
           floor_id   = d.floor_id,
           floor_name = d.floor_name,
           zone_id    = d.zone_id,
           zone_name  = d.zone_name,
           -- 'device' when a placement was applied, NULL when there is none to
           -- apply. NULL and unplaced are the same state and are stored as the
           -- same thing: a marker on a row with no placement would be a claim
           -- about nothing.
           placement_source = CASE WHEN d.device_id IS NULL THEN NULL ELSE 'device' END
      FROM points src
      LEFT JOIN device_locations d
             ON d.tenant_id = src.tenant_id
            AND d.device_id = src.device_id
     WHERE p.point_id = src.point_id
       AND (CAST(:tenant AS uuid) IS NULL OR src.tenant_id = CAST(:tenant AS uuid))
       AND (CAST(:point_ids AS uuid[]) IS NULL OR src.point_id = ANY(CAST(:point_ids AS uuid[])))
       AND (CAST(:device_ids AS uuid[]) IS NULL OR src.device_id = ANY(CAST(:device_ids AS uuid[])))
       -- The override. An operator placed THIS point; the device's placement is
       -- not allowed to speak over it.
       AND coalesce(p.placement_source, '') <> 'point'
       -- Idempotence: in the steady state this matches nothing and the statement
       -- costs an index scan and no writes.
       AND (p.site_id,  p.site_name,  p.floor_id, p.floor_name, p.zone_id, p.zone_name)
           IS DISTINCT FROM
           (d.site_id,  d.site_name,  d.floor_id, d.floor_name, d.zone_id, d.zone_name)
    """
)


def _arr(values: Sequence[uuid.UUID] | None) -> list[str] | None:
    if values is None:
        return None
    return [str(v) for v in values]


async def reconcile_placement(
    session: AsyncSession,
    tenant: uuid.UUID | None = None,
    *,
    point_ids: Sequence[uuid.UUID] | None = None,
    device_ids: Sequence[uuid.UUID] | None = None,
) -> int:
    """Bring `points`' spatial columns into line with `device_locations`.

    Returns the number of point rows changed. Does NOT commit — it is meant to
    run inside the caller's transaction, which is what makes the writer's
    "nothing is acked until it is durably written" guarantee cover this too.

    Scope is mandatory: pass `point_ids` or `device_ids` (or both). Reconciling
    an entire tenant is a legitimate operation but it is not this function's job,
    because on the write path it would turn a 500-row batch into a 314-row table
    rewrite.
    """
    if point_ids is None and device_ids is None:
        raise ValueError("reconcile_placement needs point_ids or device_ids")
    if point_ids is not None and not point_ids:
        return 0
    if device_ids is not None and not device_ids:
        return 0
    result = await session.execute(
        _RECONCILE_SQL,
        {
            "tenant": str(tenant) if tenant else None,
            "point_ids": _arr(point_ids),
            "device_ids": _arr(device_ids),
        },
    )
    return result.rowcount or 0
