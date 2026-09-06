# core

The identity service. Everything else in the estate authenticates against it: core
mints the JWT, and the satellites verify it locally with the shared `kernel` rather
than calling back.

It is not the platform. Workflow, vision, gates, fire and octosense are separate
services with their own databases and READMEs. Core holds the identity, tenancy and
shared-configuration surfaces they all read from.

Control-plane service on the `edge` core. REST behind Traefik under `/api/v1/...`;
cross-domain traffic is NATS events, never HTTP.

## What it owns

Thirty-five tables in `neubit_control`. Nothing else writes them.

| | |
|---|---|
| `users`, `roles`, `api_keys`, `refresh_tokens`, `password_reset_tokens` | who can sign in, as what, and with which credential |
| `tenants`, `app_settings`, `branding`, `modules` | the tenant register and the per-tenant configuration singletons |
| `sites`, `floors`, `zones`, `device_placements`, `tags`, `tag_links` | the estate: where things are, and the labels across them |
| `security_policies`, `directory_configs`, `sso_configs`, `dual_auth_requests` | 2FA enforcement, LDAP/AD, OIDC, four-eyes |
| `channel_configs`, `email_templates`, `notifications`, `device_tokens`, `broadcasts` | how a message reaches a person |
| `audit_log`, `report_jobs`, `alert_states`, `permission_registrations` | the trail, exports, alert de-duplication, satellite-registered permission keys |
| `billing_plans`, `billing_subscriptions`, `billing_invoices` | commercial state |
| `site_emission_factors`, `site_tariff_slabs`, `device_brands`, `dashforge_embeds` | operator assertions and registry rows other services read |

Almost every one carries a nullable `tenant_id`, and NULL does not mean the same
thing on all of them — see below.

## The two meanings of a NULL tenant_id

On the config singletons — `app_settings`, `branding`, `channel_configs`,
`email_templates` — a NULL row is the platform default every tenant inherits until
it sets its own. Those surfaces resolve the fallback in their own service and derive
the write scope from the caller, not from the row.

On everything else — `users` above all — a NULL row is a platform row. On `users`
specifically it is the super-admin.

`tenancy/scope.py::owns()` and `scoped()` must apply the same predicate. When they
did not, `owns()` admitted NULL rows by id while `scoped()` excluded them from
listings, so any tenant-admin with `user.manage` could reset the super-admin's
password by id. `tests/test_cross_tenant_matrix.py` holds this across every
tenant-owned surface.

## Three credentials, one door

`auth/deps.py` resolves three kinds of caller and keeps them apart on purpose:

* **A person** — `get_current_user`. Resolves `sub` to a `users` row and refuses
  when there is none, so a key-derived token is a 401 here no matter how valid its
  signature. Do not teach it about API keys; "a service credential cannot open the
  UI" is enforced by this function not knowing what one is.
* **A service key** — `ApiKeyPrincipal`, shaped like the `User` the routes read, and
  no further. A route reaching for something only a person has raises AttributeError
  and 500s, which is the right failure — better than inventing a plausible value and
  letting a machine credential walk a path written for a person.
* **A satellite service** — `require_service_permission`.

`require_permission` accepts a person or a key; only the source of the permission
list differs. Permissions are always loaded fresh from the role. The `permissions`
claim in the JWT exists for satellites, which have no `roles` table to ask, and core
ignores it.

## Layout

One package per subject under `app/`, each with its own `models` / `schemas` /
`service` / `router`. `app/core/` is the shared machinery (config, db, errors,
storage, secrets, audit, realtime, health) and `app/tenancy/` is the isolation
primitive every other package imports.

`app/auth/` carries two routers rather than one. `/auth/me`, `/login`, `/logout`,
`/refresh` and 2FA are self-service; `admin_router` holds the 22 routes that manage
users, roles, permissions and API keys, and is a separate object so it can carry
`require_tenant_active` while the self-service half does not — a suspended tenant's
user must still be able to sign in far enough to be told they are suspended, and to
sign out.

## Tests

341, all offline: no Postgres, no NATS, no SMTP. `./run-tests.sh` is the supported
path; its header explains why the script exists. It runs a throwaway container from
the core image with the tree mounted read-only.

```bash
./backend/core/run-tests.sh                       # everything
./backend/core/run-tests.sh tests/test_auth.py    # pytest args pass through
```

Four guard invariants rather than behaviour:

