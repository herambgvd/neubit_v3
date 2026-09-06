# ingest

The platform's inbound trust boundary. External systems POST events here; ingest
authenticates them per webhook, validates and transforms the payload, records the
delivery, and publishes onto the NATS spine where workflow's correlation engine
picks it up.

Two routers, and the split is the point:

* **The public receiver** — `GET|POST /ingest/hooks/{slug}` — carries no JWT. A
  device has no principal. It authenticates with the webhook's own secret.
* **The config API** — `/api/v1/ingest/...` — is a normal platform surface behind
  a JWT, an `ingest.*` permission, the tenant's `workflow` module and an unexpired
  licence.

## Where the tenant comes from

The webhook row, found by globally unique slug. Not the payload, not a header, not
the URL beyond the slug. The uniqueness check on create is deliberately unscoped —
that is what makes the lookup sound.

## Things worth knowing

**An unknown slug writes nothing.** The receiver is unauthenticated and
internet-facing, and it used to record a full log row — including up to 64 KB of
the caller's own text, tagged `tenant_id NULL` — before authenticating, with no
retention anywhere in the service. Any anonymous caller could decide how much disk
that cost. Unknown slugs are now counted (`/metrics`) and logged instead.

A *disabled* webhook still writes a row: that is bounded by the number of webhooks
that exist, and "why did my integration stop" is the question the log is for.
Both answer the caller identically, so the response cannot be used to tell a real
slug from an invented one.

**HMAC requests expire.** The signature used to cover the body alone — no
timestamp, no nonce — so a captured request replayed forever and each replay
produced a fresh accepted event. Set `hmac_max_age_seconds` on a webhook and the
sender must send `X-Timestamp` and sign `"<timestamp>.<body>"`; anything outside
the window is refused. That is the protection that depends on nothing being
remembered.

Where a sender cannot be changed — GitHub-style webhooks send no timestamp — a
signature that has already been seen is refused, which is also correct dedup for a
genuine retry. That cache is per process; the timestamp window is the one to
configure.

**Bodies are capped before they are read** (`VE_INGEST_MAX_BODY_BYTES`, 1 MiB).
`MAX_RAW_PAYLOAD_CHARS` caps what is *stored*, which is a different thing.

**Delivery logs are pruned** (`VE_INGEST_LOG_RETENTION_DAYS`, 30). They hold
verbatim customer payloads, so keeping them forever was a data-protection problem
as much as a disk one.

**A rule's `target_domain` is interpolated into the NATS subject.** It is
pattern-validated now — it was not, while the same field on a category was, and a
rule's value overrides the category's. A dot or a wildcard there changes the
subject's shape and reaches another module's consumers.

Note the pattern stops the *shape* attacks, not cross-module naming: a holder of
`ingest.manage` can still set `target_domain` to another module's own word. Subject
authorisation belongs on the bus, and NATS currently has none — see the kernel's
README.

**Platform rows are not everyone's.** The Lumina seeds carry `tenant_id NULL`, and
`kernel.auth.owns()` treats such a row as readable by all while `scoped()` hides it
from listings. Every `assert_owned` here passes `allow_shared=False`.

## Tests

```bash
./backend/ingest/run-tests.sh
```

28, offline: a throwaway container from the shipped image, tree mounted read-only,
no network. The kernel comes from the working tree, not the image's build-time
snapshot.

## Known gaps

* The secret cipher is an unauthenticated HMAC-CTR keystream keyed from
  `VE_JWT_SECRET` (`security.py`). Anyone who can write the column can flip bits in
  a stored secret, and rotating the token secret silently breaks every HMAC
  webhook. `kernel.secrets` is the platform's answer and this has not moved to it.
* `source_ip` takes the first `X-Forwarded-For` hop unconditionally. Safe behind
  this gateway, which overwrites the header, but not by its own construction.
* An unresolvable `$ref` in a tenant-supplied JSON schema raises past the handler
  as a 500 with no log row. Remote refs are not fetched, so it is a DoS and an
  audit hole, not SSRF.
* `cors_origin_regex` defaults to any http(s) origin, with credentials.

## Configuration

`VE_DATABASE_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, `VE_INGEST_MAX_BODY_BYTES`,
`VE_INGEST_LOG_RETENTION_DAYS`, `VE_INGEST_RETENTION_SWEEP_SEC`,
`VE_INGEST_AUTO_SEED`.
