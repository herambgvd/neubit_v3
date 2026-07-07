# neubit_v3 Roadmap — neubit_v2 → neubit_v3 (loosely-coupled, service-by-service)

neubit_v3 = the **upgraded, multi-tenant, loosely-coupled** successor to neubit_v2. This roadmap
defines the target architecture, the neubit_v2→v3 mapping, and a **strangler migration order** so each
service is transferred cleanly, one at a time, without breaking what already works.

Derived from a full fresh analysis of neubit_v2 (2026-07-07): Kong + 5 FastAPI services
(platform/vision/gates/octosense/fire) + neubit-common, **Kafka** bus, **TimescaleDB**, **MediaMTX**,
**RustFS** (S3), Redis→SSE, single-tenant.

---

## 1. Target architecture (loosely-coupled)

- **Gateway**: Traefik (file-provider routing). ✅
- **Event bus**: **NATS + JetStream** — the loose-coupling backbone. Subjects
  `tenant.<tenant_id>.<domain>.<event>`. **All inter-service communication is events** — NO sync
  HTTP between services, NO shared DBs across services. ✅ (infra up; contracts pending)
- **Planes** (polyglot-by-plane):
  - **Control plane** — Python/FastAPI `core` (the `app/` package). Identity, tenancy, sites, tags,
    device-registry, workflow, config, licensing, module-catalog, notifications, audit. Multi-tenant.
    (= neubit_v2 `platform`, upgraded to multi-tenant.) ✅ foundation exists.
  - **Data plane** — **Go** NVR/media service. Recording, streaming (MediaMTX), ONVIF, playback,
    realtime ingest. High-perf. (= neubit_v2 `vision` + `gvd_nvr`.) ⏳
  - **Domain services** — per-protocol adapter services (access/fire/octosense/nms). Each ingests a
    device protocol and publishes normalized events. Python or Go. ⏳
- **Media**: MediaMTX (RTSP→HLS/WebRTC, `sourceOnDemand` + `alwaysRemux` keepalive + NVR-slots) —
  port neubit_v2's proven model verbatim. ⏳
- **Data**: TimescaleDB (tenant_id row-scoping now → DB-per-tenant later), Redis, S3 object store
  (RustFS/MinIO) for recordings/exports. ✅ core stores.
- **Real-time to UI**: NATS → WebSocket/SSE bridge. ⏳
- **Ops/scale**: ops-agent (container control) ✅; orchestrator (Swarm/K8s) for real autoscale later.

## 2. Loose-coupling rules (to avoid migration issues)

1. **Events only** between services — versioned envelope `{event_id, tenant_id, type, occurred_at,
   source, correlation_id, actor, payload}`. No service reads another's DB or calls it synchronously.
2. **Contracts first** — define event subjects + schemas in a shared `contracts/` package BEFORE
   building producers/consumers. A consumer never assumes an undocumented field.
3. **Tenant-aware from day one** — every service carries `tenant_id` in data + events; scope every query.
4. **Own your data** — each service owns its schema; no cross-service foreign keys.
5. **Idempotent, replay-safe consumers** — JetStream durable subscriptions; dedupe by `event_id`.
6. **Protocol-first devices** — protocol drivers → normalized device API → brand adapters (not brand-first).
7. **Strangler, not big-bang** — stand up the new service, route a slice of traffic/features to it,
   verify, then retire the neubit_v2 equivalent. Old and new coexist behind the gateway.

## 3. neubit_v2 → neubit_v3 service map

| neubit_v2 | neubit_v3 target | plane | lang | status |
|---|---|---|---|---|
| `platform` (identity/auth/sites/tags/audit/settings/license/modules/devices-registry/workflow/ingest/notifications/nms) | `core` (`app/`), later split hot modules into own services | control | Python | ✅ foundation |
| `vision` (VMS) + `gvd_nvr` | `nvr` / `media` service | data | **Go** | ⏳ Phase 2 |
| `gates` (access control) | `access` service | domain | Py/Go | ⏳ Phase 4 |
| `fire` | `fire` service | domain | Py/Go | ⏳ Phase 4 |
| `octosense` (IoT) | `octosense` service | domain | Py/Go | ⏳ Phase 4 |
| Kafka | **NATS JetStream** | bus | — | ✅ up |
| Kong | **Traefik** | gateway | — | ✅ |
| MediaMTX / RustFS / Redis / Timescale | same | infra | — | ⏳ media pending |
| Superset / LibreNMS / Prometheus | add when the domain needs them | ops | — | later |

## 4. Migration order (strangler, dependency-driven)

**Phase 0 — Platform core foundation.** ✅ DONE
Auth/identity, tenancy + super-admin, isolation hardening, config/branding/audit/messaging/reports,
infrastructure control (ops-agent). Multi-tenant + verified on Docker.

**Phase 1 — Complete control-plane primitives** (in progress via the pending list).
Feature-gating enforcement, platform settings, **module-catalog**, **device-brands catalog**, plus the
shared foundations every domain needs next: **sites/floors/zones**, **tags**, **device master-registry**,
license enforcement. Delivers: a fully-featured super-admin + the scaffolding devices/workflow depend on.

**Phase 2 — Devices + VMS/NVR (headline; Go data plane).**
Device onboarding (ONVIF/RTSP/brand) in the control plane → the **Go `nvr`/`media` service**: MediaMTX
integration, on-demand streaming + keepalive + NVR-slots (port neubit_v2 model), recording→S3, health.
Operator UI: Devices + Streaming (video-wall, playback/investigation/sync). **Milestone: demoable
"login → site → camera → live view → playback."**

**Phase 3 — Event spine + Workflow/incident engine.**
NATS event contracts, correlation engine (device/domain events → triggers → incidents), SOP/instances/
transitions, notification dispatch, WS/SSE bridge to UI. Operator UI: Events + Workflow.

**Phase 4 — Domain services (one at a time): access → fire → octosense → nms.**
Each a protocol-adapter service publishing events the workflow engine consumes. Operator UI: the
matching Devices sub-tabs + integrations.

**Phase 5 — Observability, scale, hardening.**
Cross-tenant dashboards + metrics + alerts, DB-per-tenant isolation, autoscale (ops-agent + orchestrator),
STQC/security hardening, on-prem 512ch edition (Ed25519 signed license).

## 5. Definition of Done — per service (the "no-issue" checklist)

A service is "properly transferred" only when ALL hold:
1. **Tenant-scoped data model** + migration (tenant_id everywhere; isolation test passes).
2. **Event contracts** — the subjects it produces/consumes, versioned in `contracts/`, with a
   round-trip test (publish → consume).
3. **REST API** — tenant + super-admin surfaces, gated + audited.
4. **UI** — operator and/or admin pages wired.
5. **Tests** — unit + cross-tenant isolation + event round-trip (+ media E2E for NVR).
6. **Packaged** — Dockerfile + compose service + Traefik route + env.
7. **Verified on Docker** end-to-end, then **committed** at the service boundary.
8. **Old path retired** only after the new one is verified (strangler).

## 6. Where we are (2026-07-07)

Committed: snapshot · restructure (core `edge→app` + frontends `src/`) · infrastructure control ·
isolation hardening. Phase 1 pending items in progress (feature-gating, platform settings, module
catalog, device brands, observability, security hardening). Next big rock after Phase 1 = **Phase 2
devices + Go NVR/media**.

See also: [[go-migration-target-design]] (the synthesized target), `SUPERADMIN_TENANCY_PLAN.md` (super-admin plan).
