# kernel

The shared SDK every satellite service carries: token verification, tenant
scoping, the event bus, secrets, the database handle, and the error envelope.

`core` deliberately does **not** import it. Core is the identity provider; the
kernel is what the services it authenticates embed. Every satellite Dockerfile
does `COPY kernel /opt/kernel`; core's does not, and its build context cannot
reach it.

Six services import it: access, ingest, reading-writer, reporting, vision,
workflow. A bug here is a bug in all of them, which is the reason for most of the
care below.

## What is in it

| Module | |
|---|---|
| `auth.py` | `verify_token`, `Principal`, `require_permission`, `scoped` / `owns` / `assert_owned` |
| `events.py` | the NATS JetStream bus: publish, durable subscribe, ack/nak/DLQ policy |
| `lifecycle.py` | tenant provision + offboard consumers (right-to-erase) |
| `secrets.py` | per-tenant Fernet, and the selective field walkers |
| `db.py` | async engine, sessionmaker, `get_db` |
| `errors.py` | the uniform error envelope and its handlers |
| `config.py` | `VE_`-prefixed settings shared across services |
| `logging.py` | the shared formatter (only workflow adopts it so far) |

## Things worth knowing

**A token must carry `exp`.** PyJWT only validates a claim it finds, so a token
minted without one used to verify forever — as super-admin, with no way to revoke
it. There is 30s of leeway because appliances run without NTP, and a satellite
whose clock trails core was rejecting fresh tokens in a way that reads as
"invalid token".

**Authorisation runs on 12-hour-old claims.** `permissions`, `tenant_id`,
`is_superadmin`, `features`, `limits`, `license_state`, `tenant_status` and
`site_ids` are all frozen at mint time. So a revoked permission, a suspended
tenant or a disabled module keeps working in a satellite until the token expires,
and signing out of core does not sign you out here. That is the deliberate cost of
a satellite authorising without a round-trip; it is not a bug, but it is a window.

**The subject decides which tenant an event is about — not the body.**
`lifecycle`'s offboard handler deletes every row matching the envelope's
`tenant_id`, and nothing checked that it agreed with the subject the message
arrived on. `_deliver` now refuses a mismatch on the first delivery. Every kernel
publisher derives the envelope from the subject, so agreement is the normal case.

This closes the *inconsistency*. It used to be all the bus had: NATS ran with no
authentication, so anything that could reach 4222 could publish a well-formed
offboard.

**The bus authenticates now** (`deploy/nats/nats.conf`). One user per service, no
anonymous fallback, and publish permissions scoped per service — `access` cannot
publish as `vms`, and `reading-writer`, which only consumes, may publish no domain
event at all. The conflux edge collector is a separate deployment and has its own
user, restricted to `tenant.*.iot.>`.

**JetStream's API is scoped per stream, and no service can destroy one.** Each
user is granted the API subjects for the streams it actually uses: core ensures
and publishes to EVENTS, the four satellites ensure EVENTS and EVENTS_DLQ and
consume EVENTS, reading-writer consumes all three, the edge collector publishes
readings. `$JS.API.STREAM.DELETE.>` and `$JS.API.STREAM.PURGE.>` are denied to
every user on top of that. Nothing in the estate calls
either — checked, including vision's `purge()`, which sweeps database rows — so
denying them costs nothing and takes "a compromised service drops the readings
stream" off the table.

CONSUMER delete is not denied, and that is not an oversight: two callers rely on
it and both recreate THEIR OWN durable — a projection whose spec's filter changed,
and this module replacing a legacy never-acking consumer. Scoping consumer ops per
durable is not expressible anyway, because a durable name is one subject token and
NATS has no partial-token wildcard; it would mean listing every durable in the
estate and having a new one fail silently.

One grant stays wide, deliberately. `ingest`'s is `tenant.*.*.>`, because a rule's
`target_domain` is tenant-configured and interpolated into the subject — a fixed
list at the broker would break a legitimate rule. That control lives at the edge
where a rule is saved instead: ingest refuses the ten domains another service is
the authority for. See `backend/ingest/README.md`.

**A subject's domain is validated.** `subject()` interpolated all three tokens
unchecked, and `domain` reaches it from tenant-editable configuration (ingest's
`target_domain`) — so a `.` or a `>` there published into a namespace the caller
does not own. Only `domain` is checked: `event` is chosen by code everywhere, and
several publishers document themselves as never raising.

