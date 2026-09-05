# Service API keys — how a peer product authenticates to NeuBit

> Status: the facility landed 2026-09-05. **No peer has been moved onto it yet.**
> DashForge still holds a NeuBit password at the time of writing; migrating it is
> a separate commit in a separate repo, and this document is what that commit is
> written against.

## The problem this replaces

DashForge reads NeuBit's BI data through `POST /api/v1/bi/query`. It
authenticates with `NEUBIT_BI_USER` / `NEUBIT_BI_PASSWORD` — a service account's
real email and password, encrypted at rest and exchanged for a 12-hour access
token. Its own connector explains why, and correctly blames NeuBit:

> NeuBit has no API-key facility — `kernel.auth.verify_token` accepts only an
> access JWT minted by core's `/auth/login`

A password is the wrong credential for a machine in four specific ways, and none
of them can be fixed at the far end:

| | with a password | with a service key |
|---|---|---|
| can open the console UI | **yes** | no — `sub` is not a user, the interactive path 401s |
| can be narrowed to "read BI" | no — it is whatever the account is | yes — an explicit scope list |
| can be revoked on its own | no — you disable the account | yes — one row, no account touched |
| distinguishable in the audit trail | no | yes — `actor_type='apikey'` |

## What a key is

A string, `nbk_<8 hex id>_<43 char secret>`, shown **once** at creation and
stored only as `sha256(whole key)`. The `nbk_<id>` prefix is a dedicated
non-secret segment — it is printed in every listing and is the handle an operator
uses to recognise a key, so it deliberately contains none of the secret.

A key carries:

- **`scopes`** — a flat list of permission keys from the same catalog roles draw
  from (`backend/core/app/auth/permissions.py`). Not a role: a role is a living
  set and every key wearing one would silently widen when someone widens the
  role. The wildcard `*` is refused, and so is any scope the *creating operator*
  does not themselves hold.
- **`expires_at`** — set by the operator. Optional, but it is a choice they make
  rather than one they get by not thinking about it.
- **`revoked_at` / `is_active`** — revocation, independent of any user.
- **`last_used_at`** — stamped on each exchange, so a forgotten key is visible.
- **`tenant_id`** — a key always belongs to exactly one tenant and is never a
  super-admin. The cross-tenant `/admin` API is closed to it at the token-audience
  level as well as by its scopes.

## Adopting it — three requests

### 1. An operator creates the key (once, by hand)

Requires `apikey.manage`.

```
POST /api/v1/auth/api-keys
Authorization: Bearer <an operator's access token>

{ "name": "DashForge BI reader",
  "description": "dashforge prod, workspace 4",
  "scopes": ["bi.read"],
  "expires_at": "2027-09-05T00:00:00Z" }
```

The response is the only place the secret ever appears:

```json
{ "id": "...", "name": "DashForge BI reader", "prefix": "nbk_a1b2c3d4",
  "scopes": ["bi.read"], "key": "nbk_a1b2c3d4_XXXXXXXX..." }
```

`GET /api/v1/auth/api-keys` lists keys and never returns `key` again.
`DELETE /api/v1/auth/api-keys/{id}` revokes one.

### 2. The peer exchanges it for an access token

```
POST /api/v1/auth/token        (no Authorization header — the key IS the credential)

{ "api_key": "nbk_a1b2c3d4_XXXXXXXX..." }

→ 200 { "access_token": "...", "token_type": "bearer",
        "expires_in": 900, "scopes": ["bi.read"] }
```

Every failure — malformed, unknown, wrong secret, revoked, expired — is `401`
with the identical message `invalid API key`, so the endpoint cannot be used to
learn which keys exist. It is rate-limited per client IP, on its own budget so it
and human logins cannot starve each other.

### 3. The peer uses the token exactly as it uses a login token today

```
POST /api/v1/bi/query
Authorization: Bearer <access_token>
```

**Nothing else changes.** The exchange returns an ordinary access token, claim
for claim, so every service authorizes a key with the code it already runs —
`kernel.auth.verify_token` was not modified for this and no satellite was
touched. For a peer this means the migration is: replace the `/auth/login` call
with the `/auth/token` call, keep everything downstream.

## What a peer must change, concretely

For DashForge (`backend/internal/connectors/neubit.go`), the whole change is in
`neubitSession` and its login helper:

- store one secret (`ds.PasswordEnc` → the raw key) instead of a username *and* a
  password; `ds.Username` stops being a credential;
- `POST /bi/../auth/token` with `{"api_key": ...}` instead of `POST /auth/login`
  with `{"email":..., "password":...}`;
- read `expires_in` from the response instead of parsing the JWT's `exp` — the
  `neubitTokenFallbackTTL` guess is no longer needed;
- keep the cache-key-includes-the-secret trick verbatim. It exists so a rotated
  credential cannot be served from cache, and that reasoning is unchanged.

The existing "re-mint slightly before expiry" and "re-exchange on 401" behaviour
is exactly right for a key and needs no change — except that it now matters more,
because the token lives 15 minutes rather than 12 hours.

## The one thing to know before relying on revocation

Revocation is **immediate** for anything core serves and for any further
exchange: both re-read the key row. A token the key *already holds* keeps working
at the **satellites** until it expires, because a satellite verifies statelessly
and has nothing to ask. That window is `VE_API_KEY_TOKEN_TTL_MINUTES`, default
**15 minutes** — which is the entire reason it is 15 and not the 12 hours a
person's token gets. Do not lengthen it without reading
`backend/core/app/core/config.py`, where the trade is written down.

This is the same trade the platform already documents for users ("a permission
change takes effect when the short-lived access token is refreshed",
`kernel/auth.py`). It is bounded here rather than removed, because removing it
means a database round-trip from every satellite on every request, which is the
design the kernel exists to avoid.

## What a key deliberately cannot do

- **Sign in to the console.** Its `sub` is an `api_keys` row; the interactive path
  (`get_current_user`, behind `/auth/me` and everything the SPA touches) resolves
  `sub` to a `users` row and 401s when there is none. There is no check to
  remove — the refusal is a consequence of the shape.
- **Escalate.** It cannot be created wider than its creator, cannot hold `*`, and
  cannot mint another key unless it was explicitly scoped `apikey.manage` (and
  even then only within its own scopes).
- **Cross tenants.** `is_superadmin` is hardcoded false at the mint and the token
  audience is the tenant realm.
- **Reach a core route written for a person.** A route that reaches for something
  only a user has raises and returns 500 rather than inventing a value. That is
  loud on purpose; report it and the route gets a decision, not a default.
