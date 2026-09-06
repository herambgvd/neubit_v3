# access

Access control: the platform's integration with physical door controllers. It
owns the local catalogs (instances, doors, access groups, schedules), mirrors and
writes cardholders and cards through to the controller, issues commands to
hardware, and ingests the controller's live event feed onto the NATS spine as
`tenant.<id>.access.<category>.<type>`.

One brand today — DDS — behind a connector interface. `brand` is on the instance
row so a second one is a new connector, not a new service.

## Four keys, not one

Configuring an access system and using it are different jobs, and for a while
they were the same key. `access.manage` covered 55 routes, so whoever could add a
controller could also open every door in the estate.

| key | what it buys |
|---|---|
| `access.read` | see instances, doors, groups, schedules, events, mirrors |
| `access.manage` | configure — instances, doors, groups, schedules |
| `access.credential` | issue and revoke cardholders and cards |
| `access.command` | act on hardware — unlock, arm, initialise, poll |

`test_permission_split.py` walks the dependency tree and fails on any route with
no `require_permission`, and `test_route_inventory.py` asks the service over HTTP,
one route at a time, so a gate that is declared but not reached is caught too.

## Where the tenant comes from

The JWT, and then the instance. Every read and every write goes through the
instance first: `assert_owned(row, scope, allow_shared=False)`, which answers 404
for another tenant's id — the same answer an invented id gets, so a refusal
enumerates nothing.

**A NULL `tenant_id` is a platform row, not a row owned by everyone.**
`kernel.auth.owns()` treats NULL as readable by all while `scoped()` hides it from
listings; here every by-id path is also a write, a re-credential or a
send-command path, so access passes `allow_shared=False` everywhere.

## Things worth knowing

**Controller credentials are per-tenant Fernet** (`kernel.secrets`). This module
used to be its own cipher — an HMAC-SHA256 keystream keyed from `VE_JWT_SECRET`,
unauthenticated and therefore malleable, re-keyed by any routine rotation of the
token secret, and returning `""` on a failed decrypt so every connector would
have authenticated with an empty password and the log would have said "401".
Legacy `enc:<nonce>:<ct>` rows still decrypt and are re-encrypted on the next
write.

**`verify_tls` defaults to true.** It defaulted to false, into
`httpx.AsyncClient(verify=...)` — an unverified link that carries the controller
password. Existing rows keep their stored value.

**Site, floor and zone ids are shape-checked, not existence-checked.** They name
rows in `neubit_control` and the platform bans cross-service reads, so access
cannot ask whether a site exists — and will not be given a way to. What it can
refuse is a value that could never be one, which it now does: the fields were
`str(max_length=36)`, so a typo or a building's name typed into an id box was
stored, filtered on, published on the bus and mirrored by reporting into
`access_events.site_id`. `GET /doors?site_id=banana` answered `[]`, which reads as
"no doors on that site". Both are 422 now. A wrong-but-well-formed id is a
different problem and stays out of reach.

**Events carry `cardholder_ref`.** `/instances/{id}/events` is the only route that
returns who went through which door and when. Its isolation is not a tenant filter
on the rows — the query selects on `instance_id` and relies on the instance gate —
so that gate is asserted directly rather than assumed.

**The right-to-erase is wired** (`access-offboard` on
`tenant.*.tenant.offboarded`). Note that access events are ALSO projected into
`neubit_reporting.access_events`, which is a different database with its own
consumer; see [reporting](../reporting/README.md).

**An unreachable controller is an upstream error, not an internal one.** The
command surface maps `CommandError` to its own status; kernel's envelope now names
502/503/504 as `UPSTREAM_ERROR` / `UNAVAILABLE` / `UPSTREAM_TIMEOUT` instead of the
generic `HTTP_ERROR`, so a caller can tell a retryable failure from an unmapped one.

**The hardware and scheduled proxies interpolate the set name into the upstream
path**, so it is checked against a closed list (`HARDWARE_SETS`,
`SCHEDULED_SETS`) before anything leaves the box. Dashed and underscored
spellings are both accepted.

## Live event ingestion

One SignalR listener per active instance, supervised. It never blocks or crashes
startup — no live controller in dev is a normal state — and `/readyz` reports the
listener count alongside the database and event-bus checks.

## Tests

```bash
./backend/access/run-tests.sh
```

211, offline: a throwaway container from the shipped image, tree mounted
read-only, no network. In-memory SQLite built from the real `Base.metadata`, with
`get_db` overridden — routes run their real scope and ownership code, and nothing
below the HTTP edge is mocked.

The one exception is the controller itself. `get_connector` is monkeypatched in
`test_write_through.py`, which is what makes the cardholder and card routes
testable at all — and what lets the suite assert that the DECRYPTED secret is
what reaches the connector, and that another tenant's request never causes a
connector to be built in the first place.

## Known gaps

* The reconcile scheduler is a wired entrypoint, not a ticking cron. v2 ran one
  per instance; the v3 scheduler is a later phase. Enable the stub with
  `VE_ACCESS_RECONCILE_SCHEDULER=1`.
* `scoped()` inside `AccessGroupCatalog._get_owned` is unreachable from any route
  — the instance gate and the `instance_id` filter answer first. It is
  defence-in-depth against a row whose tenant disagrees with its instance's, and
  is tested directly because no HTTP path can reach it.
* Command failures return the connector's own message, which can name the
  controller host.
* NATS has no authorisation, so a holder of `access.manage` on one module cannot
  be stopped from publishing on another module's subject by anything in this
  service. See the kernel's README.

## Configuration

`VE_DATABASE_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, `VE_SECRETS_KEY`,
`VE_ACCESS_RECONCILE_SCHEDULER`.
