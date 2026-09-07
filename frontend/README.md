# frontend — Neubit operator console

The per-tenant operator console: video, access control, incidents and workflow, ingest,
analytics and the platform's own settings. Separate from the vendor super-admin panel
(`admin-frontend/`), which is a different app with its own auth realm.

- **Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (`strict`) · Tailwind ·
  TanStack Query · MapLibre GL · Vitest + Testing Library.
- **Served at** `http://<host>/` through the gateway; the API is same-origin at `/api/v1`.

```
frontend/src/
├── app/            routes only — (app)/*, (auth)/*, impersonate/, wall-display/
├── features/       one directory per domain: vms, access, workflow, ingest, core,
│                   videowall, security, bi — each with api.ts, types.ts, components/, hooks/
├── components/     cross-feature UI: ui/kit.tsx, common/, shell/, console/, floor-builder/
├── lib/            api client, auth, wire types, formatting, icons, map, desktop bridge
└── test/           setup + the tree-level guards (naming.test.ts)
```

A route file under `app/` holds no logic: it renders the screen its feature exports. Anything
shared by two features belongs in `components/` or `lib/`, never imported feature-to-feature.

## Scripts

| script | what |
| --- | --- |
| `npm run dev` / `build` / `start` | Next dev server / production build / serve the build |
| `npm run typecheck` | `tsc --noEmit` — the project is `strict: true` and at zero errors |
| `npm run lint` | ESLint 9 flat config (`eslint .`) — **not** `next lint`, which Next 16 removed |
| `npm test` | Vitest (jsdom) |
| `npm run check` | all three, in that order — run it before pushing |
| `npm run icons` / `icons:check` | rebuild / audit the offline icon bundle (see below) |
| `npm run map:assets` / `map:tiles` / `map:gazetteer` / `map:verify` | offline basemap assets (see below) |

## Auth — the model this console rests on

The **access token lives only in memory** (a module variable in `src/lib/api.ts`) and rides as a
`Bearer` header. It is never written to `localStorage`, `sessionStorage` or a cookie, so an XSS
cannot exfiltrate a durable credential. The **refresh token is the httpOnly `nb_refresh` cookie**
the backend has always set at login (`backend/core/app/auth/cookies.py`), scoped to the `/auth`
path and invisible to JavaScript.

Consequences worth knowing before changing anything in `lib/api.ts`:

- On a hard reload the in-memory token is gone, so the first call 401s and self-heals from the
  cookie. That 401 is expected, not a fault.
- `/auth/refresh` is a **session probe**: it answers `200` with a null token when there is no
  session, so a signed-out visitor produces zero failing requests.
- Concurrent 401s share a single refresh (single-flight), and a request is retried at most once.
- `/auth/login`, `/auth/login/mfa`, `/auth/refresh` and `/auth/logout` are never themselves
  retried — a 401 there means the session is genuinely gone.
- An impersonation session (opened from the super-admin panel) is **access-only by design**: the
  panel mints no refresh token for it, so it ends when the tab is reloaded. Re-open it from the
  panel; every impersonation is audited.

The server is authoritative for everything. `can()` and `hasModule()` from `lib/auth.tsx` decide
what the console *renders*; they are a UX affordance over the backend's permission and
entitlement checks, never a substitute.

## Types

Every screen is typed against the backend. `src/lib/types.ts` holds the wire types shared across
features and each feature has its own `types.ts` for the rest — one interface per Pydantic model,
with the backend file named in a comment. Dates cross the wire as ISO strings, so they are typed
`string`, never `Date`.

This is load-bearing rather than decorative: turning `strict` on found eight fields the UI read
or sent that the API does not have — a site picker keyed on `id` instead of `site_id` (so the
chosen site was never saved), door lists keyed on a v2 `door_id` (so access groups persisted
arrays of `undefined`), report columns reading `actions` where the backend sends `total_actions`.
None of them threw; they simply rendered nothing.

## Testing

