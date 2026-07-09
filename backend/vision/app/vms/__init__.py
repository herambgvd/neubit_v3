"""VMS control-plane package — enterprise domain-folder layout.

Each domain package is self-contained (``schemas`` + ``service`` + ``router``):

  * ``cameras`` — camera CRUD, ONVIF discovery/probe/channels/bulk-add/snapshot,
    config sub-resources, media profiles. The base domain (nvr + groups depend on it).
  * ``nvr``     — NVR CRUD, discovery, channel enumeration + map-channels (reuses
    ``cameras.service.CameraService.bulk_add``), health/refresh.
  * ``groups``  — camera-group catalog + per-camera ACL.
  * ``health``  — camera-health reads (latest/history/refresh) + the background
    reachability sampler (``HealthSampler``, started in ``app.main`` lifespan).

Shared building blocks live in ``common`` (``crypto``, ``events``, cross-domain
``schemas``). Centralised ORM stays in ``models`` (FK-heavy + single migration
metadata); the multi-brand driver seam stays in ``drivers``.

``routers`` is the aggregate ``app.main`` mounts under the service api_prefix — the
domain routers all share the ``/vms`` prefix, so the mounted paths are unchanged from
the pre-refactor flat layout.
"""

from __future__ import annotations

from app.vms.cameras.router import router as camera_router
from app.vms.groups.router import router as group_router
from app.vms.health.router import router as health_router
from app.vms.live.router import router as live_router
from app.vms.nvr.router import router as nvr_router
from app.vms.recording.router import router as recording_router
from app.vms.storage import rec_router as storage_rec_router
from app.vms.storage import router as storage_router

# Health mounts FIRST: its literal ``/cameras/health`` + ``/cameras/{id}/health/*``
# paths must be matched before the camera router's ``/cameras/{camera_id}`` catch-all
# (FastAPI matches in registration order — otherwise ``/cameras/health`` resolves to
# ``get_camera("health")`` → 404). Cameras then nvr preserve the pre-refactor order;
# groups follows cameras (it was formerly part of the camera router export).
# Live mounts after health (its literal ``/media/verify`` + ``/cameras/{id}/live``
# deeper paths are distinct from the camera catch-all, but keeping it high preserves
# match clarity) and before cameras — the P2-B streaming control plane. Recording
# mounts alongside live (its ``/cameras/{id}/recording*`` + ``/recordings/{id}`` are
# deeper/distinct from the camera catch-all) — the P3-A recording control plane.
# Storage mounts alongside recording — its ``/vms/storage/*`` prefix is distinct, and
# its ``/vms/recordings/{id}/lock|unlock|verify`` (POST) don't collide with the
# recording router's ``/vms/recordings/{id}`` (GET). The P3-B storage control plane.
routers = [
    health_router,
    live_router,
    recording_router,
    storage_router,
    storage_rec_router,
    camera_router,
    group_router,
    nvr_router,
]

__all__ = ["routers"]
