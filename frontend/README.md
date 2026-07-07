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