409 tests. They live beside what they cover (`Component.test.tsx` next to `Component.tsx`) plus
`src/test/` for the helpers and the tree-level guards. Each was verified by breaking the thing it
guards and watching that test — and only that test — go red. A test nobody has seen fail is not
yet a test.

What the suite is actually for:

- **The token model** (`lib/api.test.ts`, `lib/auth.test.tsx`) — storage, single-flight refresh,
  retry-once, the endpoints that must never be retried, and that the session comes back from the
  cookie after a reload.
- **A failed load is never an empty result.** Every list screen must report the error; "No users
  yet" while the user service is down is a lie about the data. This was wired on six screens that
  had the branch and never passed anything to it.
- **Destructive actions are gated.** Deleting a user, role, site, tag, SOP, trigger, NVR, recorder,
  wall or access group, revoking a card or a federation credential: the API must not be called
  until the operator confirms.
- **Request bodies match the contract.** Several bugs found here were fields the UI sent that the
  API forbids, or omitted that it requires — so the create/edit tests assert the body, not the
  click.
- **The selection derivation.** These screens derive `selectedId ?? filtered[0]?.id` instead of
  syncing selection in an effect; the tests pin that an explicit choice survives a refetch.
- **The stream hooks and player sessions** at their seam — retry when there is no token yet,
  close on unmount, cap the buffer, release the session, recover from a failed renew.
- **`asItems`** on all four input shapes, with `expectTypeOf` assertions that fail the *typecheck*
  if the element type ever collapses to `unknown[]` again.
- **The tree itself** (`src/test/naming.test.ts`) — the naming rules below, walked at run time.

## Known gaps

Recorded rather than implied, so nobody has to rediscover them:

- **No CI.** Nothing runs `npm run check` automatically — the repo has no `.github/workflows`. Run
  it by hand before pushing.
- **Nothing here talks to a real backend.** Every test stubs the axios adapter or the api module,
  so the types are the only thing holding the console to the backend's contract, and they are
  hand-written from the Pydantic models rather than generated. The super-admin panel has a
  contract test that reads those models at run time; this console does not yet.
- **No end-to-end test.** Nothing exercises a real login against a running `core`.
- **Coverage is deliberately uneven.** One worked example of each pattern (list, master-detail,
  modal form, event feed) is covered rather than a thin pass over every screen. `Streaming.tsx`,
  the map, the SOP designer canvas, the security write paths and roughly half the workflow and
  access tabs have no tests of their own.
- **~100 `react-hooks/set-state-in-effect` warnings.** All one shape: a component seeding local
  state from props or server data. With `refetchOnWindowFocus: false` these do not clobber
  operator input, so they are not defects — they stop the React Compiler memoizing those
  components. Clearing them means splitting ~89 forms into children mounted from their record,
  which is a deliberate refactor with tests behind it. The eslint config says so at the rule.
- **Four screens export a component whose name their filename does not contain** (e.g.
  `IncidentList.tsx` → `WorkflowPage`). Frozen in `KNOWN_EXPORT_NAME_MISMATCHES` in the naming
  test: the existing four are grandfathered, a new one fails.

## Offline / air-gapped assets

The console loads **no** fonts, icons, CSS or JS from a CDN — it runs with the network cable
pulled. Fonts ship in the bundle (`geist`), the h265web decoder lives in `public/h265web/`, and
icons come from a committed Iconify bundle instead of `api.iconify.design`:

| file | what |
| --- | --- |
| `scripts/build-icon-bundle.mjs` | the only thing that talks to the Iconify API — a dev-time step |
| `src/lib/icons/icon-bundle.json` | the icons the app uses, committed |
| `src/lib/icons/index.ts` | registers them at boot (imported by `Providers`) |
| `src/styles/scss/_icon-assets.scss` | data: URIs for the icons SCSS draws with `content: url()` |

Added a new `<Icon icon="…" />`? Run `npm run icons` (needs network) and commit the regenerated
bundle. `npm run icons:check` audits coverage offline and fails if a name isn't bundled.

