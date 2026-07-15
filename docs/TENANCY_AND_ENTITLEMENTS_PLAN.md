# Multi-Tenancy Binding + Modules/License Entitlements — Master Plan & Tracker

> **Status:** ACTIVE · **Owner:** platform · **Started:** 2026-07-15
> **Scope:** `backend/core`, `backend/kernel`, `backend/gokernel`, all data-plane services
> (`workflow`, `access`, `ingest`, `vision`, `nvr`), `frontend` (operator console),
> `admin-frontend` (super-admin panel), `gateway`.
>
> Companion to [`SUPERADMIN_TENANCY_PLAN.md`](SUPERADMIN_TENANCY_PLAN.md) (the earlier
> Phase-A/B/C draft) and [`ARCHITECTURE.md`](ARCHITECTURE.md) §4, §10, §14.
> This document **supersedes** the tenancy portions of that draft and is the single
> source of truth for execution + progress.

---

## How we work (the loop)

For **every** phase:

1. **Code** — implement the tasks in the phase.
2. **Test** — write/run the tests listed under _Tests_ (TDD where practical: tests first).
   Verify on the Docker stack, not just unit tests.
3. **Mark done** — tick the task/test checkboxes here, flip the phase **Status** to
   ✅ Done, fill the _Completed_ date, and commit at the phase boundary.

Legend: ⬜ Not started · 🟨 In progress · ✅ Done · ⏸ Deferred

**No coding starts on a phase until the previous phase it depends on is ✅.** Phases with
no dependency arrow can run in parallel if capacity allows.

---

## Progress tracker

| Phase | Title | Track | Depends on | Status |
|---|---|---|---|---|
| **0** | Audit & decisions | both | — | ✅ Done |
| **1** | Entitlements resolver + JWT claims | Entitlements | 0 | ✅ Done |
| **2** | Operator nav + license display (visible impact) | Entitlements | 1 | ✅ Done |
| **3** | Satellite feature-gating + per-tenant license runtime | Entitlements | 1 | ✅ Done |
| **4a** | Isolation: cross-tenant matrix · search-leak fix · suspend-gate | Isolation | 0 | ✅ Done |
| **4b** | Isolation: Postgres RLS + NOT-NULL sentinel migration | Isolation | 4a | ⏸ Deferred |
| **5** | Gateway defense-in-depth (ForwardAuth wired) | Isolation | 4a | ✅ Done |
| **6** | Tenant lifecycle orchestration + entitlements contract | both | 3, 4a | ✅ Done |
| **7a** | DB-per-tenant foundation (router · provisioning · flag) | Isolation | 4a, 6 | ✅ Done |
| **7b** | DB-per-tenant cutover (route wiring · data migration · runner) | Isolation | 7a, 4b | ⏸ Deferred |
| **8** | Hardening (super-admin realm · NATS per-tenant · encryption keys) | both | 5, 7 | ⬜ |

