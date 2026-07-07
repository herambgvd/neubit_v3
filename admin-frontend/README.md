# admin-frontend — super-admin panel (separate app)

The vendor/operator console for managing the platform **across all tenants** — separate from
the per-tenant operator console (`frontend/`). Own Next.js app, own auth realm, own subdomain.

## Manages
- **Tenants** — create (→ provision per-tenant DB) · suspend · offboard · inspect.
- **Licenses** — issue/assign per-tenant Ed25519 licenses (tier · limits · expiry). Vendor
  signing key stays offline / in a separate signing service.
- **Feature access** — per-tenant module/feature entitlement (ties to core module registry
  + license).
- Cross-tenant audit/observability · plans/billing · support impersonation (audited) ·
  per-tenant branding.

## Backend
Cross-tenant APIs live in `core` under `/api/admin/*`, gated by a **separate super-admin
auth realm** (`aud=neubit-admin`) — a tenant user can never reach these. Operates only on
the control-plane DB, never per-tenant data.

## Frontend
Reuses the `platform_base` Vercel theme + kit (same as `frontend/`), but a distinct app +
routes + login. Deploy on a separate subdomain (e.g. admin.neubit.cloud); optionally
network-isolated.

> On-prem (single-tenant): this panel is minimal/absent — license is issued at install.
