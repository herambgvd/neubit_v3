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

The one exception is Google Maps — the Sites map and "Fetch from address" load Google's JS API,
so they need internet by nature. Both are opt-in per tenant (a saved Maps key) and degrade to an
explanatory message when the script can't load; nothing else in the console is affected.
