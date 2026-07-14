"""Operations / Health dashboard domain (G2) — read-only aggregation.

A single ``GET /api/v1/vms/dashboard/summary`` endpoint that rolls up EXISTING
vision data (camera health, recording status, storage pools, device/system events,
NVRs) plus a best-effort call to the Go ``nvr`` data-plane for media-node / failover
health, into one JSON the live VMS ops dashboard (G2-frontend) renders.

NO new DB model / migration — every field reads from a table another phase already
owns. Mirrors the ``health`` / ``reports`` read-only domains (schemas + service +
router, tenant-scoped, permission-gated).
"""

from __future__ import annotations

from app.vms.dashboard.router import router

__all__ = ["router"]