## Offline map

The Sites map runs on a **self-hosted OpenStreetMap basemap** by default — MapLibre GL over a
PMTiles world archive served from this deployment. No tile server, no API key, no internet.
Google Maps is still there as an opt-in alternative: turn on *Platform Settings → Google Maps*
and save a key, and the Sites map and "Fetch from address" switch to it. Whichever provider is
off never ships its SDK — both canvases are code-split.

| piece | where | committed? |
| --- | --- | --- |
| style (Protomaps dark flavor) | generated in-process by `src/lib/map/index.ts` | n/a — no style server |
| label glyphs + POI sprites (17 MB) | `public/map/`, via `npm run map:assets` | yes |
| world vector tiles (0.5–17 GB) | `deploy/tiles/planet.pmtiles` | **no** — the `tiles` service builds it on first start |
| tile server | `tiles` service (deploy/tiles-server/), routed at `/tiles` in `gateway/dynamic/routes.yml` | n/a |

### Getting the basemap — nothing to run

`docker compose up` provisions it. The `tiles` service (deploy/tiles-server/) ships nginx plus the
pmtiles CLI: on first start, if `deploy/tiles/` holds no archive, it extracts one in the
background and serves it when it lands. nginx answers from the first second either way, so
nothing blocks on the download; until the archive appears the map shows its "basemap not
installed" panel and the rest of the console is unaffected.

The full Protomaps planet is z0–15 / 137 GB, so only the zoom levels you ask for are extracted,
over HTTP range requests. MapLibre overzooms past the archive's max zoom — you can still zoom in,
the geometry just stops gaining detail. For a map of site pins, z10 is plenty.

| `TILES_MAXZOOM` | size | reads down to |
| --- | --- | --- |
| 8 | 543 MB | countries, major cities |
| 10 *(default)* | 3.7 GB | cities, town names, motorways |
| 12 | 17 GB | suburbs, main street network |
| 15 | 137 GB | individual buildings |

Set it in `deploy/.env` before the first `up`. `TILES_AUTO_PROVISION=0` turns the download off
entirely — the air-gapped setting, where you build the archive elsewhere and drop it in.

To build one by hand (on a networked machine, to carry to an air-gapped host):

```bash
npm run map:tiles -- --dry-run          # size estimate, downloads nothing
npm run map:tiles -- --maxzoom=12
```

Either way, check the result end to end:

```bash
npm run map:verify -- --base=http://your-host
```

That asserts the archive is served with working range requests, contains every source-layer the
style draws, and that the glyphs and sprites resolve.

For `npm run dev` outside compose there is no Traefik or nginx, so drop the archive at
`frontend/public/tiles/planet.pmtiles` instead — gitignored and dockerignored, so it can never
reach a commit or an image.

### maplibre-gl is pinned to v5

Not an accident, and not safe to bump. Under maplibre-gl v6 the pmtiles protocol never produces a
source cache: the map builds, the sprite loads, then `isStyleLoaded()` stays false forever — no
tile requests, no error event, just a blank canvas. pmtiles 4 and @protomaps/basemaps 5 both
predate v6. If you raise the major, re-run `npm run map:verify` *and* open a real map.

### Coordinates without a geocoder

Google's geocoder has no offline equivalent worth its cost (self-hosted Nominatim means a full OSM
import — tens of GB and a second Postgres — to serve a few dozen sites). So with Google Maps off,
the site form swaps "Fetch from address" for **Pick on map**: click the basemap, the pin's
latitude and longitude fill into the form.

Clicking is only reasonable if you can *get* to the right place first, so the picker has a search
box over the canvas. It takes three kinds of query, in this order of preference:

