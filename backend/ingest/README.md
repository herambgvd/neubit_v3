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

**Secrets are per-tenant Fernet** (`kernel.secrets`). The cipher here used to be a
hand-rolled HMAC keystream keyed from `VE_JWT_SECRET`: unauthenticated, so anyone
who could write the column could flip bits in a stored secret, and rotating the
token secret silently broke every HMAC webhook. Rows in the old format still
decrypt and re-encrypt on the next write.

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
pattern-validated — it was not, while the same field on a category was, and a
rule's value overrides the category's.

Shape was only half the question. `access` is a perfectly well-formed domain name;
whose it is, is the other half. A holder of `ingest.manage` could name it and this
service would publish on access control's own subject, which workflow's
correlation engine and the reporting projector both consume and would believe. The
ten domains another service is the authority for are refused by name now, on all
four input schemas — the rule's AND the category's, because the rule's value is
the one that wins.

`ingest` and `fire` are deliberately not reserved: the first is this service's own,
and `tenant.*.fire.>` is subscribed to by workflow and published by nothing, which
is exactly what an external fire panel on a webhook is for. An unlisted domain
(`bms`) is a tenant routing to its own namespace and impersonates nobody.

The broker cannot enforce this. ingest's NATS grant is `tenant.*.*.>` precisely
BECAUSE the field is tenant-configured — a fixed list there would break a
legitimate rule the moment somebody added one. That is why the constraint is here,
at the edge where a rule is saved. A dot or a wildcard there changes the
subject's shape and reaches another module's consumers.

`kernel.events.subject()` validates the domain too, so a value carrying `.`, `*` or
`>` cannot change the subject's shape. What neither stops is a holder of
`ingest.manage` naming another module's own word — `access`, say. That needs
authorisation on the bus, and NATS currently has none; see the kernel's README.

**Platform rows are not everyone's.** The Lumina seeds carry `tenant_id NULL`, and
`kernel.auth.owns()` treats such a row as readable by all while `scoped()` hides it
from listings. Every `assert_owned` here passes `allow_shared=False`.

## Tests

```bash
./backend/ingest/run-tests.sh
```

74, offline: a throwaway container from the shipped image, tree mounted read-only,
no network. The kernel comes from the working tree, not the image's build-time
snapshot.

## Closed since this list was written

All three, and one of them was worse than it says here.

* **`source_ip` took the first `X-Forwarded-For` hop unconditionally** — a header
  the caller writes, on a receiver that takes no JWT, recorded as the only trace of
  who called. It goes through `kernel.client_ip` now: the header is believed only
  when the socket peer is a configured proxy, and the hop taken is the rightmost
  one that is not ours, because Traefik appends rather than replaces.

* **A tenant-supplied JSON Schema could crash the receiver, four ways.** The old
  note called it "a DoS and an audit hole, not SSRF" on the grounds that remote
  `$ref`s are not fetched. That was wrong: jsonschema 4.x resolves them through
  `referencing`, which DOES fetch on a host with network egress — it was safe here
  only because the sandbox has none, which is not a control. Remote `$ref` is
  refused by name now. The other three — a non-string `type`, an unresolvable local
  `$ref`, and `{"$ref": "#"}` blowing the stack on every delivery — all became a 500
  with nothing logged, because the `except SchemaError` sat on the constructor,
  which does not check the schema at all.

* **`cors_origin_regex` allowed every origin, with credentials.** Fixed in the
  kernel and in core together; see `backend/kernel/README.md`.

## Known gaps

* ingest's NATS grant is `tenant.*.*.>`, and it has to be: `target_domain` is
  tenant-configured, so a fixed list at the broker would break a legitimate rule.
  The ownership check is at the edge instead (above), which means it holds for
  rules saved through the API and not for anything that writes the column
  directly.

## Configuration

`VE_DATABASE_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, `VE_INGEST_MAX_BODY_BYTES`,
`VE_INGEST_LOG_RETENTION_DAYS`, `VE_INGEST_RETENTION_SWEEP_SEC`,
`VE_INGEST_AUTO_SEED`.
