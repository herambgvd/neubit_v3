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

from kernel.auth import (
    Principal,
    Scope,
    get_principal,
    get_scope,
    require_active_license,
    require_feature,
)
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
from app.vms import public_routers as vms_public_routers
from app.vms.common.events import bus
from app.vms.events import EventSupervisor
from app.vms.health import HealthSampler
from app.vms.linkage import LinkageConsumer
from app.vms.media_nodes import NodeHeartbeatMonitor
from app.vms.recording import RecordingConsumer
from app.vms.reports import ReportScheduler
# NOTE: storage retention/tiering + RAID monitoring are owned by the NVR, not this
# VMS — their workers (RetentionTieringWorker, RaidMonitor) are intentionally NOT run.

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vision")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()
    # Announce startup on the same spine the Python + Go services use.
    await bus.publish(subject(None, "vms", "startup"), {"service": "vision"})
    # DPDP right-to-erase: wipe this service's rows for a tenant core offboards.
    from kernel.lifecycle import subscribe_tenant_offboard, subscribe_tenant_provisioned

    from app.db import database

    await subscribe_tenant_provisioned(bus, database, durable="vision-provision")
    await subscribe_tenant_offboard(bus, database, durable="vision-offboard")
    # Background reachability sampler (all tenants): keeps camera/NVR status live +
    # writes the CameraHealth time-series + auto-purges it. Its own DB session per
    # cycle; bounded concurrency; graceful-on-unreachable (won't crash the app).
    sampler = HealthSampler(get_sessionmaker())
    await sampler.start()
    app.state.health_sampler = sampler

    # MN-1a media-node heartbeat: ping each registered recorder machine's Go-nvr
    # ``/api/v1/nvr/status`` on a cadence → refresh its ``status`` + ``last_heartbeat``
    # (+ ``used_channels`` when self-reported). Its own DB session per cycle; bounded
    # concurrency; graceful-on-unreachable (a down node → offline, never crashes the app;
    # a ``draining`` node is left as the operator set it).
    node_heartbeat = NodeHeartbeatMonitor(get_sessionmaker())
    await node_heartbeat.start()
    app.state.node_heartbeat = node_heartbeat

    # P3-A recording: consume the Go nvr's segment events → persist Recording rows,
    # and drive schedule-mode cameras' record windows (start/stop the nvr). Both own
    # their own DB session per message/cycle; graceful when NATS is disabled.
    rec_consumer = RecordingConsumer(bus, get_sessionmaker())
    await rec_consumer.start()
    app.state.recording_consumer = rec_consumer


    # Storage/retention/tiering + RAID health are OWNED BY THE NVR (the recorder
    # data-plane that actually writes segments and sits on the disks). This VMS
    # delegates recording to the NVR (VE_NVR_URL) and must NOT independently sweep,
    # delete, tier or monitor the same /recordings volume — two movers on the same
    # files is a data-loss race. So the RetentionTieringWorker + RaidMonitor are NOT
    # started here (removed); the shared integrity helper stays for checksum-on-finalize.

    # No clip-export worker here any more. An export is cut from the SEGMENTS, and
    # the recorder that wrote them is the only box that can read them, hash the
    # result and sign a chain-of-custody manifest with its own key. The VMS running
    # its own ffmpeg over the same /recordings volume made it a second writer on
    # files the recorder owns, and produced clips nothing could attest to. The
    # console now asks the owning recorder (/vms/federation/…/exports).

    # No forensic motion-search worker here either, for the same reason as export: the
    # search DECODES the recorded segments, and they live on the recorder's disk. The
    # recorder also bounds its own search and reports what it managed to examine — a
    # queue here could not, and an incomplete search that says nothing is read as
    # "the footage is clear". The console asks the owning recorder
    # (/vms/federation/…/motion-search).

    # P5-A camera device-events: the event-supervisor polls each registered
    # RECORDER's own event ledger on a tick, normalizes → dedupes → persists a
    # VmsEvent → publishes ``tenant.<id>.vms.camera.<event_type>`` — the exact subject
    # the workflow correlation engine consumes (``tenant.*.vms.>`` → SOP incidents).
    #
    # It used to open its own ONVIF PullPoint subscription per camera. The recorder
    # that owns the camera already runs one, and many cameras permit exactly one — so
    # the two competed, and the loser got silence rather than an error. Reading the
    # recorder's ledger also means the estate sees the same events the recorder
    # itself acted on.
    #
    # Bounded concurrency; graceful (an unreachable recorder never stalls the others
    # and its watermark is not advanced, so nothing is skipped when it returns).
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

    # No ANR fulfiller here any more. The recorder detects its own recording gaps
    # AND fills them now (nvr internal/anr + estate.BackfillGap): it holds the camera
    # credentials, it speaks ONVIF Profile-G, and it owns the disk the pulled segment
    # lands on. This service was reaching across the network to write into another
    # box's recordings volume, which made it a third writer there alongside the
    # recorder's own segment writer and its retention janitor.

    # No PTZ patrol cycler here any more. Patrols are HOST-DRIVEN by the recorder
    # that owns the camera — it steps the head preset by preset and survives its own
    # restarts. The VMS ran a second cycler against its own preset table, so two
    # processes could drive the same head from two different stop lists.

    yield

    await report_scheduler.stop()
    await event_supervisor.stop()
    await node_heartbeat.stop()
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
        """Liveness only — never touches a dependency. See app/probes.py."""
        return {"status": "ok", "service": "vision", "env": settings.env}

    @app.get("/readyz")
    async def ready():
        """Readiness: 503 naming the dependency that failed.

        There was none until now, so an orchestrator watching /health could not
        tell this service from one whose database had gone — on the service
        holding every camera, recording and evidence lock.
        """
        from app.probes import readyz

        return await readyz()

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
    # Every VMS route is gated by the tenant's "vms" module + an unexpired license
    # (super-admins bypass both). Module off → 403 FEATURE_DISABLED; past-grace
    # license → 403 LICENSE_EXPIRED.
    vms_gate = [Depends(require_feature("vms")), Depends(require_active_license())]
    for r in vms_routers:
        app.include_router(r, prefix=settings.api_prefix, dependencies=vms_gate)

    # PUBLIC media routes — NOT gated (no bearer / module / license). The Traefik
    # ForwardAuth media hot path (GET /vms/media/verify) authorizes off the stateless
    # media token, so it must stay reachable for HLS/WebRTC even without a session JWT.
    for r in vms_public_routers:
        app.include_router(r, prefix=settings.api_prefix)

    return app


app = create_app()
