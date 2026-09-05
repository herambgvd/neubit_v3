"""The projection consumers — the only writer of the relations in `reporting_projections`.

WHAT THIS IS
------------
The one legal way a domain's data gets into `neubit_reporting`. The platform bans
services from reading each other's databases, and the reporting store is the
documented exception *for querying* — not a licence to reach into
`neubit_access`. So a domain PUBLISHES on the NATS spine and this consumes the
spine and writes the reporting store. It opens `neubit_reporting` and never
another database.

THE BOUNDARY IS STILL TWO OWNERS. THE PROCESS IS NOW ONE.
---------------------------------------------------------
Until 2026-09-05 this was `backend/projector`, its own container, and its
`main.py` argued it was "deliberately a sibling of reading-writer rather than
part of it ... two consumers, two ownership boundaries, one store." The argument
was about OWNERSHIP OF RELATIONS and it still holds exactly as written:

    reading-writer's `app/`            → the readings schema. `readings`,
                                         `points`, their rollups. Nothing here
                                         writes them.
    reading-writer's `app/projections` → every relation declared in
                                         `reporting_projections`. Nothing there
                                         writes them.

That is a code boundary, and a code boundary does not need a second process to
exist. What the second process cost was a container, a compose block, a build and
an image for 2,520 lines that had no public surface and no independent scaling
need. What it bought was one property worth keeping — a projection backlog can
never stall reading ingestion — and that property is now held by construction
rather than by process separation. See `app/main.py` for how, and `db.py` here
for the one part of it the merge actually exposed.

STILL NO TENANT API
-------------------
There is no `/api/...` in this package and there must not be one. Everything the
builder reads it reads through `app/api`'s `/api/v1/bi/...`, against datasets
these consumers registered. A second query path over the same store is exactly
the drift the pipeline contract warns about (§8 rule 2) — and the fact that the
query path now lives in the same process makes reaching for one EASIER, not more
acceptable. The reads in this package are the registry SELECT (`registry.py`) and
the introspection `ensure.py` needs to converge DDL. Nothing else reads.
"""

from __future__ import annotations

from .config import ProjectorConfig
from .dlq_watch import DlqWatch, DlqWatchStats
from .metrics import Metrics as ProjectorMetrics
from .pipeline import Projector

__all__ = [
    "DlqWatch",
    "DlqWatchStats",
    "Projector",
    "ProjectorConfig",
    "ProjectorMetrics",
]