**`owns()` treats a NULL `tenant_id` as readable by everyone**, and `scoped()`
excludes NULL rows from listings — so such a row is invisible in a list and
reachable by id. It takes `allow_shared`, defaulting to the old permissive
behaviour because six services import this. Only `access` passes `False` so far;
`vision` passes `True` explicitly where it genuinely wants shared platform nodes.
When every caller has been audited, the default flips.

**A secret path is redacted whatever it holds.** The walker used to descend into
dicts first and only replace string leaves, so a secret one level deeper than the
predicate expected, or one that was not a string, came back in the clear from
`redact_fields` — which builds API responses. `encrypt_fields` raises rather than
storing such a value readable.

**`publish()` returns whether the event went.** It returned `None` on every path,
so a dropped event was indistinguishable from a delivered one. It still does not
raise — a failed event must not roll back a committed transaction — but it logs at
ERROR and answers `False`. Each event carries `Nats-Msg-Id` so a retry after a
timeout that actually succeeded is deduplicated.

**The ack/DLQ policy is the most carefully built part of this package.** Every
message reaches exactly one terminal state; `Unprocessable` parks on delivery 1
instead of burning the retry budget; the DLQ is a separate stream outside the
EVENTS subject list so a dead letter cannot re-enter its own loop; and
`_reconcile_consumer` fixes JetStream silently ignoring `config` on an existing
durable, which otherwise leaves `max_deliver=-1` against manual ack — an infinite
redelivery loop. Read those comments before changing anything there.

## Tests

```bash
./backend/kernel/run-tests.sh
```

57, offline. The kernel is a library with no image of its own, so the runner is a
satellite's test image with `PYTHONPATH` on the working tree — the suite must test
the code being changed, not the copy baked into an image at build time.

The suite drives the real `EventBus._deliver` and the real handler
`subscribe_tenant_offboard` builds, against hand-written fakes. No broker, and
nothing mocking the code under test.

## Closed since this list was written

Every item that stood here is fixed, and the list is rewritten rather than ticked
because a gap document that names solved problems sends the next planning session
at work that is already done. Checked against the code, not from memory:

* **NATS had no authentication.** It authenticates every client now, one user per
  service, with publish scoped per service and no anonymous fallback
  (`deploy/nats/nats.conf`, and the section above).
* **`erase_tenant_data` walked `Base.metadata`, missing eight tables in
  `reporting`.** Six are ORM-mapped now; the other two are projection relations
  created at runtime and cannot be. `subscribe_tenant_offboard` takes an `erase`
  override for exactly that case, and `reporting/erasure.py` asks the database
  which relations carry the tenant instead of trusting the metadata.
* **A failed initial NATS connect was permanent.** `max_reconnect_attempts=-1`
  keeps the first connect retrying in the background, and access, ingest and
  vision all consult the bus in `/readyz` — a CONFIGURED bus that is not connected
  is a readiness fault; an unset one is not, because a standalone deployment runs
  with no spine.
* **`_tenant_sessionmakers` was an unbounded per-tenant engine cache.** Bounded by
  `max_tenant_pools` (VE_MAX_TENANT_POOLS, 32) with LRU eviction that disposes the
  evicted engine, plus `forget_tenant()` for a dropped database.
* **`jwt_secret` and `secrets_key` had guessable defaults and nothing refused to
  boot on them.** `_check_secrets` refuses outside dev: RFC 7518's 32-byte floor
  for the JWT secret, 16 for the secrets key, and any value containing
  "change-me", because the exact-match list it replaced missed both placeholders
  `deploy/.env.example` actually ships.

## Known gaps

* Consumer operations are scoped per STREAM, not per durable. A durable name is
  one subject token and NATS has no partial-token wildcard, so scoping a service
  to its own durables would mean naming every durable in the estate at the broker
  and having a new one fail silently. Per-stream is where the line falls cleanly:
  a compromised `access` cannot touch IOT_READINGS at all, but it could delete
  another service's durable on EVENTS, which it shares.
* `$JS.API.STREAM.NAMES` is granted unscoped because it carries no stream token.
  nats-py calls it to resolve a subject to its stream before binding a consumer.
  It returns names, not data.
