# Neubit v3

Version-3 rebuild of the Neubit command center: a **protocol-first, event-driven,
multi-tenant** physical-security platform (VMS + third-party NVR management + access control
+ fire + IoT), **polyglot by plane** — Python control plane on the `platform_base` core, Go
data plane — around a NATS event spine. AI enters only as an external-API driver.

## Layout

```
neubit_v3/
├── docs/            design — ARCHITECTURE.md · SERVICES.md · assets/
├── gateway/         Traefik edge (TLS · tenant routing · ForwardAuth → core)
├── backend/         microservices (see backend/README.md · docs/SERVICES.md)
│   ├── core/        platform core (Python / edge)
│   ├── sites device workflow vision gates fire octosense   (Python control plane)
│   ├── nvr realtime                                        (Go data plane)
│   └── drivers/     integration drivers (protocol → api → brand)
├── frontend/        Next.js modular monolith (Vercel theme) · also the Wails desktop UI
└── deploy/          docker-compose (local)
```

## Start here

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the full target architecture + decisions.
2. [docs/SERVICES.md](docs/SERVICES.md) — the microservices catalog.
3. [docs/assets/architecture-detailed.svg](docs/assets/architecture-detailed.svg) — the diagram.

## Principles

Loosely coupled + real-time — services talk **only via NATS events**, never direct HTTP.
Video is a **separate direct plane** (MediaMTX, never through the bus). Multi-tenant
(**DB-per-tenant**), deployable as multi-tenant **cloud** or single-tenant **on-prem** from
one codebase. Every device/brand is a **driver** behind a normalized capability contract.

> Status: design + scaffolding. No service implementation yet.
