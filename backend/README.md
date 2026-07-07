# backend

Microservices. Polyglot by plane: **Python control plane** (core + domain services on the
`platform_base` edge), **Go data plane** (nvr, realtime). Full catalog:
[../docs/SERVICES.md](../docs/SERVICES.md).

| Dir | Service | Lang | Plane |
|---|---|---|---|
| `core/` | platform core (edge) — identity/tenant/rbac/license/settings/audit | Python | control |
| `sites/` | sites · floors · zones · maps | Python | control |
| `device/` | device master registry | Python | control |
| `workflow/` | SOP/automation engine + ingest | Python | control |
| `vision/` | VMS control + third-party NVR estate | Python | control |
| `gates/` | access control | Python | control |
| `fire/` | fire panels | Python | control |
| `octosense/` | IoT / sensors | Python | control |
| `nvr/` | recording engine (drives MediaMTX) | Go | data |
| `realtime/` | NATS → WebSocket fan-out | Go | data |
| `drivers/*` | integration drivers (protocol → api → brand) | Go + sidecars | edge |

## Conventions

- **No direct service-to-service HTTP.** Cross-domain communication is NATS events only.
  Subjects: `tenant.<id>.<domain>.<event>`.
- Auth: services trust the `X-User-Id` / `X-Tenant-Id` / `X-Permissions` headers injected by
  Traefik ForwardAuth (validated by `core`). They do not re-implement auth.
- Data: each service owns its tables in the **per-tenant database** resolved from
  `X-Tenant-Id`. No cross-service DB access.
- Python services import `edge` for cross-cutting (auth helpers, tenant resolver, audit,
  storage, events). Go services use the shared Go client libs.
