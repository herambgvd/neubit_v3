# core

The identity service. Everything else in the estate authenticates against it: core
mints the JWT, and the satellites verify it locally with the shared `kernel` rather
than calling back. That relationship is the reason for most of what looks unusual
here — core is the only service the others cannot route around, and the only one
whose bugs are everyone's bugs.

**It is not the platform.** The previous version of this file listed workflow,
vision, gates, fire and octosense as things core owns. They are separate services
with their own databases and their own READMEs; core holds the identity, tenancy and
shared-configuration surfaces they all read from. If you came here looking for the
SOP engine or the VMS control plane, they are not in this directory.

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

Almost every one carries a nullable `tenant_id`. **NULL does not mean the same thing
on all of them**, and conflating the two meanings was a privilege escalation — see
below.

## The two meanings of a NULL tenant_id

On the CONFIG SINGLETONS — `app_settings`, `branding`, `channel_configs`,
`email_templates` — a NULL row is the platform DEFAULT that every tenant inherits
until it sets its own. Those surfaces resolve the fallback in their own service and
derive the WRITE scope from the caller rather than from the row.

On everything else — `users` above all — a NULL row is a PLATFORM row. On `users`
specifically it is the super-admin.

`tenancy/scope.py::owns()` used to return True for every NULL row, which meant any
tenant-admin holding `user.read` could fetch the super-admin by id and with
`user.manage` reset its password through `update_user`, revoking every session the
victim held. The tell was inside the same file: `scoped()` EXCLUDED NULL rows from a
listing while `owns()` admitted them by id, so a row was invisible in the list and
writable by id. They now apply the same predicate, and `tests/test_cross_tenant_matrix.py`
holds it across every tenant-owned surface (`36a7798`).

## Three credentials, one door

`auth/deps.py` resolves three kinds of caller and keeps them apart on purpose:

* **A person** — `get_current_user`. Resolves `sub` to a `users` row and refuses
  when there is none, so a key-derived token is a 401 here no matter how valid its
  signature. Do not teach it about API keys; "a service credential cannot open the
  UI" is enforced by this function not knowing what one is.
* **A service key** — `ApiKeyPrincipal`, shaped like the `User` the routes read, and
  no further. A route reaching for something only a person has raises AttributeError
  and 500s, which is the right failure: the alternative is inventing a plausible
  value and letting a machine credential walk a path written for a person.
* **A satellite service** — `require_service_permission`.

`require_permission` accepts a person or a key; where the permission list comes from
is the only difference. Permissions are always loaded FRESH from the role — the
`permissions` claim in the JWT exists for satellites, which have no `roles` table to
ask, and core ignores it.

## Layout

One package per subject under `app/`, each with its own `models` / `schemas` /
`service` / `router`. `app/core/` is the shared machinery (config, db, errors,
storage, secrets, audit, realtime, health) and `app/tenancy/` is the isolation
primitive every other package imports.

`app/auth/` carries two routers rather than one. `/auth/me`, `/login`, `/logout`,
`/refresh` and 2FA are self-service; `admin_router` holds the 22 routes that manage
users, roles, permissions and API keys, and exists as a separate object so it can
carry `require_tenant_active` while the self-service half does not. A suspended
tenant's user must still be able to sign in far enough to be told they are
suspended, and to sign out.

## Tests

182, all offline: no Postgres, no NATS, no SMTP. `./run-tests.sh` is the supported
path and its header explains why there is a script at all — a bare `pytest` on the
host has no dependencies installed, and a bare `pytest` in the running container is
missing the shared kernel that one contract test needs. It runs a throwaway
container from the core image with the tree mounted read-only.

```bash
./backend/core/run-tests.sh                       # everything
./backend/core/run-tests.sh tests/test_auth.py    # pytest args pass through
```

Four of them guard invariants rather than behaviour, and each exists because the
invariant had already been broken:

* `test_route_inventory.py` — every one of the 216 routes resolves a caller, or is
  listed with the reason it does not. Three separate un-gated routes shipped before
  this existed.
* `test_permission_catalog.py` — every `require_permission` literal in the whole of
  `backend/` names a key core can grant. Two entire products were wildcard-only.
