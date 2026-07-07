# Super-Admin + Multi-Tenancy — Design & Build Plan

Status: **DRAFT for review** · Owner: platform · Scope: neubit_v3 (`backend/core` + `admin-frontend` + operator `frontend`)

This plan makes the **tenant** and **super-admin** panels "proper" before any command-center module
work begins. It is derived from a 4-part review (2026-07-07):
- neubit_v2 super-admin (reference/target) — **single-tenant**; super-admin manages one deployment's
  License / Modules / API-Keys / Device-Brands / Settings / Logs / Profile as global singletons.
- neubit_v3 `admin-frontend` — only Tenants list + create/suspend/delete exists.
- neubit_v3 backend admin+tenancy — tenant CRUD works; `plan/features/limits/status` are **dead columns**.
- neubit_v3 tenant-isolation audit — **7+ tables leak across tenants**; user CRUD not scoped; suspended
  tenants can still log in.

---

## 0. Guiding architecture decision

**neubit_v3 is multi-tenant; each _tenant_ = a neubit_v2 "customer".** Therefore every neubit_v2
platform feature (license, feature/module access, quotas, settings, branding) becomes **per-tenant**,
and we add a tenant-management layer on top (which neubit_v2 never had).

- **Isolation model v1 = shared DB + `tenant_id` row-scoping** (target later: DB-per-tenant / cell).
  The whole point of Phase A is to make row-scoping actually airtight and centrally enforced so it is
  hard to leak, and so the later DB-per-tenant migration is mechanical.
- **Super-admin** = `is_superadmin=True AND tenant_id IS NULL`. Sees/acts across all tenants.
- **Tenant-admin** = `is_superadmin=False AND tenant_id=<uuid>` with the `Administrator` role,
  scoped strictly to its own tenant.
- **Platform-global** (NOT per-tenant): Device-Brands catalog, Container Logs, cross-tenant dashboard,
  the tenant registry itself.

### Open decisions (confirm before/at Phase B)
1. **License authenticity**: cloud multi-tenant → DB-managed per-tenant license is enough (super-admin
   owns the DB). On-prem single-tenant (512ch) → may want **Ed25519-signed** license (vizor_nvr pattern).
   Proposal: DB-managed now; add signed-license verification when we build the on-prem edition.
2. **Singleton settings scope** (app_settings, branding, channel_configs, email_templates): make them
   **per-tenant with a platform-default fallback** (`tenant_id NULL` row = default, tenant row = override).
   Alternative = keep them platform-global and forbid tenant-admin edits. Proposal: per-tenant + fallback.
3. **Impersonation**: super-admin mints a short-lived, audited token carrying a tenant context.
   Confirm we want it in Phase C (support workflows) vs later.

---

## Phase A — Tenant isolation hardening (SECURITY) ⭐ do first

Goal: no tenant-admin can ever read or mutate another tenant's data; suspended tenants are locked out;
user provisioning always lands in the right tenant. Build a **central scoping primitive** so we stop
hand-threading `tenant_id`.

### A0. Central tenant-scoping primitive
- Add `edge/tenancy/deps.py::get_scope()` → returns `{tenant_id, is_superadmin}` from the fresh user row.
- Add a query helper `scoped(stmt, model, scope)` that appends `WHERE model.tenant_id == scope.tenant_id`
  for non-superadmins and is a no-op for super-admins. All list/get/update/delete routes use it.
- Add `assert_same_tenant(obj, scope)` guard for by-id fetches (update/delete/download).

### A1. Add `tenant_id` to every tenant-owned table (+ backfill migration)
Tables needing a `tenant_id UUID FK → tenants.id` (nullable during migration, indexed):
`audit_log`, `report_jobs`, `roles`, `api_keys`, `app_settings`, `branding`, `channel_configs`,
`email_templates`. (`users` already has it. `notifications`/`device_tokens` inherit via `user_id`.)
- One Alembic migration `000X_tenant_scoping` adds the columns + indexes.
- Backfill: existing rows → the seeded "Genius Vision" tenant id (single-tenant today, safe).
- For singleton settings/branding/channels/email_templates: keep a `tenant_id NULL` row as the platform
  default; per-tenant overrides are new rows (decision #2).

### A2. Fix user provisioning (CRITICAL #1)
- `CreateUserIn` + `AuthService.create_user`: set `tenant_id` = actor's tenant (super-admin may pass an
  explicit `tenant_id`; tenant-admin is forced to their own). Same for **bulk import**.
- Never allow a tenant-admin to create `is_superadmin=True` or a cross-tenant user.

### A3. Scope user update/delete/get (CRITICAL #2)
- `PATCH/DELETE /users/{id}` and a new `GET /users/{id}`: `assert_same_tenant` before acting.

### A4. Block suspended-tenant login (CRITICAL #3)
- `AuthService.authenticate`: load the user's tenant; if `tenant.status != "active"` → 403.
  (Super-admins with `tenant_id NULL` bypass.)

