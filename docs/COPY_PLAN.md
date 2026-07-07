# Copy plan — platform_base → neubit_v3

Goal: complete the base by reusing the ready-made `platform_base` core + frontend, adding
the Traefik gateway, and layering multi-tenancy + a separate super-admin panel. After this,
the three pillars — **frontend + FastAPI core + gateway** — are online at one level.

> No implementation in this doc — this is the ordered plan. `platform/edge` and `platform/web`
> are genuinely ready-to-use (mature, feature-complete). The real work is multi-tenancy and
> the super-admin panel; AI removal and Traefik wiring are small.

## Source → destination

| From `platform_base` | To `neubit_v3` | Action |
|---|---|---|
| `platform/edge/` | `backend/core/` | copy → strip AI → add multi-tenancy + ForwardAuth endpoint |
| `platform/web/` | `frontend/` | copy → point API at Traefik `/api/*` |
| `platform/migrations/` | `backend/core/migrations/` | copy → add tenant + entitlement tables |
| `platform/pyproject.toml` | `backend/core/` | copy → drop AI extras |
| `vizor-infra` services | `deploy/docker-compose.yml` | already scaffolded (drop qdrant/AI) |
| — (not present) | `gateway/` Traefik | already scaffolded (new) |
| — (new) | `admin-frontend/` + core `/api/admin/*` | super-admin panel (see Phase D) |

## Phase A — copy the ready pieces

1. Copy `platform/edge/` → `backend/core/` (the FastAPI core: auth · RBAC · 2FA · license ·
   settings · branding · messaging · reports · storage · audit · module registry · realtime ·
   metrics · search).
2. Copy `platform/web/` → `frontend/` (the Vercel-theme admin UI: 18 pages + kit + theme +
   api/auth client + shell + ⌘K).
3. Copy `platform/migrations/` baseline + `pyproject.toml`.

## Phase B — strip AI (trivial, cleanly isolated)

Delete `edge/runtime/`, `edge/models/`, `edge/vectordb/`, `edge/stream/`, `edge/hooks.py`;
drop AI extras from `pyproject.toml` (onnxruntime/opencv/qdrant-client/…); remove the
`qdrant` service. No core module imports these — the baseline schema has zero AI tables.

## Phase C — enhancements (the real work)

1. **Multi-tenancy** (biggest item — `edge` is single-tenant today):
   - Tenant registry in the **control-plane DB** (id, name, plan, status, db_dsn).
   - **Tenant resolver** middleware: `X-Tenant-Id` (from ForwardAuth) → per-tenant DB
     connection + query scoping. **DB-per-tenant.**
   - `tenant_id` claim in the JWT; provisioning = create tenant DB + run migrations + seed.
   - Per-tenant object-storage buckets + media namespaces.
2. **Traefik wiring**:
   - Add `core` `/internal/auth/verify` (ForwardAuth): validate JWT → resolve tenant →
     return `X-User-Id`, `X-User-Role`, `X-Tenant-Id`, `X-Permissions`.
   - Point `frontend` `api.js` at Traefik-routed `/api/*` (+ `/ws` for realtime).

## Phase D — super-admin panel (separate, cross-tenant)

A **separate** management console for the vendor/operator of the platform — manages tenants,
licenses, and feature access across all tenants. This is distinct from the per-tenant
operator console.

- **Backend:** cross-tenant management APIs in `core` under a strictly-gated `/api/admin/*`
  surface, operating on the **control-plane DB** (never per-tenant data). Manages:
  - **Tenants** — create (→ provision DB) · suspend · offboard (→ drop DB) · list/inspect.
  - **Licenses** — issue/assign per-tenant Ed25519 licenses (tier · limits · expiry). The
    vendor **signing key stays offline / in a separate signing service** — the panel triggers
    issuance or uploads signed tokens; the private key never lives in the running platform.
  - **Feature access** — per-tenant module/feature entitlement (ties to the existing
    `edge/core/modules.py` registry + `license.py`) — which modules a tenant unlocks.
  - Cross-tenant audit/observability · plans/billing hooks · support **impersonation** (fully
    audited) · per-tenant branding.
- **Auth isolation (critical):** super-admins are a **separate realm** — own JWT audience
  (`aud=neubit-admin`, not the tenant `aud=neubit`), own login. A tenant user can never reach
  admin functions. Optionally network-isolated (internal/VPN or IP-allowlist) + own subdomain
  (`admin.neubit.cloud` vs `app.neubit.cloud`).
- **Frontend:** `admin-frontend/` — a **separate Next.js app**, reusing the same Vercel
  theme + kit, its own auth + routes. (neubit_v2 had a `(super)` route group for
  license/modules/brands/logs — v3 makes it a true cross-tenant console because of
  multi-tenancy.)
- **On-prem note:** on-prem is single-tenant → the super-admin panel is minimal/absent; the
  license is issued at install time. The cross-tenant panel matters for the **cloud** edition.

## Result

`frontend` (operator console) + `core` (FastAPI) + `gateway` (Traefik) + `admin-frontend`
(super-admin) — all online at one level. That is the ready base; domain services (sites,
device, workflow, vision, gates, fire, octosense) and the Go data plane (nvr, realtime) then
build on top.
