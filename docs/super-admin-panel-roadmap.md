# Neubit v3 — Super Admin Panel Improvement Roadmap

> **Status:** Planning (no code yet)
> **Date:** 2026-07-09
> **Scope:** `admin-frontend/` (platform super-admin control plane) + supporting `backend/core` endpoints
> **Goal:** Bring the v3 super-admin panel to industry-level SaaS-control-plane maturity, closing the UI/tooling regression vs v2 while keeping v3's superior multi-tenant architecture.

---

## 1. Context & Comparison (v2 vs v3)

### 1.1 Architecture

| Aspect | neubit_v2 | neubit_v3 |
|---|---|---|
| Super-admin location | `(super)` route group inside the single frontend app | **Dedicated `admin-frontend/` app** (separate control plane) |
| Tenancy model | Single-org per deployment (license-bound) | **True multi-tenant** — tenant CRUD, per-tenant license, impersonation |
| Cross-tenant audit | ❌ own-scope only | ✅ `/audit` |
| Infra/container monitoring | Logs only (`/super/logs`) | ✅ Full fleet: CPU/mem/health/restart/stop/start/scale + live logs |

**Verdict:** v3's architecture is strategically superior (a real SaaS control plane). But UI maturity and front-end tooling regressed vs v2. This roadmap keeps v3's architecture and raises its execution quality to industry level.

### 1.2 Tooling / UI maturity gap

| Capability | v2 | v3 | Gap |
|---|---|---|---|
| Design system / component kit | ✅ Radix + `ui.jsx` + CVA | ❌ inline per-page components | Big |
| Data tables | ✅ TanStack Table (`data-table.jsx`) | ❌ hand-built `<table>` everywhere | Big |
| Forms + validation | ✅ react-hook-form + yup | ❌ plain controlled inputs | Big |
| Charts / analytics | ✅ SVG donuts + Superset embed | ❌ no chart library | Big |
| State management | ✅ Zustand + React Query | ⚠️ React Query only; auth in `localStorage` | Medium |

### 1.3 Feature gaps in v3 super-admin

- ❌ Global (cross-tenant) user directory — only per-tenant view exists
- ❌ Billing / invoicing / subscriptions (absent in both; required for industry-level SaaS)
- ❌ Analytics / time-series (tenant growth, usage, revenue) — only client-computed KPIs
- ❌ Platform-staff RBAC — super-admin is just a boolean flag; no granular platform roles
- ❌ Notifications / alerts center — only toasts
- ❌ **Super-admin MFA/2FA enrolment UI** — backend enforces (`VE_REQUIRE_SUPERADMIN_2FA`) but there is no enrolment UI and login ignores MFA ⚠️ (security risk)
- ❌ Client-side authorization — only token-presence check, no role guard
- ⚠️ DB backup/restore — present in v2 (`/super/database`), missing in v3
- ⚠️ Device brands — recently removed from v3 admin console; backend `device_brands/` still exists

---

## 2. Current v3 Super-Admin Inventory (baseline)

**App:** `admin-frontend/` — Next.js 16 (App Router), React 19, Tailwind 3, TanStack React Query, Axios, lucide-react, framer-motion, sonner. No form/chart/table library.

**Existing routes** (`admin-frontend/src/app/(panel)/`):

| Route | Purpose |
|---|---|
| `/dashboard` | Platform KPIs (client-aggregated) + license-attention list |
| `/tenants`, `/tenants/[id]` | Tenant list/CRUD; detail with license, usage, tenant admins, impersonate, suspend/delete |
| `/modules` | Feature-flag / module catalog |
| `/platform-settings` | Announcement, support email, signups, branding + logo, Google Maps |
| `/audit` | Cross-tenant audit log |
| `/infrastructure` | Container fleet monitoring + logs + scale |
| `/profile` | Own super-admin profile |

**Backend:** FastAPI `backend/core` — `admin/router.py`, `platform_admin/`, `module_catalog/`, `infra/`, `branding/`, `core/audit.py`; gated by `require_superadmin` (`tenancy/deps.py`).

---

## 3. Roadmap (all phases)

Each item lists: **What**, **Why**, **Where** (files/areas), and **Acceptance** (done-when).

### Phase 0 — Foundation (blockers)

**0.1 Shared UI component kit**
- **What:** Create `admin-frontend/src/components/ui/` — `Button`, `Card`, `Input`, `Select`, `Switch`, `Textarea`, `Badge`, `Dialog/Modal`, `Skeleton`, `EmptyState`, `Tooltip`, `Tabs`. Port patterns from v2 `components/super/ui.jsx` (Radix + `class-variance-authority`).
- **Why:** Every page currently redefines badges/tables/modals inline → inconsistency + duplication.
- **Where:** new `components/ui/`; add deps `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`.
- **Acceptance:** All existing pages consume the shared kit; no inline one-off primitives remain.

