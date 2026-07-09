"""Vision — VMS control-plane service (camera + NVR master, onboarding, drivers).

Boots the FastAPI app on ``kernel`` (config/auth/events/errors), connects the NATS
event bus, and exposes a JWT-verified, tenant-scoped API under the service
api_prefix. It is the Python control-plane half of the VMS; the Go ``nvr`` service
is the data-plane half — the two share this exact JWT + NATS + error contract via
the kernel(s) and interoperate over NATS + REST only (D8).

P1-A is a SCAFFOLD: ``/health`` + ``/api/v1/vms/whoami`` prove config/JWT/tenant
scope/NATS work. Camera/NVR CRUD, ONVIF discovery, drivers and health arrive in
the next modules (the routers just mount here alongside whoami).

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kernel.auth import Principal, Scope, get_principal, get_scope
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import subject

# The onboarding service publishes through the shared VMS event bus
# (``app.vms.common.events``) — one process-wide bus that both startup announcements and
# camera lifecycle/status events ride. The VMS subject namespace is
# ``tenant.<id>.vms.*`` (+ ``device.camera.*`` for the Map / core), shared with the
# Go ``nvr`` service.
from app.db import get_sessionmaker
from app.vms import routers as vms_routers
from app.vms.common.events import bus
from app.vms.events import EventSupervisor
from app.vms.export import ExportWorker
from app.vms.health import HealthSampler
from app.vms.linkage import LinkageConsumer
from app.vms.recording import RecordingConsumer, RecordingScheduler
from app.vms.reports import ReportScheduler
from app.vms.storage import RetentionTieringWorker

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vision")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()
    # Announce startup on the same spine the Python + Go services use.
    await bus.publish(subject(None, "vms", "startup"), {"service": "vision"})
    # Background reachability sampler (all tenants): keeps camera/NVR status live +
    # writes the CameraHealth time-series + auto-purges it. Its own DB session per
    # cycle; bounded concurrency; graceful-on-unreachable (won't crash the app).
    sampler = HealthSampler(get_sessionmaker())
    await sampler.start()
    app.state.health_sampler = sampler

    # P3-A recording: consume the Go nvr's segment events → persist Recording rows,
    # and drive schedule-mode cameras' record windows (start/stop the nvr). Both own
    # their own DB session per message/cycle; graceful when NATS is disabled.
    rec_consumer = RecordingConsumer(bus, get_sessionmaker())
    await rec_consumer.start()
    app.state.recording_consumer = rec_consumer

    rec_scheduler = RecordingScheduler(get_sessionmaker())
    await rec_scheduler.start()
    app.state.recording_scheduler = rec_scheduler

    # P3-B storage: retention + tiering sweep. Deletes recordings past their camera's
    # retention window / over a pool's capacity (NEVER touching locked ones) and moves
    # aged recordings hot→cold per TierRule (local→S3/MinIO). Own DB session per cycle;
    # graceful (unreachable pool / missing file → log + skip).
    storage_worker = RetentionTieringWorker(get_sessionmaker())
    await storage_worker.start()
    app.state.storage_worker = storage_worker

    # P4-B clip export: drain queued ExportJobs → ffmpeg-concat the covered recorded
    # fmp4 segments into a single downloadable mp4 (in the downloads area on the
    # recordings volume). Own DB session per cycle; bounded concurrency; graceful
    # (missing segments / ffmpeg fail → job status=failed, never crashes the loop).
    export_worker = ExportWorker(get_sessionmaker())
    await export_worker.start()
    app.state.export_worker = export_worker

    # P5-A camera device-events: the event-supervisor opens one ONVIF/brand
    # subscription per active ``onvif_events_enabled`` camera (re-scanned on a tick,
    # like the health sampler discovers cameras), normalizes → dedupes → persists a
    # VmsEvent → publishes ``tenant.<id>.vms.camera.<event_type>`` — the exact subject
    # the workflow correlation engine consumes (``tenant.*.vms.>`` → SOP incidents).
    # Bounded concurrency; reconnect/backoff; graceful (a dead camera never stalls
    # others; SDK-missing/unreachable → just no events). Own DB session per event.
    event_supervisor = EventSupervisor(get_sessionmaker())
    await event_supervisor.start()
    app.state.event_supervisor = event_supervisor

    # P5-B event-linkage: subscribe to camera events (``tenant.*.vms.>``) AND access
    # events (``tenant.*.access.>``) → match enabled LinkageRules (event_type + filter +
    # camera scope + schedule + cooldown) → execute actions (start_recording via the Go
    # nvr event-clip, notify via the connector framework, ptz_preset, trigger_output,
    # popup) → write a LinkageFire audit row. An access door event resolves the camera(s)
    # at that door (explicit map or core-placement proximity) for access↔video
    # verification. Durable JetStream consumers; own DB session per event; every action
    # is graceful (a down camera/nvr logs + continues, never crashes the consumer).
    linkage_consumer = LinkageConsumer(bus, get_sessionmaker())
    await linkage_consumer.start()
    app.state.linkage_consumer = linkage_consumer

    # P6-B operational reporting: the report scheduler fires each ENABLED ReportSchedule
    # on its cadence — computes the report (uptime/coverage/storage/event-stats) in that
    # schedule's tenant scope, renders it (CSV/PDF/JSON), and publishes
    # ``tenant.<id>.notify.request`` for the workflow/notifier connector to fan out. Own
    # DB session per cycle; graceful (a bad schedule records last_error + advances).
    report_scheduler = ReportScheduler(get_sessionmaker())
    await report_scheduler.start()
    app.state.report_scheduler = report_scheduler

    yield

    await report_scheduler.stop()
    await event_supervisor.stop()
    await export_worker.stop()
    await storage_worker.stop()
    await rec_scheduler.stop()
    await sampler.stop()
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Vision (VMS control-plane)", lifespan=lifespan)
    register_error_handlers(app)

    # CORS — the operator UI may call this satellite directly (dev :3000) instead
    # of through the gateway. Mirror core's policy (shared kernel settings).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "vision", "env": settings.env}

    # Sample authed route — proves JWT verification + tenant scope work locally
    # (a core-minted token verifies here identically to the Go nvr service).
    @app.get(f"{settings.api_prefix}/vms/whoami")
    async def whoami(
        principal: Principal = Depends(get_principal),
        scope: Scope = Depends(get_scope),
    ) -> dict:
        return {
            "user_id": str(principal.user_id),
            "tenant_id": str(principal.tenant_id) if principal.tenant_id else None,
            "is_superadmin": principal.is_superadmin,
            "permissions": principal.permissions,
            "is_platform": scope.is_platform,
            "service": "vision",
        }

    # VMS REST routers (P1-D: camera onboarding — CRUD, ONVIF discovery/probe/
    # channels/bulk-add/snapshot, config sub-resources, groups + ACL). NVR
    # onboarding mounts alongside in P1-E.
    for r in vms_routers:
        app.include_router(r, prefix=settings.api_prefix)

    return app


app = create_app()
