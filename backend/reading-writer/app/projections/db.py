"""A SECOND connection pool onto the same database, and why one would not do.

THE FAILURE THIS PREVENTS
-------------------------
Folding the projector into the reading-writer put both consumers in one process.
Everything that kept them from blocking each other before is still here and still
separate — their own NATS connections, their own durables, their own asyncio
tasks, their own bounded queues — except one thing that was invisible while they
were two processes: the connection pool.

`reporting.db.database` is a single lazily-built engine with SQLAlchemy's default
pool (5 + 10 overflow). Sharing it would mean a projection holding connections —
a lock wait on `access_events`, a `CREATE MATERIALIZED VIEW` in `ensure`, a
Postgres slow enough that batches pile up across several projections — could take
every connection in it. The readings write loop would then block in
`sessionmaker()`'s CHECKOUT, before any statement is issued, which is the worst
place for it to block: no `statement_timeout` covers a checkout, `db_healthy` is
never flipped because nothing failed, and the stall watchdog is not armed either
because `begin_write` has not run yet. Readings stop landing and the reason is a
projection. That is precisely the failure the two-process split was buying, and
it is the only one of the four the merge did not inherit for free.

So this package gets its OWN engine on the SAME database. Two pools, two owners,
one store — the same sentence the ownership split has always been, one layer
down. A projection can exhaust every connection in `projections_db` and the
readings pool is untouched, because they share nothing but a Postgres server that
is sized for far more than either.

THE NUMBERS
-----------
`VE_PROJECTOR_POOL_SIZE` (4) + `VE_PROJECTOR_POOL_OVERFLOW` (4). The ceiling is
what matters, not the floor: the concurrent DB users in this package are one
write loop per projection (two today), the registry reload, the health prober and
`ensure`'s AUTOCOMMIT connection during a reload. Eight is comfortably above that
and small enough that the two pools plus the BI query API stay well inside
Postgres's `max_connections` even at several replicas.

NOT DONE, DELIBERATELY: the readings side keeps SQLAlchemy's default pool. Pinning
a number there would be a change to the hot path made for the convenience of this
file, and the property being protected does not need it — it needs the two pools
to be DIFFERENT, not for either to be a particular size.
"""

from __future__ import annotations

import os

from kernel.config import get_settings
from kernel.db import Database


def _int(name: str, default: int) -> int:
    try:
        return int((os.getenv(name) or "").strip() or default)
    except ValueError:
        return default


projections_db = Database(
    get_settings().database_url,
    pool_size=_int("VE_PROJECTOR_POOL_SIZE", 4),
    max_overflow=_int("VE_PROJECTOR_POOL_OVERFLOW", 4),
)
