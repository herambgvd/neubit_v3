"""VMS control-plane package — enterprise domain-folder layout.

Each domain package is self-contained (``schemas`` + ``service`` + ``router``):

  * ``cameras`` — camera CRUD, ONVIF discovery/probe/channels/bulk-add/snapshot,
    config sub-resources, media profiles. The base domain (nvr + groups depend on it).
  * ``nvr``     — NVR CRUD, discovery, channel enumeration + map-channels (reuses
    ``cameras.service.CameraService.bulk_add``), health/refresh.
  * ``groups``  — camera-group catalog + per-camera ACL.

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
from app.vms.nvr.router import router as nvr_router

# Order preserves the pre-refactor mount order (cameras first, then nvr); groups was
# formerly part of the camera router export, so it follows cameras here too.
routers = [camera_router, group_router, nvr_router]

__all__ = ["routers"]