**Execution order rationale:** Entitlements first (Phases 1–3) — it is the felt problem
(super-admin module toggles + license don't take effect) and is lower-risk, high-visibility.
Isolation hardening (4–5) is defense-in-depth: `tenant_id` + `scoped()` are already wired
broadly across every service (see Phase 0 findings), so the current leak risk is a hardening
gap, not an open hole — but it must not be deferred indefinitely. DB-per-tenant (7) lands only
once row-scoping is proven airtight.

---

## Locked decisions

1. **Isolation model:** _Pool now, silo later._ Shared DB + airtight row-scoping (with
   Postgres RLS enforcement) first; DB-per-tenant routing in Phase 7.
2. **Tenant propagation:** _JWT = authority, gateway = defense-in-depth._ Every service
   self-verifies the core-minted JWT (already the case); the gateway ForwardAuth additionally
   injects `X-Tenant-Id` as a redundant edge check. On mismatch → reject. JWT claim wins.
3. **Entitlements source of truth:** _One resolver, two sources._ A single
   `effective_entitlements(tenant)` resolver feeds `/api/v1/features`, the JWT claims, nav,
   API gates, and quota checks. Its **source** is the `Tenant` row for **cloud multi-tenant**,
   and the Ed25519 **signed license** for **on-prem single-tenant** (which seeds the lone
   tenant's row at boot). Same output shape either way.
4. **Super-admin realm:** separate JWT audience (`aud=neubit-admin`) — Phase 8.

---

## Phase 0 — Audit & decisions ✅

**Goal:** Establish the factual current state and lock the design decisions. _(This phase is
the analysis already completed; recorded here so the plan is self-contained.)_

### Current-state findings

**Tenant identity & binding (works, uniform):**
- `tenants` table (shared control DB): `id, slug, status, plan, features{}, limits{},
  license_expires_at, grace_days`. Super-admin = `is_superadmin=True AND tenant_id NULL`.
- JWT access token carries `tenant_id`, `is_superadmin`, `permissions[]`
  ([`auth/security.py`](../backend/core/app/auth/security.py)).
- Central scoping primitive in core ([`tenancy/scope.py`](../backend/core/app/tenancy/scope.py))
  and mirrored in both shared kernels ([`kernel/auth.py`](../backend/kernel/kernel/auth.py),
  [`gokernel/auth/auth.go`](../backend/gokernel/auth/auth.go)): `scoped()`, `assert_owned()`,
  `owns()`.
- **Every** data-plane service (`workflow`, `access`, `ingest`, `vision`, `nvr`) carries a
  `tenant_id` column on essentially every table, resolves tenant from the JWT claim (verified
  locally, shared HS256 `VE_JWT_SECRET`), and scopes reads broadly.
- **NATS subjects fully tenant-scoped**: `tenant.<id>.<domain>.<event>`; envelope carries
  `tenant_id`. Media/recording namespaces tenant-scoped (`cameras/<tenant_id>/...`).

**Isolation gaps (Track: Isolation):**
- **G1** — scoping is opt-in convention; no DB-level enforcement (RLS). A missed `scoped()`
  silently leaks.
- **G2** — Python models make `tenant_id` **nullable** (Go NVR uses `NOT NULL`). NULL =
  "platform/shared" row visible to everyone via `owns()`; an accidental NULL insert leaks.
- **G3** — suspended/expired-tenant gate exists only at core login; a valid JWT keeps working
  in satellites until it expires.
- **G5** — gateway `forward-auth` → `core:8000/internal/auth/verify` is **unwired** (endpoint
  does not exist; `api-protected` chain not attached to routers).

**Entitlements gaps (Track: Entitlements) — two disconnected systems:**
- **System A (per-tenant, what super-admin manages):** `module_catalog` +
  `Tenant.features{}` toggles + `Tenant.limits{}` + `plan` + expiry/grace + billing
  subscription/plans/invoices. Enforced only by `require_feature()` **in core**.
- **System B (global, what the runtime uses):** a single `app.state.license` (Ed25519-signed
  JWT / dev-unlimited) drives `/api/v1/features`, `/api/v1/license`, and
  `LicenseEnforcementMiddleware` ([`core/api.py`](../backend/core/app/core/api.py),
  [`core/license.py`](../backend/core/app/core/license.py)).
- **M1** — operator nav ([`menu.js`](../frontend/src/config/menu.js)) is static, filtered by
  **permission only** ([`Header.jsx:249`](../frontend/src/components/shell/Header.jsx#L249)),
  not by tenant modules. Super-admin's module toggle has **no visible effect**.
- **M2** — `/api/v1/features` returns the **global** license's modules, not the caller's
  `Tenant.features`.
- **M3** — license expiry enforced **globally**, never per-tenant at runtime.
- **M4** — satellite services can't feature-gate/quota-enforce (no `features`/`limits` in JWT).
- **M5** — three overlapping "license" notions with no single resolved contract.

### Tasks
- [x] Cross-service tenant-handling audit
- [x] Modules/license flow audit (System A vs System B disconnect)
- [x] Lock the four decisions (above)

**Completed:** 2026-07-15

---

## Phase 1 — Entitlements resolver + JWT claims  ✅

**Goal:** One authoritative per-tenant entitlements resolver, exposed via a tenant-aware
`/api/v1/features`, with `features` + `limits` baked into the access token so every service
(and the frontend) reads the **same** truth.

**Depends on:** Phase 0.

### Tasks
- [x] `effective_entitlements(tenant)` in core
      ([`tenancy/entitlements.py`](../backend/core/app/tenancy/entitlements.py)): merges
      `features{}` toggles + `limits{}` + `effective_license_state()` →
      `{ plan, modules: [{key,name,category,enabled}], limits, license_state, expires_at }`.
      Super-admin → all catalog modules enabled. _(Nav icon/path stay in the frontend
      `menu.js`; the catalog has no icon/path, so the backend returns key/name/category only.)_
- [x] New tenant-aware `GET /api/v1/features` returning the **caller's** resolved entitlements
      (from their `Tenant` row). Reachable under grace/expired so the UI can render banners.
- [ ] ⏸ On-prem edition: at boot, load the signed license → seed the single tenant's
      `features/limits/expires_at`. **Deferred** — no on-prem edition/seed path exists yet;
      tracked with Phase 6 ("on-prem auto-seeds a single tenant"). The resolver already accepts
      either source; only the on-prem seed wiring remains.
- [x] Extend `create_access_token` to add `features` + `limits` claims (mirroring the existing
      `permissions` claim), resolved via `token_entitlements()` at the mint sites
      (`issue_tokens`, `refresh_access`, impersonation). `security.py` stays DB-free.
- [x] Extend `Principal` in both kernels ([`kernel/auth.py`](../backend/kernel/kernel/auth.py),
      [`gokernel/auth/auth.go`](../backend/gokernel/auth/auth.go)) with `features` + `limits`
      and `feature_enabled(key)` / `limit(name)` accessors.
- [x] Keep the legacy global `/api/features` only as a **fallback**: `create_app` registers it
      only when no router already claims the path, so the multi-tenant core's tenant-aware
      endpoint wins and on-prem/scenario apps still get the signed-license version.

### Tests
- [x] Resolver unit: plan+toggles+limits+expiry → correct modules/limits/state; super-admin →
      all enabled; expired tenant → `license_state="expired"`; grace window → `"grace"`.
      ([`test_entitlements.py`](../backend/core/tests/test_entitlements.py))
- [x] `GET /api/v1/features` returns tenant A's modules for tenant A, tenant B's for tenant B,
      all-modules for super-admin. _(Verified live on the stack for super-admin + tenants
      `gvd` (vms+analytics on) and `gvd-test` (vms off) — outputs matched each tenant's
      `features`.)_
- [x] Minted access token contains `features` + `limits`; both kernels decode them into
      `Principal` (Python unit test + Go `TestVerify_Entitlements` parity test).
- [x] Docker-stack smoke: a tenant's stored toggles are reflected 1:1 in `/api/v1/features`.

**Result:** 25/25 core tests pass; `gokernel` auth tests pass; live `/api/v1/features` returns
correct per-tenant entitlements. A single resolver output is now the only entitlements shape;
the access token carries features+limits.

**Completed:** 2026-07-15

---

## Phase 2 — Operator nav + license display  ✅

**Goal:** The super-admin's module toggles and the tenant's license become **visible and
correct** in the operator console. (This is the primary reported problem.)

**Depends on:** Phase 1.

### Tasks
- [x] Entitlements in the auth context ([`lib/auth.js`](../frontend/src/lib/auth.js)): after
      `/auth/me` it fetches `/features`, and exposes `hasModule(key)`, `entitlements`,
      `licenseState`. Fetch failure degrades to `null` (permissive nav, no banner) so it never
      breaks auth. _(Folded into `useAuth()` rather than a separate hook, since nav already
      consumes `useAuth`.)_
- [x] Added a `module` key to nav entries in [`menu.js`](../frontend/src/config/menu.js):
      Dashboard/Streaming/Video-Wall/Linkage/Cameras/NVR/Recordings/Playback/Reports→`vms`,
      Access Control→`access`, Workflow/Ingest→`workflow`, Network→`nms`, Octosense→`octosense`.
      Core admin items (Users, Roles, Sites, Settings, …) intentionally ungated.
- [x] Nav filtering now requires **permission AND module-enabled**
      ([`Header.jsx`](../frontend/src/components/shell/Header.jsx),
      [`SectionTabs.jsx`](../frontend/src/components/shell/SectionTabs.jsx)); disabled-module
      items are hidden (disabled "Soon" placeholders still show).
- [x] Operator License page shows a per-tenant "Your plan & entitlements" card from `/features`
      (plan, modules on/off, limits, expiry, `license_state`) above the platform/on-prem signed
      license ([`TenantEntitlements.jsx`](../frontend/src/features/core/license/components/TenantEntitlements.jsx),
      wired in [`License.jsx`](../frontend/src/features/core/license/License.jsx)).
- [x] Grace/expired banner in the app shell from `licenseState`
      ([`AppLayout.jsx`](../frontend/src/components/shell/AppLayout.jsx)).
- [x] admin-frontend tenant detail: "Operator will see" preview derived from the current toggle
      state ([`tenants/[id]/page.jsx`](../admin-frontend/src/app/(panel)/tenants/[id]/page.jsx)).

### Tests
- [x] Both frontends compile clean after restart (routes `/`, `/home`, `/dashboard`, `/license`,
      admin `/tenants`, `/tenants/[id]` → 200, no compile errors).
- [x] Backend contract verified in Phase 1: `/features` returns correct per-tenant modules
      (`gvd` → vms+analytics on; `gvd-test` → vms off), which the nav filter consumes.
- [~] **Browser-visual confirmation pending** (headless env can't drive the SPA): log in as a
      tenant user and confirm module-off items disappear from nav and the license banner shows.
      Logic is `disabled || ((!module || hasModule) && (section || !perm || can))` — both gates
      enforced.

**Exit criteria:** a super-admin module toggle produces an immediate, correct change in the
target tenant's console; license state is visible per-tenant. _(Code + compile + backend
contract met; one browser eyeball recommended.)_

**Completed:** 2026-07-15

---

## Phase 3 — Satellite feature-gating + per-tenant license runtime  ✅

**Goal:** Enforcement, not just UI. A disabled module returns 403 at the API; an expired
tenant is blocked at runtime across all services (not only at login).

**Depends on:** Phase 1.

### Tasks
- [x] `require_feature(*keys)` + `feature_enabled()` in
      [`kernel/auth.py`](../backend/kernel/kernel/auth.py) (reads the token claim, super-admin
      bypass) and the Go `RequireFeature(...)` middleware in
      [`gokernel/httpx/middleware.go`](../backend/gokernel/httpx/middleware.go).
- [x] `enforce_limit(principal, resource, current)` helper in the Python kernel for quota
      checks before create (Go `Principal.Limit()` accessor available for parity). _(Not yet
      wired into a create path — the helper is ready; a first use lands with device/camera
      create.)_
- [x] Gate each domain service behind its module (router-level dependency): `vision`→`vms`,
      `access`→`access`, `workflow`→`workflow`, `ingest` admin→`workflow`, `nvr`(Go)→`vms`.
      Module OFF → `403 FEATURE_DISABLED`. The ingest **public webhook** receiver is NOT gated
      (per-webhook secret auth, no principal); the ONVIF SOAP server is NOT gated (WS-Security).
- [x] Per-tenant license runtime gate: `license_state` added to the access-token claims (core)
      + `require_active_license()` (Python) / `RequireActiveLicense()` (Go) on the same
      protected routers. Past-grace → `403 LICENSE_EXPIRED`; `grace` allowed; super-admin
      bypasses. Missing claim → "active" (fail-open, safe rollout).
- [x] Scoped the legacy global `LicenseEnforcementMiddleware` behind
      `VE_LICENSE_ENFORCE_GLOBAL` (default True for on-prem; set False for cloud multi-tenant).

### Tests
- [x] Module disabled → `403 FEATURE_DISABLED`; enabled → 200. **Verified live on `vision`:**
      `gvd` (vms on) → `GET /api/v1/vms/cameras` 200; `gvd-test` (vms off) → 403 FEATURE_DISABLED.
- [x] Expired tenant → `403 LICENSE_EXPIRED` (verified live: `gvd` token with
      `license_state=expired` → 403 on `/vms/cameras`); ungated `whoami` still 200.
- [x] Token carries `license_state`; both kernels decode it (Python unit +
      Go `TestVerify_LicenseState`); grace ≠ expired.
- [x] Core suite 26/26; `gokernel` auth tests pass; `nvr` builds with the gates wired.
- [~] Over-limit create test — deferred with the `enforce_limit` first wiring (no create path
      consumes a quota yet).

**Exit criteria:** entitlements are enforced at the API, not merely hidden in the UI;
per-tenant expiry blocks at runtime. **Met** (verified live on vision as the representative
service; the other services use the identical kernel gate).

**Rollout notes:**
- After deploy, users must **re-login once** so their access token carries the
  `features`/`limits`/`license_state` claims (old tokens default to no features → gated
  services 403 until refresh). Tokens are short-lived, so this self-heals on refresh.
- Only `vision` (+ core) is running the new code on the live dev stack (copied in for
  verification). `access`/`workflow`/`ingest`/`nvr` need an image rebuild to enforce; the
  source is committed and uses the same kernel gate proven on vision.

**Completed:** 2026-07-15

---

## Phase 4a — Isolation: matrix · search-leak fix · suspend-gate  ✅

**Goal:** Prove and lock the existing `scoped()`/`assert_owned()` isolation with an automated
cross-tenant matrix, fix any leak the audit surfaces, and close the suspended-tenant token
window at satellites — all without touching the live DB schema (that is 4b).

**Depends on:** Phase 0.

### Tasks
- [x] **Full `scoped()`/`assert_owned()` coverage audit** across core + all satellites (agent
      sweep). Result: **exactly one** real cross-tenant leak; everything else correctly scoped.
- [x] **Fixed the leak** — the ⌘K global search
      ([`search/router.py`](../backend/core/app/search/router.py)) queried `users` and `roles`
      with **no tenant filter** (a tenant-admin saw every tenant's users/roles). Now scoped:
      users via `scoped(...)`, roles via `AuthService.roles_query(scope)` (own-tenant + shared
      system roles); super-admin still sees all.
- [x] **Suspended-tenant satellite gate (G3)**: added `tenant_status` to the access-token
      claims; the kernel gate is now `require_tenant_access()` (aliased `require_active_license`)
      which denies **suspended** (403 TENANT_SUSPENDED) as well as **expired** (LICENSE_EXPIRED).
      Go `RequireActiveLicense` + `Principal.TenantSuspended()` mirror it. No service re-wiring
      (the alias keeps the Phase-3 include sites working); nvr covered too.
- [x] **Cross-tenant matrix test** (core, HTTP-level).

### Tests
- [x] Cross-tenant matrix ([`test_tenant_isolation.py`](../backend/core/tests/test_tenant_isolation.py)):
      tenant-A admin — list `/auth/users` excludes tenant-B; get `/auth/users/{B}` → 404 (not
      403); global `/search?q=` excludes tenant-B; user-create forced into A; super-admin sees all.
- [x] Suspend/expired token claims + gate: core token carries `tenant_status`
      ([`test_entitlements.py`](../backend/core/tests/test_entitlements.py)); Go
      `TestVerify_TenantSuspended`/`TestVerify_LicenseState`.
- [x] **Live verified:** suspended-tenant token → `403 TENANT_SUSPENDED` on vision; gvd-test
      user's search for a gvd user → `[]` (leak fixed); super-admin search → sees it.
- [x] Core 32/32; `gokernel` tests pass; `nvr` builds.

**Exit criteria:** the cross-tenant matrix is green; the audited leak is closed; a suspended
tenant is denied at satellites within the token TTL. **Met.**

**Completed:** 2026-07-15

---

## Phase 4b — Isolation: Postgres RLS + NOT-NULL sentinel  ⏸ Deferred

**Why deferred:** RLS + a NOT-NULL migration is a schema/policy change across **6 live
databases** on a stack that is actively in use, and it carries real lock-out risk if the
per-request GUC wiring or the owner/`FORCE ROW LEVEL SECURITY` setup is wrong. It is best done
deliberately in a migration window with Postgres-based tests — not folded into a feature turn.
The audit confirms row-scoping is already applied everywhere (only the one search leak, now
fixed), so RLS here is **defense-in-depth**, not an open hole.

### Tasks (when scheduled)
- [ ] Introduce an explicit **platform sentinel tenant** (a fixed UUID) to replace the
      `tenant_id IS NULL` "platform-default / shared" rows before enforcing NOT NULL — the NULL
      is load-bearing today (config singletons, shared system roles, platform super-admin).
- [ ] Migration per service DB: `tenant_id` → **NOT NULL** on the tenant-owned tables below,
      backfilling NULLs to the sentinel; **exclude** the genuinely node-global tables
      (`raid_arrays`).
- [ ] Enable **RLS** (`USING (tenant_id = current_setting('app.tenant_id')::uuid)`,
      `FORCE ROW LEVEL SECURITY`, non-owner app role or a superadmin-bypass policy); wire each
      service's `get_db` to `SET LOCAL app.tenant_id` per request (careful with pooled conns).
- [ ] Postgres-based tests: an un-`scoped()` query still returns only the caller's rows; NULL
      `tenant_id` insert rejected.

### NULLABLE `tenant_id` inventory (from the audit — the migration's work-list)
- **Core:** `branding`, `roles`, `users`, `api_keys`, `app_settings`, `report_jobs`,
  `security_policies`, `directory_configs`, `sso_configs`, `dual_auth_requests`, `tags`,
  `tag_links`, `device_placements`, `floors`, `sites`, `zones`, `email_templates`.
  _(Already NOT NULL: `billing_subscriptions`, `billing_invoices`.)_
  Load-bearing NULL (need the sentinel): `branding`, `app_settings`, `security_policies`,
  `directory_configs`, `sso_configs`, `email_templates` (platform-default rows), `roles`
  (shared system roles), `users` (platform super-admin).
- **Workflow:** one mixin column (`_TenantTimestamped.tenant_id`) → hits `sops`,
  `workflow_states/transitions/triggers/instances/forms`, `notification_templates/channels`,
  `notifications`, `device_tokens`, `threat_levels`, `alert_formats`, `correlation_dedup`.
- **Ingest:** `ingest_categories`, `ingest_webhooks`, `ingest_event_rules`, `ingest_event_logs`.
- **Access:** `access_instances`, `access_mirror`, `access_doors`, `access_events`,
  `access_groups`, `access_schedules`, `access_sync_jobs`.
- **Vision:** `bookmarks`, `cameras`, `media_profiles`, `video_decoders`, `vms_events`,
  `evidence_locks`, `export_jobs`, `camera_groups`, `camera_acl`, `camera_health`,
  `linkage_rules`, `linkage_fires`, `playback_sessions`, `media_nodes`, `stream_shards`,
  `motion_search_jobs`, `nvrs`, `onvif_server_config` (NULL=default), `camera_patterns`,
  `ptz_presets`, `ptz_patrols`, `recordings`, `report_schedules`, `storage_pools` (NULL=default),
  `storage_tier_rules`, `video_walls`, `wall_monitors`, `wall_presets`, `wall_tours`.
  _(Exclude `raid_arrays` — node-global, no `tenant_id`.)_

---

## Phase 5 — Gateway defense-in-depth (ForwardAuth wired)  ✅

**Goal:** Wire the intended edge auth as a redundant check without weakening the
JWT-is-authority model.

**Depends on:** Phase 4a.

### Design note — injector, not enforcer
`/internal/auth/verify` **always returns 200** and only emits identity headers when a valid
access token is present; it never rejects. This is deliberate: the satellite routers carry
mixed public/protected paths (the ingest webhook, media/onvif verify), so a rejecting
ForwardAuth would break public flows. Authoritative enforcement stays in each service's own
JWT verification (the locked decision: JWT = authority, header = hint). The gateway's value is
`strip-identity` (kills client-spoofed identity headers) + injecting a **trusted** `X-Tenant-Id`
that the kernel cross-checks against the JWT.

### Tasks
- [x] `GET /internal/auth/verify` in core ([`core/api.py`](../backend/core/app/core/api.py)):
      validates the JWT, emits `X-User-Id` / `X-Tenant-Id` / `X-Permissions` for a valid token,
      nothing for none/invalid. Internal-only (no router matches `/internal/*` externally).
- [x] Gateway config: `api-protected` (strip-identity + forward-auth + sec-headers + rate-limit)
      on the satellite routers (workflow/access/vision/nvr/ingest); a new `core-protected`
      (strip-identity + sec-headers + rate-limit, **no** forward-auth — core is the auth target
      and self-verifies) on the core router ([`gateway/dynamic/`](../gateway/dynamic/)).
- [x] Kernels: if `X-Tenant-Id` is present it **must match** the JWT claim, else reject
      (`get_principal` in [`kernel/auth.py`](../backend/kernel/kernel/auth.py); `RequireAuth`
      in [`gokernel/httpx/middleware.go`](../backend/gokernel/httpx/middleware.go)). Absent
      header (direct call) unaffected.

### Tests (live, through the gateway)
- [x] Valid token → verify emits `X-User-Id`/`X-Tenant-Id`/`X-Permissions`; no/invalid token →
      200 with no identity headers (core logs also show Traefik hitting
      `GET /internal/auth/verify -> 200`).
- [x] Protected vision route with a valid token → **200** (forward-auth injected, cross-check
      passed). Feature gate still fires (vms-off token → 403 FEATURE_DISABLED).
- [x] **strip-identity proven**: a client-supplied bogus `X-Tenant-Id` → **200** (stripped, then
      the real tenant injected) — not 401, so the client header never reached the service.
- [x] Mismatched `X-Tenant-Id` (direct, un-stripped) → **401** tenant header/token mismatch.
- [x] Public login through the gateway still works (bad creds → 401 from core, not gateway).
- [x] Core 32/32; `gokernel`/`nvr` build.

**Exit criteria:** ForwardAuth active on satellite routes as a header-injecting cross-check;
strip-identity prevents header spoofing; JWT stays authority. **Met (verified live).**

**Env note:** a host Docker restart mid-work bounced the whole stack, and a Windows Apache
briefly grabbed port 80 during a Traefik reload; restarting the gateway + `docker compose up -d`
restored it. Unrelated to the code. (`mediamtx` still fails to bind :8189 — a separate local
port conflict, irrelevant to tenancy.)

**Completed:** 2026-07-15

---

## Phase 6 — Tenant lifecycle orchestration + entitlements contract  ✅

**Goal:** Creating/suspending/offboarding a tenant propagates across services; billing and
entitlements share one documented contract.

**Depends on:** Phases 3, 4a.

### Tasks
- [x] Core emits lifecycle events on the NATS spine
      ([`admin/router.py`](../backend/core/app/admin/router.py)):
      `tenant.<id>.tenant.provisioned` (create), `.suspended`, `.reactivated`, `.offboarded`
      (delete).
- [x] **Offboard = DPDP right-to-erase**: a generic, metadata-driven kernel helper
      ([`kernel/lifecycle.py`](../backend/kernel/kernel/lifecycle.py)) — a durable consumer that,
      on `tenant.offboarded`, deletes every row whose table carries a `tenant_id` column, in
      FK-safe order (no per-service model list). Wired into all four Python satellites'
      lifespans (workflow/access/ingest/vision). Suspension/expiry are already enforced live via
      the token gate (Phase 4a), so those events are informational here.
- [x] **Entitlements contract documented** (below).
- [ ] ⏸ On-prem edition auto-seeds a single tenant at install — **deferred to Phase 7** (it is
      the on-prem provisioning path; belongs with DB-per-tenant).
- [ ] ⏸ `nvr` (Go) offboard consumer — **follow-up**; the Python satellites cover the erase
      today, and nvr recordings are also removable by dropping the per-tenant media namespace in
      Phase 7.

### The entitlements contract (the single source of truth)
- **Write path** — a super-admin sets a tenant's entitlements two ways, both landing in the
  **`Tenant` row**: the tenant-detail License card (features/limits/plan/expiry directly), or
  Billing "Apply entitlements" (a plan's features/limits copied onto the tenant).
- **Read path** — `effective_entitlements(tenant)` is the ONLY resolver; nothing reads the raw
  columns for enforcement.
- **Precedence** — `(on-prem signed-license | cloud Tenant row)` → `effective_entitlements` →
  **JWT claims** (`features`/`limits`/`license_state`/`tenant_status`) → consumed by (a) the
  operator **nav** (`hasModule`), (b) **API gates** (`require_feature`/`require_tenant_access`),
  (c) **quota checks** (`enforce_limit`). Change the tenant row → next token refresh propagates
  everywhere.

### Tests
- [x] **Live offboard e2e:** created a throwaway tenant, inserted a `notification_channels` row
      for it, `DELETE /admin/tenants/{id}` → within seconds the workflow consumer logged
      `erased 1 rows` and the row count went 1 → 0. Core `DELETE` returned 204.
- [x] Erase unit test ([`test_offboard.py`](../backend/workflow/tests/test_offboard.py)): erases
      only the target tenant's rows; leaves other tenants, the platform-NULL row, and non-tenant
      tables untouched.
- [x] All four satellites restart clean with the consumer wired (no import errors); core 32/32.

**Exit criteria:** offboard is a one-action, cross-service erase; one documented contract.
**Met** (verified live on workflow as the representative; access/ingest/vision use the identical
one-line wiring).

**Completed:** 2026-07-15

---

## Phase 7a — DB-per-tenant foundation  ✅

**Goal:** Build + prove the DB-per-tenant machinery (ARCHITECTURE.md §10) **behind a flag
(`VE_DB_PER_TENANT`, default OFF)** so the shared-DB stack is untouched, while the reusable
hard parts — the request-time router and the provisioning primitives — exist and are tested.

**Depends on:** Phases 4a, 6.

### Tasks
- [x] **Tenant→DB router** in [`kernel/db.py`](../backend/kernel/kernel/db.py):
      `sessionmaker_for(tenant_id)` / `get_db_for(tenant_id)` return a lazily-built, pooled
      sessionmaker on `<base>_t_<tenant_hex>` when the flag is on, and **fall back to the shared
      engine** when off or `tenant_id` is None. The shared `get_db` is unchanged.
- [x] **Provisioning primitives** in
      [`kernel/provisioning.py`](../backend/kernel/kernel/provisioning.py): `create_tenant_db`,
      `drop_tenant_db` (FORCE), `provision_tenant_schema` (create DB + `metadata.create_all`),
      plus `tenant_db_name`/`tenant_url` derivation. DDL via a raw asyncpg admin connection.
- [x] **Lifecycle wiring** ([`kernel/lifecycle.py`](../backend/kernel/kernel/lifecycle.py)):
      `subscribe_tenant_provisioned` (create the tenant DB + schema on `tenant.provisioned`) and
      an offboard consumer that now **drops the DB** when the flag is on / **erases rows** when
      off. Both wired into all four Python satellites' lifespans (dormant while the flag is off).
- [x] Config flag `db_per_tenant` ([`kernel/config.py`](../backend/kernel/kernel/config.py)).

### Tests
- [x] Unit: `tenant_db_name`/`tenant_url` derivation (≤63 chars, only the DB name swapped);
      **flag-off router falls back to the shared sessionmaker** for both None and a real id
      ([`test_db_per_tenant.py`](../backend/workflow/tests/test_db_per_tenant.py)).
- [x] **Live Postgres**: `provision_tenant_schema` creates `neubit_workflow_t_<hex>`, builds the
      real workflow schema (`notification_channels` present), then `drop_tenant_db` removes it —
      verified against the running server.
- [x] All four satellites restart clean with both consumers wired (flag off → dormant).

**Exit criteria:** the router + provisioning primitives exist and are proven against Postgres,
with the shared-DB stack unaffected. **Met.**

**Completed:** 2026-07-15

---

## Phase 7b — DB-per-tenant cutover  ⏸ Deferred

**Why deferred:** flipping `VE_DB_PER_TENANT` on a populated multi-tenant stack is a deliberate
**data migration**, not a code toggle. It also depends on Phase 4b (the NOT-NULL/sentinel work),
and it changes every service's query path. Done in a planned window, not a feature turn.

### Tasks (when scheduled)
- [ ] Route each service's DB dependency from the shared `get_db` to `get_db_for(principal.
      tenant_id)` so queries actually land in the tenant's DB (the router already exists).
- [ ] Per-tenant **migration runner**: apply each service's Alembic migrations across all tenant
      DBs (provision uses `create_all` for a fresh DB; existing tenant DBs need the delta runner).
- [ ] **Backfill migration**: copy each existing tenant's rows from the shared service DB into
      its new per-tenant DB, then flip the flag.
- [ ] Per-tenant **object-store bucket** + **NATS namespace/account** on provision; drop on
      offboard (the DB drop is already wired).
- [ ] `gokernel` DB router parity (nvr) for the Go data plane.
- [ ] On-prem edition: seed the single tenant + its DB at install (the deferred Phase-6 item).

**Exit criteria:** operational data is physically separated per tenant; provisioning/offboarding
are DB-level; on-prem and cloud share the path.

---

## Phase 8 — Hardening (super-admin realm · NATS per-tenant · encryption keys)  ⬜

**Goal:** Close the remaining STQC/isolation items.

**Depends on:** Phases 5, 7.

### Tasks
- [ ] Separate super-admin realm: own JWT audience (`aud=neubit-admin`), own login; tenant
      users can never reach `/api/admin/*`. Optional network/subdomain isolation.
- [ ] Per-tenant NATS JetStream accounts / subject permissions so a tenant subject boundary is
      enforced, not just conventional.
- [ ] Per-tenant encryption keys (secrets at rest) for the strongest data-residency claim.

### Tests
- [ ] A tenant token is rejected by `/api/admin/*` (wrong audience).
- [ ] A tenant cannot subscribe across `tenant.*` (NATS permission denies it).
- [ ] Per-tenant key rotation works; data encrypted under the right key.

**Exit criteria:** super-admin realm isolated; NATS + encryption per-tenant.

**Completed:** _(date)_

---

## Risks & notes

- RLS + NOT NULL migration touches many tables across services — do each service as one
  reversible migration; the dev DB can be wiped (`docker compose down -v`, seed-only data).
- Keep tokens short-lived so entitlement/tenant changes take effect at refresh without a
  logout (the design already re-mints claims on refresh).
- Do **not** let the two entitlement systems drift again — after Phase 1, every consumer reads
  the single resolver output; the signed-license path only feeds the resolver (on-prem).
- Frontend hot-reload on the bind-mount is unreliable → `docker restart` per change during
  frontend phases.
</content>
</invoke>