**0.2 Reusable DataTable (TanStack Table)**
- **What:** One `<DataTable>` with sorting, pagination, column filters, row selection, loading/empty/error states.
- **Why:** Tenants/modules/infra/audit all hand-roll tables + skeletons.
- **Where:** `components/ui/data-table.jsx`; add `@tanstack/react-table`.
- **Acceptance:** All four tables migrated; server-side pagination wired for tenants & audit.

**0.3 Forms with validation**
- **What:** Adopt `react-hook-form` + `@hookform/resolvers` + `yup`; refactor create-tenant, module, platform-settings, tenant-admin forms.
- **Why:** No validation today → bad UX and error-prone writes.
- **Acceptance:** All modals/forms validated with inline field errors + disabled-until-valid submit.

**0.4 Client-side auth guard**
- **What:** In `(panel)/layout.jsx`, verify `is_superadmin` via `/auth/me` (React Query), not just token presence; redirect + show a proper "not authorized" state.
- **Why:** UI currently trusts token existence only.
- **Acceptance:** Non-superadmin token cannot render panel; server remains authoritative (`require_superadmin`).

### Phase 1 — Security hardening (critical)

**1.1 Super-admin MFA/2FA UI**
- **What:** TOTP enrolment wizard (QR + verify), backup codes, regenerate/disable; enforce MFA challenge on login when `VE_REQUIRE_SUPERADMIN_2FA`.
- **Why:** Backend enforces 2FA but no enrolment UI exists; login ignores MFA → lockout / security gap.
- **Where:** new `components/security/mfa-*`; `app/login/page.jsx`; reference v2 `components/identity/mfa-setup-wizard.jsx`.
- **Acceptance:** A super-admin can enrol, log in with TOTP, view/regenerate backup codes.

**1.2 Active sessions management**
- **What:** List own + other platform-admin sessions (device, IP, last-seen); force-logout.
- **Where:** new `app/(panel)/security/sessions`; reference v2 `components/identity/sessions-panel.jsx`, `lib/api/sessions.js`.
- **Acceptance:** Sessions listed; revoke works and invalidates the target token.

**1.3 Impersonation safety**
- **What:** Confirm dialog before impersonation; persistent banner in operator console during impersonation; every impersonation start/stop written to audit.
- **Where:** `tenants/[id]/page.jsx`, `frontend/src/app/impersonate/page.jsx`, `backend admin/router.py`.
- **Acceptance:** Impersonation is auditable and visually unmistakable.

**1.4 Token storage hardening**
- **What:** Move access token from `localStorage` to in-memory + httpOnly refresh cookie with silent refresh (v2 `lib/http.js` pattern).
- **Why:** `localStorage` tokens are XSS-exfiltratable.
- **Acceptance:** No JWT in `localStorage`; refresh-on-401 works transparently.

### Phase 2 — Core admin depth

**2.1 Global user directory (cross-tenant)**
- **What:** Search/filter all users across tenants (by tenant, status, role, email); bulk actions (deactivate, force-reset, force-logout); drill to tenant.
- **Where:** new `app/(panel)/users`; new backend endpoint `GET /admin/users` (cross-tenant, paginated, filtered).
- **Acceptance:** Find any user in one search; bulk actions audited.

**2.2 Platform-staff RBAC**
- **What:** Replace the single `is_superadmin` boolean with granular platform roles (e.g. `platform-owner`, `billing-admin`, `support-agent`, `read-only-auditor`) + permission-matrix editor.
- **Why:** All-or-nothing super-admin is not least-privilege; support staff shouldn't delete tenants.
- **Where:** backend `tenancy/deps.py` + new platform-roles model; new `app/(panel)/access-control`.
- **Acceptance:** Roles assignable; each panel action gated by a platform permission; migration keeps existing super-admins as `platform-owner`.

**2.3 Database backup / restore**
- **What:** Export SQL backup (blob download); import with confirm + async job tracking.
- **Where:** new `app/(panel)/system/database`; reference v2 `/super/database`, `lib/api/database.js`.
- **Acceptance:** Export downloads; import runs as tracked job with status.

**2.4 Tenant detail enhancements**
- **What:** Structured license/entitlement editor (replace raw JSON textareas), quota usage bars per resource, tenant activity timeline, tenant-scoped audit tab.
- **Where:** `tenants/[id]/page.jsx`.
- **Acceptance:** License edited via typed form; usage visualised; per-tenant audit visible.

