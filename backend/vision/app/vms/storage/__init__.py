"""VMS recording-integrity domain — checksum/lock/verify only.

The storage DATA-PLANE (StoragePool/TierRule CRUD, per-pool usage, RAID
monitoring, the retention+tiering sweep) is owned by the standalone NVR and has
been retired from this VMS. What remains is the recording-integrity surface:

  * ``rec_router`` — ``/vms/recordings/{id}/lock|unlock|verify``.
  * ``StorageService`` — default-pool bootstrap (stamps ``storage_pool_id`` at
    finalize) + recording lock/verify.
  * ``compute_integrity`` — shared checksum helper reused by the recording
    consumer (checksum-on-finalize) + the verify endpoint.
"""

from __future__ import annotations

from .router import rec_router
from .service import StorageService, compute_integrity

__all__ = [
    "rec_router",
    "StorageService",
    "compute_integrity",
]