### A5. Scope the leaking read/write surfaces (CRITICAL #4)
Apply `scoped(...)` + writes stamped with `scope.tenant_id` in:
`audit` list, `reports` list + download, `roles` CRUD, `api_keys` create/list/lookup,
`settings` get/set, `branding` get/set, `messaging` channels + email-templates.

### A6. Tests (TDD)
- Cross-tenant matrix test: tenant-A admin cannot list/get/patch/delete tenant-B users, audit, reports,
  roles, api-keys, settings, branding, channels.
- Suspended-tenant login denied. User-create lands in correct tenant. Super-admin sees all.

**Phase A exit criteria:** the isolation-audit table flips every ❌ to ✅ under automated tests.

---

## Phase B — Per-tenant entitlements (license · features · quotas)

Goal: bring the dead `plan/features/limits/status` columns to life — the actual value of a super-admin.

### B1. License model (per-tenant)
- Extend `tenants` (or a `tenant_license` 1:1 table) with: `license_tier`, `license_status`
  (`active|expired|suspended|cancelled`), `license_started_at`, `license_expires_at`, `grace_days`.
- `effective_status(now)` helper (temporal expiry overrides stored status; grace window) — port
  neubit_v2's `effective_license_status`.
- Endpoints: `PUT /admin/tenants/{id}/license` (apply/update), reflected in tenant detail.

### B2. Feature-gating
- `Tenant.features` = `{feature_key: bool}`. Add `require_feature("<key>")` dependency for module routes.
- Super-admin toggles features per tenant: `PATCH /admin/tenants/{id}` already accepts `features`
  (Phase A keeps it) → enforcement layer added here.

### B3. Quota enforcement
- `Tenant.limits` = `{max_users, max_cameras, max_nvrs, max_sites, max_storage_mb, ...}`.
- `enforce_limit(resource, scope)` checked before create (users now; devices later).
- Usage computation: on-demand counts (users now) → `GET /admin/tenants/{id}/usage`.

### B4. Suspend / reactivate as first-class actions
- `POST /admin/tenants/{id}/suspend` + `/reactivate` (sets status; Phase A already blocks login).

### B5. admin-frontend: Tenant detail page
- `/(panel)/tenants/[id]`: license editor (tier/status/dates/grace), feature toggles, limit editors,
  usage bars, suspend/reactivate, danger-zone delete.

### B6. Tests
- Feature off → 403 on gated route. Over-limit create → 402/409. Expired license → gated. Grace window works.

---

## Phase C — Super-admin panel UX buildout (admin-frontend)

Goal: turn the skeleton panel into a real console.

- **Shell/nav**: `menu.js` (Dashboard · Tenants · Profile), collapsible or top-nav, super-admin badge.
- **Dashboard**: platform KPIs — tenant count (active/suspended), total users, licenses expiring soon,
  recent cross-tenant audit stream.
- **Tenants list**: pagination + search + status filter (audit flagged none exist).
- **Tenant detail** (from B5) + **per-tenant admin users** (add/remove/reset a tenant's admins):
  `GET/POST/DELETE /admin/tenants/{id}/admins`.
- **Impersonation** (decision #3): `POST /admin/tenants/{id}/impersonate` → short-lived audited token;
  "Open tenant console" button; clear "impersonating" banner + exit.
- **Profile**: super-admin edits own name/password.
- Replace hardcoded seed password in `tenancy/seed.py` with env-only (security nit from review).

---

## Phase D — Platform-global admin (later; some depend on command-center)

- **Device Brands** catalog page (read-only integration list) — needs the device layer to exist first.
- **Container Logs** viewer (Docker socket tail) — infra/ops.
- **Cross-tenant analytics** dashboard depth.
- Per-tenant **branding / email / SSO** editors (operator-facing white-label).
- Migration toward **DB-per-tenant** (cell) once row-scoping is proven.

---

## Execution order & tracking

1. **Phase A** (security) — one migration + scoping primitive + route fixes + test matrix.
2. **Phase B** (entitlements) — license/features/quotas + tenant-detail UI.
3. **Phase C** (panel UX) — shell/dashboard/admins/impersonation/pagination.
4. **Phase D** — deferred.

Each phase: TDD (write the cross-tenant/enforcement tests first), verify on the Docker stack, commit at
phase boundaries. No command-center module work until A–C land.

## Risks / notes
- Adding `tenant_id` to 8 tables + backfill on a live dev DB → do it as one reversible migration; the dev
  DB can be wiped (`docker compose down -v`) if needed since data is seed-only.
- Frontend hot-reload watcher is currently unreliable on the bind-mount → `docker restart` per change
  (see memory `neubit-v3-traefik-routing`). Consider fixing the watcher before heavy admin-frontend work.
- Keep `require_superadmin` DB-backed (not token-trusting) — already correct.