### Phase 3 — Observability & analytics

**3.1 Analytics dashboard**
- **What:** Real time-series: tenant growth, active users (DAU/MAU), license/plan distribution, quota-utilisation trends. Use a charting lib (recharts or visx).
- **Why:** Current KPIs are client-aggregated snapshots, no trends.
- **Where:** rebuild `dashboard/page.jsx`; new backend metrics endpoints (time-bucketed aggregates).
- **Acceptance:** At least 4 trend charts backed by real aggregates with date-range control.

**3.2 Optional Superset embed**
- **What:** Guest-token BFF + embedded Superset for heavy BI (mirror v2 `app/api/superset/*`).
- **Acceptance:** One embedded dashboard renders with a scoped guest token.

**3.3 Infrastructure upgrade**
- **What:** Historical CPU/mem sparklines, alert thresholds with visual state, service dependency/health overview, log search + level filters (extend existing drawer).
- **Where:** `infrastructure/page.jsx` + backend infra metrics history.
- **Acceptance:** Per-container sparkline + threshold badges; searchable logs.

### Phase 4 — Commercial / SaaS features

**4.1 Billing & subscriptions**
- **What:** Subscription plans, invoices, payment status, plan upgrade/downgrade, usage-based metering layered over license entitlements. (Provider integration — e.g. Stripe — TBD.)
- **Where:** new `app/(panel)/billing`; new backend `billing/` module.
- **Acceptance:** View a tenant's plan, invoices, and change plan; usage metered.

**4.2 Notifications / alerts center**
- **What:** In-app alert inbox (expiring licenses, quota breaches, infra alarms, failed jobs) + optional email digests; unread badge in topbar.
- **Where:** new `components/notifications/*`, backend events feed.
- **Acceptance:** Actionable alerts surfaced beyond toasts; mark-read persists.

**4.3 Announcement / broadcast**
- **What:** Platform-wide announcements pushed to tenant consoles (extend existing announcement-banner setting to scheduled/targeted broadcasts).
- **Where:** `platform-settings` + new broadcast targeting.
- **Acceptance:** Scheduled/targeted announcement reaches selected tenants.

### Phase 5 — Polish & scale

**5.1 Global command palette (Cmd/Ctrl+K)** — quick nav to any tenant/page/action.
**5.2 Global search** — tenants, users, audit from one bar.
**5.3 Consistent states & a11y** — unified empty/error/loading; keyboard nav; focus management; ARIA on tables/modals.
**5.4 Responsive audit** — panel usable on tablet; sidebar/drawer behaviour verified.
**5.5 Theming polish** — align tokens (`styles/theme.css`) with a documented palette; verify light/dark parity.

---

## 4. Suggested Sequencing

1. **Phase 0 + Phase 1** first — foundation and security (MFA gap is a real risk).
2. **Phase 2** — core admin depth (global users, platform RBAC, DB, tenant detail).
3. **Phase 3** — observability & analytics.
4. **Phase 4** — billing/analytics/notifications, driven by business need.
5. **Phase 5** — polish, continuous.

---

## 5. Cross-cutting Principles

- **Server stays authoritative** — client guards are UX; `require_superadmin` / platform-permission checks remain the security boundary.
- **Audit everything** — every mutation (tenant, license, user, impersonation, billing) writes to the cross-tenant audit log.
- **Least privilege** — move off the all-or-nothing super-admin flag (Phase 2.2).
- **Reuse from v2** — port proven patterns (UI kit, DataTable, forms, MFA wizard, sessions, http refresh, Superset) rather than reinventing.
- **Consistency** — one component kit, one table, one form stack, one set of states across the whole panel.

---

## 6. Key Reference Files

**v3 (target):**
- Service layer: `admin-frontend/src/lib/api.js`
- Sidebar/nav: `admin-frontend/src/app/(panel)/layout.jsx`
- Super-admin gate: `backend/core/app/tenancy/deps.py`
- Tenant CRUD: `backend/core/app/admin/router.py`
- RBAC catalog: `backend/core/app/auth/permissions.py`

**v2 (patterns to port):**
- UI kit: `frontend/src/components/super/ui.jsx`
- DataTable: `frontend/src/components/ui/data-table.jsx`
- MFA/sessions: `frontend/src/components/identity/*`
- HTTP + refresh: `frontend/src/lib/http.js`
- Superset BFF: `frontend/src/app/api/superset/*`
- DB backup: `frontend/src/app/(super)/super/database/page.jsx`
