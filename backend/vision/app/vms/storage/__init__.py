"""VMS storage domain (P3-B) — where recordings live + how long + tier + integrity.

Self-contained ``schemas`` + ``service`` + ``router`` (StoragePool + TierRule CRUD,
pool usage, recording integrity/lock/verify), plus one background collaborator
started in ``app.main`` lifespan:

  * ``RetentionTieringWorker`` — periodic estate-wide sweep: age + capacity retention
    (deletes, NEVER touching locked recordings) and TierRule-driven hot→cold tiering
    (local→S3/MinIO, verify, re-point). Graceful: unreachable pool / missing file →
    log + skip, never crashes.

Two routers are exported: ``router`` (``/vms/storage/*``) and ``rec_router``
(``/vms/recordings/{id}/lock|unlock|verify``) — both share the ``/vms`` mount.

Shared helpers (``compute_integrity``, S3 path scheme) live in ``service`` and are
reused by the recording consumer (checksum-on-finalize) + the worker.
"""

from __future__ import annotations

from .router import rec_router, router
from .raid_monitor import RaidMonitor
from .service import StorageService, compute_integrity
from .worker import RetentionTieringWorker

__all__ = [
    "router",
    "rec_router",
    "StorageService",
    "compute_integrity",
    "RetentionTieringWorker",
    "RaidMonitor",
]