* `test_route_inventory.py` — every one of the 216 routes resolves a caller, or is
  listed with the reason it does not.
* `test_permission_catalog.py` — every `require_permission` literal in `backend/`
  names a key core can grant.
* `test_tenant_erasure.py` — every table core owns is classified for tenant erasure,
  and a cascade claim is verified rather than trusted.
* `test_health_probes.py` — the gateway routes `/readyz` and core's healthcheck
  consumes it. It reads `gateway/` and `deploy/`, which `run-tests.sh` mounts for it.

## Things that will surprise you

**`app.routes` is not the routes.** This FastAPI version defers `include_router`, so
`app.routes` holds wrapper objects — 41 of them, against 216 real routes — and the
mount prefix lives on the wrapper while each route keeps its own unprefixed `.path`.
Code scanning `app.routes` for a path is looking at the wrong list; the legacy
signed-licence `/features` route did exactly that and registered an unauthenticated
licence dump on every boot.

**A stored secret is tagged, and a failed decrypt raises.** Ciphertext is
`enc:v1:<token>`; a tagged value that will not decrypt raises `SecretDecryptionError`
rather than being returned, because handing the ciphertext back sends an SMTP
password of `gAAAAAB…` to a mail server. A value with no tag predates encryption and
passes through unchanged — that leniency is scoped to exactly that case.
Tenant-owned secrets use a per-tenant key derived by HMAC from `VE_SECRETS_KEY`;
platform rows use the platform key.

**`/files/{key}` has no auth, deliberately.** Blob URLs are unguessable uuid4 hex and
the route is public so a browser can load an avatar. Safety comes from both sides:
uploads are whitelisted by content type and by magic number, with the extension taken
from the whitelist rather than the filename (`core/uploads.py`), and serving picks the
Content-Type from a whitelist — raster images inline, SVG and PDF as
`Content-Disposition: attachment`, everything else opaque. Do not go back to
`mimetypes.guess_type` on the key: it answers `text/html` for a `.html` key.

Report exports are the exception: keys under `signed_url_prefixes` carry `?exp=&sig=`
and are refused without an unexpired HMAC. Without it a download link outlives the
`report.export` permission that produced it.

**`/health` cannot fail and `/readyz` can.** `/health` is a static dict with no
dependency injected — it answers 200 with Postgres stopped. `/readyz` asks the
database, redis and storage and answers 503 naming the one that failed. `/metrics` is
served but not routed by the gateway: nothing scrapes it, and it is an
unauthenticated inventory of every route in the platform.

**The gateway rule lives in two files and only one decides.**
`gateway/dynamic/routes.yml` defines a file-provider router named `core`; the compose
labels define a docker-provider router of the same name that it shadows. Editing the
labels alone changes nothing that reaches a request.

**`alembic revision --autogenerate` must come back empty.** Declare indexes as
`Index(...)` in `__table_args__`, not as `unique=True` on a column: alembic compares
constraints and indexes by kind, so a UniqueConstraint in the model against a unique
index in the database is reported as one dropped and one added forever. That drift
once proposed dropping the uniqueness `authenticate_api_key` depends on.

## Known gaps

* The broker grant for this service is scoped per subject, but `$JS.API.>` is
  granted whole — stream DELETE and PURGE are denied and consumer operations are
  not scopable per durable. See `backend/kernel/README.md` for why.
* `/readyz` answers 503 without a database, Redis or storage, which is correct and
  means it cannot be used as a liveness signal. `gateway/dynamic/routes.yml` must
  route it or nothing probes it at all.

## Configuration

`VE_`-prefixed and shared with the rest of the estate through `deploy/.env` —
`VE_DATABASE_URL`, `VE_REDIS_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, `VE_SECRETS_KEY`.
Core-specific knobs live next to the code that reads them: `VE_STORAGE_BACKEND`,
`VE_STORAGE_LOCAL_DIR`, `VE_STORAGE_BASE_URL`, `VE_JWT_TTL_MINUTES`,
`VE_LOG_LEVEL`.

Use `migrate.sh`, not `alembic upgrade head` — the 0001 baseline is a `create_all()`
of the live metadata, so on a fresh database the later deltas collide, while on an
existing one a blanket `stamp head` marks every unapplied migration done. The script
picks the branch per database; its header has the full reasoning.

See `../../docs/SERVICES.md` for where this sits in the estate.