**1. A full address** — "Star Tower Sector 30 Gurgaon". Answered by the `geocoder` service:
[Photon](https://github.com/komoot/photon) over a prebuilt OpenStreetMap index, routed at
`/geocode`. **Nothing leaves the box** — the index is a file on disk, so this works air-gapped and
costs nothing per query. That is why it is here instead of a call to Google or the public Nominatim,
neither of which can be self-hosted (Google) or used at volume (Nominatim's usage policy), and both
of which would send every site's address off the deployment.

The index is per country. `GEOCODER_COUNTRY` picks it (default `in`); graphhopper publishes one per
ISO code, and the whole planet is available too at ~75 GB. India is a 780 MB download that unpacks
to a few GB. The container provisions itself on first start, so `docker compose up` is the whole
instruction; set `GEOCODER_AUTO_PROVISION=0` and drop `photon.jar` + `photon_data/` into
`deploy/geocoder/` for an air-gapped host.

A house or a street result **drops the pin** — it is the exact point, which is what the service is
for. A coarser result (a city, a district) only *flies* the map, because a city centre is not a site.

**2. A city** — matched against `public/map/gazetteer.tsv`, built by `npm run map:gazetteer` from
GeoNames `cities15000` (CC BY 4.0; ~34k places, 1.9 MB, about 800 KB on the wire) and committed for
the same reason the glyphs are. This is the **fallback**, so the picker still works before the index
is provisioned, or on a deployment that chooses not to run it.

It carries alternate names, which is why *Gurgaon* finds Gurugram, *Bombay* finds Mumbai and
*Bangalore* finds Bengaluru. Those come from a separate 204 MB `alternateNamesV2` download at build
time — the `alternatenames` column inside `cities15000` is an unmarked alphabetical list of every
transliteration, and taking the first few ASCII entries gives Mumbai "Asumumbay, BOM, Bombai,
Bombaim, Bombaj" and stops one short of the only one anybody types.

Given a full address it cannot match, it retries the **trailing phrases** — "sector 30 gurgaon",
"30 gurgaon", "gurgaon" — longest first, so a Connaught Place address lands on New Delhi and not on
Delhi. It gets you to the town; the last mile stays a click.

**3. A pasted coordinate** — `28.6139, 77.2090`, and the forms people actually paste (space or
slash instead of a comma, a stray `°`). That one is the exact point, so it drops the pin, and it
looks nothing up at all.

`npm run map:gazetteer:check` verifies the city list offline, like `map:assets:check`.

## File naming

Enforced by `src/test/naming.test.ts` — it walks `src/` and fails with the offending path, so
this is not a style suggestion.

| kind | format | example |
| --- | --- | --- |
| React component | `PascalCase.tsx`, named after the component it exports | `FloorPlanEditor.tsx` |
| Hook | `useThing.ts` | `useLiveSession.ts` |
| Other module (api, utils, types, config, constants) | `camelCase.ts` | `api.ts`, `wallLayout.ts` |
| Next.js route file | whatever Next mandates, only under `src/app/` | `page.tsx`, `layout.tsx`, `not-found.tsx`, `route.ts` |
| Directory | `kebab-case` (plus Next's `(group)` and `[param]`) | `floor-builder/`, `(app)/`, `[id]/` |
| Test | beside its subject, same stem | `CameraGrid.test.tsx` |

Two deliberate exceptions, both checked by the test rather than waived by hand:

- A `.tsx` that exports **several** components is a collection named for the group, in camelCase
  (`ui/kit.tsx`), and one that exports a component **alongside other values** is a mixed module
  named for its domain (`lib/auth.tsx` — `AuthProvider` + `useAuth`). Only a file that is nothing
  but one component must carry that component's name.
- A `.tsx` that exports no component at all (`ApiKeyColumns.tsx`, a column builder that happens to
  return JSX) is a module, and is not forced into either case.

A handful of screens predate the convention and export a name their filename does not contain
(`IncidentList.tsx` → `WorkflowPage`). They are frozen in `KNOWN_EXPORT_NAME_MISMATCHES` in the
test: existing ones are grandfathered, a new one fails the suite.
