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

from app.vms.audio.router import router as audio_router
from app.vms.bookmarks.router import router as bookmark_router
from app.vms.cameras.router import router as camera_router
from app.vms.dashboard.router import router as dashboard_router
from app.vms.devicemgmt.router import router as devicemgmt_router
from app.vms.evidence.router import router as evidence_router
from app.vms.export.router import router as export_router
from app.vms.groups.router import router as group_router
from app.vms.health.router import router as health_router
from app.vms.linkage.router import router as linkage_router
from app.vms.live.router import router as live_router
from app.vms.live.router import public_router as live_public_router
from app.vms.media_nodes.router import router as media_node_router
from app.vms.motion_search.router import router as motion_search_router
from app.vms.nvr.router import router as nvr_router
from app.vms.onvif_server.router import config_router as onvif_server_router
from app.vms.events.router import router as event_router
from app.vms.patterns.router import router as pattern_router
from app.vms.playback.router import router as playback_router
from app.vms.ptz.router import router as ptz_router
from app.vms.recording.router import router as recording_router
from app.vms.reports.router import router as reports_router
from app.vms.storage import rec_router as storage_rec_router
from app.vms.storage import router as storage_router
from app.vms.videowall.decoder_router import router as decoder_router
from app.vms.videowall.router import router as videowall_router

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
    # Operations / Health dashboard (G2) — /vms/dashboard/summary. Read-only aggregation
    # over existing health/recording/storage/event/nvr data + best-effort nvr /status for
    # node/failover. Distinct literal prefix (no collision with the camera catch-all).
    dashboard_router,
    health_router,
    live_router,
    # Two-way audio (G6) — POST /vms/cameras/{id}/talk/session. Mounts alongside live
    # (its ``/cameras/{id}/talk/session`` path is deeper than the camera catch-all).
    # The talk-session issuer (push-to-talk creds for a backchannel-capable camera).
    audio_router,
    recording_router,
    playback_router,
    export_router,
    reports_router,
    event_router,
    linkage_router,
    storage_router,
    storage_rec_router,
    # Bookmarks (G3) — /vms/bookmarks (+ /{id}). Operator-marked moments/ranges in
    # recorded footage (title/note/tags). Distinct literal prefix (no collision with the
    # camera ``/cameras/{id}`` catch-all). vms.playback.view (read + write).
    bookmark_router,
    # Evidence Lock / Legal Hold (G3) — /vms/evidence (+ /{id}, /{id}/release, /check).
    # A legal hold protecting a camera+time-range from the retention sweep; the retention
    # worker calls app.vms.evidence.service.recording_is_locked to SKIP covered segments.
    # Distinct literal prefix (no camera catch-all collision). Writes vms.recording.control
    # / reads vms.playback.view.
    evidence_router,
    # Forensic Motion Search (G4) — POST /vms/cameras/{id}/motion-search (queue) +
    # GET /vms/motion-search/{job}. Non-AI ffmpeg VMD over recorded segments in drawn
    # region(s) → hit intervals. The MotionSearchWorker (app.main lifespan) does the
    # ffmpeg analysis. POST path is deeper than the camera /cameras/{id} catch-all and
    # /motion-search/{job} is a distinct prefix. vms.playback.view (read + write).
    motion_search_router,
    # PTZ operator control (G1) — /vms/cameras/{id}/ptz/{move|stop|zoom|focus|presets|patrols}.
    # Mounts BEFORE the camera router: its deeper ``/cameras/{id}/ptz/...`` paths must match
    # before the camera ``/cameras/{camera_id}`` catch-all (FastAPI matches in registration
    # order). Distinct from the camera router's ``POST /cameras/{id}/ptz`` single-command
    # endpoint (kept for compatibility). vms.ptz.control (writes) / vms.live.view (reads).
    ptz_router,
    # Device / fleet management (G7) — /vms/cameras/{id}/{device-info|reboot|ntp|password|
    # config-backup|config-restore} + /vms/cameras/bulk/{action}. Mounts BEFORE the camera
    # router: its ``/cameras/{id}/...`` fleet paths are deeper than the camera catch-all,
    # and ``/cameras/bulk/{action}`` must match here (not resolve to get_camera("bulk")).
    # Driver-backed fleet ops (reboot/ntp/password/config backup+restore), graceful per
    # brand. Reads vms.camera.read / writes vms.config.manage.
    devicemgmt_router,
    camera_router,
    group_router,
    pattern_router,
    nvr_router,
    # Media-node registry (MN-1a) — /vms/media-nodes (+ /{id}). Distinct literal prefix
    # (no collision with the camera ``/cameras/{id}`` catch-all). Onboards INDEPENDENT
    # recorder machines (Go-nvr api_url + MediaMTX bases + label); the NodeHeartbeatMonitor
    # (app.main lifespan) keeps their reachability status live. vms.config.manage.
    media_node_router,
    # ONVIF-server config CRUD (P6-C) — /vms/onvif-server/config. Distinct prefix (no
    # collision with the camera catch-all). The SOAP endpoints (/onvif/*) mount at the
    # app root separately in app.main (WS-Security, not JWT).
    onvif_server_router,
    # Video Wall (VW-A) — /vms/walls/*. Distinct prefix (no collision with the camera
    # ``/cameras/{id}`` catch-all). Shared control-room display wall: wall/monitor CRUD +
    # live shared-state (push camera to cell / clear / apply-save preset / start-stop
    # tour). Every state mutation → NATS tenant.<id>.vms.wall.<id>.state → core SSE.
    videowall_router,
    # Video-decoder CRUD (VW-B) — /vms/decoders/*. Distinct prefix (no collision with the
    # camera catch-all). Hardware video-decoder appliances (Hik/Dahua-CP-Plus) the wall
    # pushes camera RTSP to; register/list/update/delete/test (probe). vms.wall.manage.
    decoder_router,
]

# PUBLIC routers — mounted WITHOUT the VMS module/license gate (they authenticate off a
# stateless media token / WS-Security, not a session bearer). Keep this list tiny.
public_routers = [
    live_public_router,  # GET /vms/media/verify — Traefik ForwardAuth hot path
]

__all__ = ["routers", "public_routers"]
