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
from app.vms.export.router import router as export_router
from app.vms.groups.router import router as group_router
from app.vms.health.router import router as health_router
from app.vms.linkage.router import router as linkage_router
from app.vms.live.router import router as live_router
from app.vms.nvr.router import router as nvr_router
from app.vms.events.router import router as event_router
from app.vms.patterns.router import router as pattern_router
from app.vms.playback.router import router as playback_router
from app.vms.recording.router import router as recording_router
from app.vms.reports.router import router as reports_router
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
# Playback mounts alongside live/recording — its ``/vms/cameras/{id}/playback`` +
# ``/vms/cameras/{id}/timeline`` paths are deeper than the camera ``/cameras/{id}``
# catch-all, and distinct from the recording router's paths. The P4-A recorded-
# playback control plane (recorded PlaybackSession + scrub-bar timeline).
# Export mounts alongside playback — its ``/vms/cameras/{id}/export`` (POST) +
# ``/vms/export/{job}`` + ``/vms/export/{job}/download`` are deeper/distinct from the
# camera ``/cameras/{id}`` catch-all. The P4-B clip-export control plane (queue a job;
# the ExportWorker ffmpeg-concats the covered recorded segments → a downloadable mp4).
# Events mounts alongside export — its ``/vms/events`` + ``/vms/cameras/{id}/events``
# (GET) + ``/vms/events/{id}/ack`` (POST) are deeper/distinct from the camera
# ``/cameras/{id}`` catch-all. The P5-A camera device-events feed (the event-supervisor
# ingests device/system events → NATS → workflow correlation → incidents).
# Linkage mounts alongside events — its ``/vms/linkage-rules`` (+ ``/{id}``) +
# ``/vms/linkage-fires`` are distinct prefixes (no collision with the camera catch-all).
# The P5-B event-linkage control plane (event→action rules + the fire-audit; the linkage
# consumer, wired in app.main, runs the rules on camera + access events).
# Reports mounts alongside export — its ``/vms/reports/{kind}`` + ``/vms/report-schedules``
# are distinct prefixes (no collision with the camera ``/cameras/{id}`` catch-all). The
# P6-B operational-reporting control plane (uptime/coverage/storage/event reports + the
# ReportScheduler that fires recurring reports via the notify path).
routers = [
    health_router,
    live_router,
    recording_router,
    playback_router,
    export_router,
    reports_router,
    event_router,
    linkage_router,
    storage_router,
    storage_rec_router,
    camera_router,
    group_router,
    pattern_router,
    nvr_router,
]

__all__ = ["routers"]
