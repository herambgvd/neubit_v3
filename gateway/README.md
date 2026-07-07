# gateway — Traefik

Edge gateway. TLS termination, per-tenant routing, and auth via **ForwardAuth → core**.

- `traefik.yml` — static config (entrypoints, providers, TLS). Docker + file providers.
- `dynamic/middlewares.yml` — shared middlewares: `forward-auth`, `strip-identity`,
  `sec-headers`, `rate-limit`, and the `api-protected` chain.

## How routing works

Services declare their own routes via **Docker labels** (see `deploy/docker-compose.yml`),
so adding a service needs **no gateway edit** — Traefik discovers it. Example labels:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.gates.rule=PathPrefix(`/api/access`)
  - traefik.http.routers.gates.middlewares=api-protected@file
  - traefik.http.services.gates.loadbalancer.server.port=8000
```

## Auth model

`api-protected` chain runs on every `/api/*` route except the public auth endpoints:
1. `strip-identity` clears any client-supplied `X-User-*` / `X-Tenant-Id` headers.
2. `forward-auth` calls `core` `/internal/auth/verify`; core validates the JWT, resolves the
   tenant, and returns `X-User-Id`, `X-User-Role`, `X-Tenant-Id`, `X-Permissions`.
3. Traefik injects those trusted headers downstream. Services trust only these.

This replaces v2's Kong + custom Lua JWT plugin with a Go-native ForwardAuth to `core`.
