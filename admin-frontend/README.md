# admin-frontend — Neubit super-admin panel

The vendor/operator console for managing the platform **across all tenants** — separate from
the per-tenant operator console (`frontend/`). Own Next.js app, own auth realm, own subdomain.

- **Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) · Tailwind 3 ·
  TanStack Query + Table · Radix primitives · axios · Vitest + Testing Library.
- **Source:** `src/app` (routes) · `src/components` (kit + shells) · `src/lib` (API client, types, hooks).

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
npm run check          # typecheck + lint + tests — run this before pushing
```

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev server / production build / serve the build |
| `npm run typecheck` | `tsc --noEmit` over the whole app |
| `npm run lint` | ESLint 9 flat config (`eslint .`) — **not** `next lint`, which Next 16 removed |
| `npm test` | Vitest (jsdom) |
| `npm run check` | all three, in that order |

In the stack the panel is not published on a host port: the gateway serves it at
**http://admin.localhost** (a host-rule route at priority 50 — see `gateway/dynamic/routes.yml`),
which is what keeps `NEXT_PUBLIC_API_URL` empty and the refresh cookie first-party.

## Auth — the model this console rests on

The **access token lives only in memory** (a module variable in `src/lib/api.ts`) and rides as a
`Bearer` header. It is never written to `localStorage`, `sessionStorage` or a cookie, so an XSS
cannot exfiltrate a durable credential. The **refresh token is an httpOnly cookie** the browser
sends automatically to `/auth/refresh`; JavaScript cannot read it.

Consequences worth knowing before changing anything here:

- On a hard reload the in-memory token is gone, so the first call 401s and self-heals from the
  cookie. That 401 is normal, not a bug.
- `/auth/refresh` is a **session probe**: it answers `200` with a null token when there is no
  session, so a signed-out visitor produces zero failing requests.
- Concurrent 401s share a single refresh call (single-flight), and a request is retried at most once.
- `/auth/login` and `/auth/refresh` are never themselves retried — a 401 there means the session
  is genuinely gone.

`src/lib/api.test.ts` pins every one of those as a test, and `src/test/structure.test.ts` fails the
build if any source file starts storing something token-shaped in browser storage.

> The operator console (`frontend/`) still keeps its refresh token in `localStorage`. That is a
> known difference, not a pattern to copy — this app's model is the target one.

## Access control

`useRequireSuperadmin` gates the whole `(panel)` route group in the browser, but it is a UX
affordance only: **the server's `require_superadmin` is authoritative**. Every `/api/v1/admin/*`
route is gated by a separate super-admin auth realm (`aud=neubit-admin`) in `core`, so a tenant
user can never reach these endpoints regardless of what the UI renders.

## What it manages

- **Tenants** — create (provisions a per-tenant DB) · suspend · reactivate · delete · impersonate
  (audited, opens the operator console in a new tab with an access-only token).
- **Licenses & entitlements** — per-tenant plan, feature toggles (driven by the platform module
  catalog, laid out to mirror the operator console's own navigation), numeric quotas, expiry and
  grace days.
- **Users** — cross-tenant directory, enable/disable.
- **Modules** — the platform feature catalog tenants inherit.
- **Billing** — plans, per-tenant subscriptions, invoices (internal records; no payment gateway).
- **Broadcasts** — scheduled, targeted announcements shown in tenant consoles.
- **Alerts** — derived platform signals (expiring licenses, quota breaches, overdue invoices).
- **Audit** — cross-tenant trail, filterable by tenant.
- **Infrastructure** — live container fleet (state, CPU/memory, trends, logs, restart/stop/start),
  proxied through `core` to `ops-agent`.
- **Database** — control-DB export and restore.
- **Platform settings & branding** — defaults every tenant inherits.

## Types

`src/lib/types.ts` mirrors the Pydantic response models in `backend/core` (and `ops-agent` for the
infrastructure payloads); each block names its counterpart file. Dates cross the wire as ISO-8601
strings, so they are typed `string`, not `Date`. `src/lib/api.ts` returns those types, so a rename
on the backend surfaces here as a type error rather than as `undefined` on screen.

Two list endpoints may answer with either the paginated envelope or a bare array; `src/lib/paged.ts`
is the single place that difference is handled.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | *(empty — same origin)* | API base. Empty keeps the refresh cookie first-party and needs no per-host rebuild. |
| `NEXT_PUBLIC_OPERATOR_URL` | `http://localhost` | Where impersonation opens the operator console. |
| `NEXT_DEV_ORIGINS` | — | Extra dev origins for Next 16's `/_next/*` origin check (comma-separated). |

## Testing

295 tests. They live beside what they cover (`src/lib/*.test.ts`, `src/app/**/page.test.tsx`,
`src/components/**/*.test.tsx`) plus `src/test/` for the tree-level and cross-repo guards. Each is
written to fail for a reason, and each was verified by breaking the thing it guards:

- the token model (storage, refresh, retry, single-flight) — `src/lib/api.test.ts`
- the super-admin gate, including the signed-in-but-not-super-admin case — `src/lib/useRequireSuperadmin.test.tsx`
- `DataTable`'s loading / empty / error states, which are easy to conflate — `src/components/ui/data-table.test.tsx`
- kit behaviour that prevents real mistakes (a loading button cannot double-submit; an error hides
  the hint) — `src/components/ui/kit.test.tsx`
- every route component renders, with the emphasis on gates: a restore needs the word typed, a
  stop/void/delete/logout needs a confirm, disabling a user needs one and re-enabling does not, and
  validation runs before anything reaches the network
- **the wire contract** — `src/test/contract.test.ts` reads the Pydantic models out of `backend/`
  and compares them to `src/lib/types.ts`: no invented field, no missing required field, and `null`
  admitted wherever the model admits `None`. The infrastructure payloads are checked against the
  dict literals `ops-agent` actually builds. This is the test that would have caught the two bugs
  the conversion found by hand, and it fails when the backend changes under it
- the SVG chart geometry — arc lengths and offsets, bar scaling, axis spans — because a chart can
  be visibly wrong while rendering perfectly well

## Known gaps

Recorded rather than implied, so nobody has to rediscover them:

- **No CI.** Nothing runs `npm run check` automatically — the repo has no `.github/workflows`. Run
  it by hand before pushing.
- **Nothing here talks to a real backend.** Every test mocks `adminApi`, so the contract test above
  is what stands between a backend field rename and a silent `undefined` on screen — and it compares
  against the models *in this repo*, not against whatever a deployed core is serving.
- **No end-to-end test.** Nothing exercises a real login against a running `core`.
- **The infrastructure page polls** every 4s (logs every 3s) whenever it is open. That is by design
  for a fleet view but it is not free.
- **One lint warning is permanent.** `react-hooks/incompatible-library` on `useReactTable` — the
  React Compiler cannot memoize TanStack Table's return value. It is the library's shape, not ours.
- **`scaleService` is wired up but the backend answers 501** — there are no stateless worker
  services to scale yet. The UI reports the refusal instead of pretending it worked.

## Deploy

`output: "standalone"` (see `Dockerfile`). Deploy on a separate subdomain (e.g.
`admin.neubit.cloud`); optionally network-isolated. Security response headers are set in
`next.config.js` as defence-in-depth — the authoritative CSP belongs at the reverse proxy, where the
real domain is known.

> On-prem (single-tenant): this panel is minimal/absent — the license is issued at install time.