* `test_tenant_erasure.py` — every table core owns is classified for tenant erasure,
  and a cascade claim is verified rather than trusted.
* `test_health_probes.py` — the gateway routes `/ready` and core's healthcheck
  consumes it. That one reads `gateway/` and `deploy/`, which `run-tests.sh` mounts
  for it: `/ready` was correct and unreachable for months precisely because no test
  could see those files.

## Things that will surprise you

**`app.routes` is not the routes.** This FastAPI version defers `include_router`, so
`app.routes` holds wrapper objects — 41 of them, against 216 real routes — and the
mount prefix lives on the wrapper while each route keeps its own unprefixed `.path`.
Any code scanning `app.routes` for a path is looking at the wrong list. That is not
theoretical: the legacy signed-licence `/features` route guarded itself by scanning
`app.routes`, found nothing, and registered an unauthenticated licence dump on every
boot — harmless only because the tenant-aware router happened to be included first
and matched first.

**A stored secret is tagged, and a failed decrypt RAISES.** Ciphertext is
`enc:v1:<token>`; a tagged value that will not decrypt raises `SecretDecryptionError`
rather than being returned, because handing the ciphertext back means an SMTP
password of `gAAAAAB…` reaches a mail server and the log says "authentication
failed". A value with no tag is a row written before encryption existed and passes
through unchanged — that leniency is scoped to exactly that case. Tenant-owned
secrets use a per-tenant key derived by HMAC from `VE_SECRETS_KEY`; platform rows use
the platform key. Read `1c41cde` before touching this.

**`/files/{key}` has no auth and that is deliberate.** Blob URLs are unguessable
uuid4 hex and the route is public so a browser can load an avatar. What makes it
safe is on both sides: uploads are whitelisted by content type AND by magic number
with the extension taken from the whitelist rather than the filename
(`core/uploads.py`), and serving picks the Content-Type from a whitelist — raster
images inline, SVG and PDF as `Content-Disposition: attachment`, everything else
opaque. It used to use `mimetypes.guess_type` on the key, which answers `text/html`
for a `.html` key, while the avatar route took its extension from the uploaded
filename. Report exports under `/files` are permanent capability URLs; that is a
known weakness, recorded in the route inventory rather than forgotten.

**`/health` cannot fail and `/ready` can.** `/health` is a static dict with no
dependency injected — it answers 200 with Postgres stopped. `/ready` asks the
database, redis and storage and answers 503 naming the one that failed. They are
different questions and one endpoint cannot mean both. `/metrics` is served but NOT
routed by the gateway: nothing scrapes it and it is an unauthenticated inventory of
every route in the platform.

**The gateway rule lives in two files and only one decides.**
`gateway/dynamic/routes.yml` defines a file-provider router named `core`; the compose
labels define a docker-provider router of the same name that it shadows. Editing the
labels alone changes nothing that reaches a request.

**`alembic revision --autogenerate` must come back EMPTY.** The one drift it ever
reported was a proposal to DROP the uniqueness `authenticate_api_key` depends on —
`api_keys.prefix` was `unique=True` in the migration and `index=True` on the model.
Declare indexes as `Index(...)` in `__table_args__`, not as `unique=True` on a
column: alembic compares constraints and indexes by kind, so a UniqueConstraint in
the model against a unique index in the database is reported as one dropped and one
added forever.

## Configuration

`VE_`-prefixed and shared with the rest of the estate through `deploy/.env` —
`VE_DATABASE_URL`, `VE_REDIS_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, `VE_SECRETS_KEY`.
Core-specific knobs live next to the code that reads them: `VE_STORAGE_BACKEND`,
`VE_STORAGE_LOCAL_DIR`, `VE_STORAGE_BASE_URL`, `VE_JWT_TTL_MINUTES`,
`VE_LOG_LEVEL`.

`migrate.sh`, not `alembic upgrade head` — the 0001 baseline is a `create_all()` of
the live metadata, so on a FRESH database the later deltas collide while on an
EXISTING one a blanket `stamp head` marks every unapplied migration done. The script
picks the branch per database; its header has the full reasoning.

See `../../docs/SERVICES.md` for where this sits in the estate.
