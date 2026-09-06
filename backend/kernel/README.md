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

This closes the *inconsistency*. It does not make the bus trustworthy: **NATS runs
with no authentication**, so anything on the network can still publish a
well-formed offboard. Turning on NATS accounts is a deployment change and it also
touches the conflux edge collector, which connects to the same server.

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

## Known gaps

* NATS has no authentication (above).
* `erase_tenant_data` walks `Base.metadata` for a `tenant_id` column, so a table
  created by raw SQL in a migration and never ORM-mapped is silently skipped.
  `reporting` has eight such tables.
* A failed initial NATS connect is permanent — there is no reconnect loop, and
  `is_connected()` is not consulted by any readiness probe.
* `_tenant_sessionmakers` is an unbounded per-tenant engine cache. Dormant while
  `db_per_tenant` is off, which it is.
* `jwt_secret` and `secrets_key` have guessable defaults and nothing refuses to
  boot with them.
