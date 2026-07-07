# Neubit v3 — Microservices

Bounded-context decomposition. The fat v2 `platform` service is split into a lean **core**
plus focused domain services (`sites`, `device`, `workflow`) so the core stays optimized and
each context owns its data + events. Language follows the plane (Python control, Go data).

Every service: owns its data (per-tenant DB), exposes REST behind Traefik, and
**communicates cross-domain only via NATS events** — never direct service-to-service HTTP.

## Core (Python · `platform_base` edge)

| Service | Responsibility | Notes |
|---|---|---|
| **core** | identity · auth/JWT · tenants + tenant-resolver · RBAC · licensing · settings · branding · messaging/notifications · reports · storage · audit | The `edge` package run as a service. Backs Traefik **ForwardAuth**. Owns the shared control-plane DB (tenant registry, global identity) + per-tenant settings. STQC controls live here. |

`edge` is also a **library** every Python service imports for auth/tenant/audit/storage helpers.

## Domain services (Python control plane)

| Service | Responsibility | Publishes | Consumes |
|---|---|---|---|
| **sites** | spatial/org hierarchy: sites · floors · zones · tags · maps/floor-plans | `sites.*` | — |
| **device** | canonical **device master** registry (any device: camera/NVR/door/panel/sensor) + capabilities + health rollup | `device.*` | `*.health`, driver discovery |
| **workflow** | SOP/automation engine **+ ingest** (external webhooks / event ingestion) | `workflow.*` | all domain events (reacts) |
| **vision** | VMS control: cameras · NVR management · playback/export orchestration · third-party NVR estate | `vms.*` | `device.*`, `camera.*` |
| **gates** | access control: doors · readers · cardholders · schedules | `access.*` | `device.*` |
| **fire** | fire-alarm panels · zones · points · alarms | `fire.*` | `device.*` |
| **octosense** | IoT/sensors: telemetry · thresholds · alarms | `iot.*` | `device.*` |

## Data plane (Go)

| Service | Responsibility | Notes |
|---|---|---|
| **nvr** | recording engine — RTSP ingest → record → retention; drives MediaMTX; 512-ch node-sharded | Port of `gvd_nvr`. Highest-value Go work. Data-plane. |
| **realtime** | NATS → browser **WebSocket/SSE** fan-out (per-tenant, permission-filtered) | High-concurrency; Go is ideal. |

## Integration / driver layer (polyglot · protocol → API → brand)

Each driver implements the capability contract and publishes normalized events to NATS.
Go by default; sidecars where another ecosystem fits better.

| Driver | Covers | Lang |
|---|---|---|
| **camera** | ONVIF (S/T live, PullPoint events) · RTSP | Go |
| **nvr-estate** | third-party NVR mgmt/health/recording/export — ONVIF Profile G · Hik ISAPI · Dahua | Go |
| **ai-api** | external AI analytics API (3rd-party cameras) → `*.analytics.*` events | Go |
| **access** | OSDP · **SignalR** (one brand) | Go (SignalR: Go client or small sidecar) |
| **fire** | MQTT · panel APIs | Go |
| **iot** | Modbus (Go) · **BACnet** (Python sidecar, BAC0) | Go + Python sidecar |

## Infrastructure (run, not built)

Traefik (edge) · NATS + JetStream (event spine) · Postgres/TimescaleDB (per-tenant DBs) ·
MediaMTX + ffmpeg (media) · S3-compatible object store (per-tenant buckets) ·
OpenTelemetry + Prometheus + Grafana (observability) · SOPS + age (secrets).

## Frontend

- **Operator console** (`frontend/`) — one **Next.js modular monolith** (Vercel theme),
  feature-modules per domain, lazy-loaded, gated by the core's `/features` manifest. Same app
  packaged as the **Wails desktop** client. Per-tenant.
- **Super-admin panel** (`admin-frontend/`) — a **separate** Next.js app (same theme/kit, own
  auth realm + subdomain) for **cross-tenant** management: tenants, licenses, feature access,
  cross-tenant audit, impersonation. See below.

## Super-admin / tenancy management

Cross-tenant management lives in **`core` under `/api/admin/*`**, gated by a separate
super-admin realm (`aud=neubit-admin`) — a tenant user can never reach it. Operates on the
**control-plane DB only**, never per-tenant data.

| Concern | What |
|---|---|
| Tenants | create (→ provision per-tenant DB) · suspend · offboard (→ drop DB) · inspect |
| Licenses | issue/assign per-tenant Ed25519 licenses (tier · limits · expiry); signing key offline |
| Feature access | per-tenant module/feature entitlement (module registry + license) |
| Ops | cross-tenant audit/observability · plans/billing · support impersonation (audited) |

On-prem (single-tenant): this surface is minimal/absent — license issued at install.

---

### Why this split

- **core stays lean + optimized** — only cross-cutting identity/tenant/license/etc., not
  device/site/workflow domain logic.
- **device** is its own registry because *everything* is a device — one canonical record +
  `device.*` events that domain services mirror.
- **sites** is the spatial backbone referenced by devices, events, and maps.
- **workflow + ingest together** — ingest feeds the automation engine; one context for now,
  splittable later if ingest volume demands.
- Each context can scale and (if ever needed) change language independently — the NATS +
  Traefik contract makes that free.
