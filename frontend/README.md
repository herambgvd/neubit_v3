# frontend — Neubit operator console

Next.js modular monolith on the shared Vercel-theme UI library (`web/`, vendored from
platform_base). Public landing at `/`, auth screens under `(auth)/`, the app under `(app)/`
(pages re-export from `@/web/pages/*`).

```
frontend/
├── app/            routes — page.jsx (landing) · (auth)/* · (app)/*
├── web/            shared UI library (theme, kit, pages, shell, api client) — @/web/*
├── views/          app-local views (Home dashboard)
├── menu.js         nav menu (permission-gated)
└── tailwind.config.js · next.config.js
```

Talks to the core over `/api/*` through Traefik (`NEXT_PUBLIC_API_URL`). Dev: `npm run dev`.

## Offline / air-gapped assets

The console loads **no** fonts, icons, CSS or JS from a CDN — it runs with the network cable
pulled. Fonts ship in the bundle (`geist`), the h265web decoder lives in `public/h265web/`, and
icons come from a committed Iconify bundle instead of `api.iconify.design`:

| file | what |
| --- | --- |
| `scripts/build-icon-bundle.mjs` | the only thing that talks to the Iconify API — a dev-time step |
| `src/lib/icons/icon-bundle.json` | the icons the app uses, committed |
| `src/lib/icons/index.js` | registers them at boot (imported by `Providers`) |
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
| style (Protomaps dark flavor) | generated in-process by `src/lib/map/index.js` | n/a — no style server |
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
