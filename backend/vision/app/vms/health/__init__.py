"""VMS health domain — camera/NVR reachability monitoring.

Self-contained domain package (``schemas`` + ``service`` + ``router``), mirroring
``cameras`` / ``nvr``:

  * ``HealthService`` — tenant-scoped health reads (latest-per-camera, history) +
    on-demand single-camera re-check.
  * ``HealthSampler`` — estate-wide background reachability loop + auto-purge; started
    in ``app.main`` lifespan. Bounded concurrency; graceful-on-unreachable.
  * ``router`` — ``GET /cameras/health``, ``GET /cameras/{id}/health/history``,
    ``POST /cameras/{id}/health/refresh`` (gated ``vms.camera.read``).

Rich stream metrics (bitrate/fps/packet-loss/latency) are deferred to P2 (Go ``nvr`` +
MediaMTX); P1 fills ``status`` + reachability only.
"""

from __future__ import annotations

from .router import router
from .service import HealthSampler, HealthService

__all__ = ["router", "HealthService", "HealthSampler"]
