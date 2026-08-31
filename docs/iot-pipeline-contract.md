# Conflux → NeuBit readings pipeline — the contract

Source of truth for every agent working on this pipeline. Two repos and three
phases touch it; if each invents its own message shape or schema, the pipeline
silently drops data and nobody finds out until a dashboard is empty. Copy from
here. Do not re-derive.

Repos:
- gateway: `/Users/snowden/office/iot_work/conflux` (Go, SQLite config store)
- platform: `/Users/snowden/command_center_work/neubit_v3` (Python services, NATS,
  Postgres 16.6 + TimescaleDB 2.17.2)

---

## 0. Shape of the thing

```
conflux ──JetStream publish──► NATS ──┬──► realtime relays ──► browser (already exists)
                                      └──► reading-writer ──► Timescale hypertable
                                                                    ▲
                                              analytics engine ─────┘ (reads rollups)
```

One producer, one bus, one writer, one store. Deliberately NOT two write paths:
a second path (conflux writing Postgres directly) means two failure modes, two
places the schema can drift, and database credentials inside the gateway.

Conflux does NOT store readings. Its SQLite holds configuration only (680 KB
today), and its HA works by exporting/importing that config wholesale. Putting
history in it would turn an easy config-sync problem into a hard data-replication
one, and a promoted standby would come up with no history — silently.

---

## 1. Two defects in what exists today. Both must be fixed, neither is optional.

### 1a. Conflux publishes with CORE NATS, so messages are not persisted

`edge/internal/publish/nats.go` ends in `n.nc.Publish(subj, b)`. Core NATS is
fire-and-forget: if no consumer is attached at that instant the server drops the
message and the publisher is never told.

Conflux's outbox covers "the bus is unreachable" — publish returns an error and
the outbox replays. It does NOT cover "the bus is up, the publish succeeded, and
the writer was down": core publish reports success, the message evaporates, and
the outbox never learns there was anything to replay.

**Fix:** publish through JetStream (`js.Publish`), which waits for a server ack.
A message that is not persisted then surfaces as an error, which the existing
outbox already knows how to handle. This closes both holes with the machinery
that is already there.

### 1b. Conflux's subjects are outside the platform's namespace and carry no tenant

Today: `conflux.{connId}.{deviceTag}.{pointTag}`.

The platform's stream `EVENTS` captures `subjects=["tenant.>"]` and its convention
is `tenant.{tenant_id}.{domain}.{event}`. So conflux's subjects are captured by
no stream and seen by no realtime relay, and a multi-tenant platform cannot tell
whose reading it is.

**Fix:** the subject scheme in §2.

---

## 2. Subject scheme

```
tenant.{tenant_id}.iot.reading.{conn_id}.{device_tag}.{point_tag}
tenant.{tenant_id}.iot.alert.{conn_id}
```

- Lands inside `tenant.>`, so the existing `EVENTS` stream captures it and the
  existing relays can subscribe to it.
- Keeps device and point in the subject, so a consumer can filter with wildcards
  instead of decoding every payload.
- Conflux already sanitises subject tokens so a tag containing a dot or a space
  cannot widen or break a subject. Keep that; it is load-bearing here.

`tenant_id` comes from the connection's own `tenantId`. A connection without one
uses the platform's default tenant id rather than publishing an untenanted
reading.

---

## 3. Message body

The payload is conflux's canonical envelope, wrapped so it matches the platform's
existing event body shape (`{tenant_id, domain, event, payload}`).

```json
{
  "tenant_id": "…",
  "domain": "iot",
  "event": "reading",
  "payload": {
    "conn_id":    "e39a8b77-…",
    "device_id":  "1010cb50-…",
    "device_tag": "B2_Main Incomer",
    "point_id":   "47c0e4f6-…",
    "point_tag":  "PF_pf",
    "env": { "src": …, "v": 0.98, "u": "", "ts": 1756450000, "q": 0, "kind": "" }
  }
}
```

`env` is `model.Envelope` unchanged — do not flatten or rename its fields. Two
properties of it matter downstream and must survive:

- **A text reading carries `s` and deliberately has NO `v`.** `Envelope`'s custom
  `MarshalJSON` omits `v` and `raw` when `kind=="text"`, because publishing
  `"v":0` for a status would be a number nobody measured. The database schema in
  §5 mirrors this with separate `num` and `txt` columns. Never coerce a text
  reading to 0.
- **`ts` is the reading's own timestamp**, not the time it was published or
  written. Replay from the outbox can deliver a reading minutes late; the row
  must carry when it was *measured*.
- **`ts` is in epoch SECONDS.** `model.Envelope.Ts` is `int64` and its own
  comment says "source timestamp, epoch seconds"; the live feed confirms it. An
  earlier version of the example above showed a millisecond value and was wrong.
  The writer's parser (`app/envelope.py`) decides by magnitude and scales
  milliseconds/microseconds if they ever appear, so a unit change on the gateway
  would not silently write rows into the year 58000 — but seconds is the contract.

---

### The alert body

§9 item 4 recorded that this shape was invented rather than specified. This is
now the specified shape.

    tenant.{tenant_id}.iot.alert.{conn_id}

```json
{
  "tenant_id": "default",
  "domain": "iot",
  "event": "alert",
  "payload": {
    "conn_id":         "e39a8b77-…",
    "device_id":       "1010cb50-…",
    "point_id":        "ef18ceb5-…",
    "device_category": "energy",
    "device_type":     "incomer",
    "alert": {
      "id":       "e5a0205e-…",
      "type":     "rule",
      "severity": "critical",
      "src":      { "proto": "mqtt", "conn": "aeon", "dev": "B2_Main Incomer",
                    "addr": "aeonhwj/B2_Main Incomer/CAvg_A" },
      "message":  "CAvg_A at 113.47 A — above 100 A",
      "ts":       1788165290,
      "acked":    false
    }
  }
}
```

`alert` is `model.Alert` unchanged — do not flatten or rename it. `alert.ts` is
epoch SECONDS and is when the alert was RAISED, not when it was published; an
outbox replay can deliver it minutes late.

The four fields beside `conn_id` are the identity the platform can key on, and
they are the only thing not already inside `alert`. `alert.src` carries the WIRE
identity — connection slug, device tag, and a protocol-native address such as a
Modbus register or an MQTT topic — and nothing on the platform is keyed on any
of it. Tags are deliberately not repeated.

- `device_id` — what a cross-domain alert queue groups by; joins `points`.
- `point_id` — `readings`/`points`' primary key, so an alert can be opened onto
  the series that raised it.
- `device_category`, `device_type` — what the device IS, so an alert is
  attributable to energy vs hvac vs water with no lookup.

**All four are OPTIONAL and follow §11's rules exactly**: omitted rather than
sent as `""`, and a missing value means "unknown" — a consumer must never
overwrite a stored value with NULL because a message said nothing. That is the
replay contract: an alert buffered before these fields existed replays from an
Origin that has none of them and publishes none of them.

Alerts remain events, not measurements: no row in `readings`, and the
reading-writer's filter still excludes them. `reporting-projector` consumes them
into `neubit_reporting.iot_alerts`.

**Known gap, both halves named.** `conn_id` is NOT `omitempty`, so a
pre-Phase-C outbox row — which has only the wire slug — marshals it as `""`, and
the projector rejects the message with `bad_uuid:conn_id`. That is silent loss
on the oldest replays. The same applies to the reading body's `conn_id`,
`device_id` and `point_id`. Fixing it is a contract decision: either omit those
when unknown, or have the projector tolerate a non-UUID connection key. The
subject is unaffected — `connToken` already falls back to the slug.

**`iot_alerts` has no columns for the new fields yet.** It stores the wire
identity (`conn_slug`, `proto`, `device_tag`, `point_addr`) and nothing keyed,
so the console still cannot group alerts by category: the gateway half is done,
the store half is not. When it lands it must follow §12's COALESCE rule —
missing never clobbers.

---

## 4. JetStream configuration

Two streams. They must not overlap: NATS refuses overlapping subjects between
streams on one account, and that constraint is what forces the split below.

| stream | subjects | limits |
|---|---|---|
| `EVENTS` | an explicit list of domains — `tenant.*.access.>`, `.core.`, `.device.`, `.erasure.`, `.fire.`, `.ingest.`, `.notify.`, `.sites.`, `.tags.`, `.tenant.`, `.vms.`, `.workflow.` | unbounded (unchanged) |
| `IOT_READINGS` | `tenant.*.iot.>` | `max_bytes` 8 GiB, `max_age` 7 days, `max_msg_size` 1 MiB, `discard: old` |

`EVENTS` used to be `tenant.>`, which subsumed the sensor feed. It is now an
explicit domain list, held in ONE place per language and kept identical across
them:

* `backend/kernel/kernel/events.py` → `EVENTS_SUBJECTS`
* `backend/core/app/core/events_nats.py` → `EVENTS_SUBJECTS` (a deliberate copy;
  core's image does not ship the kernel package)
* the Go `gokernel/events` in the `nvr` repo still creates `EVENTS` with
  `tenant.>`; that call now fails harmlessly and is swallowed, but the list
  should be brought over next time that repo is touched.

**⚠ A NEW DOMAIN MUST BE ADDED TO THAT LIST.** Otherwise its events land on a
subject no stream captures: the realtime SSE relays still see them (they use core
NATS, at-most-once, and never needed a stream) but there is no persistence and no
durable consumer can be created on it.

`add_stream` only ever CREATES. Both Python clients now read the stream back and
`update_stream` it when the subject list has drifted, so a change to the list
reaches a running deployment instead of being swallowed as "already exists".

**Sizing of `IOT_READINGS`, from measurement.** One idle 313-point Modbus/MQTT
broker produces ~37 msg/min ≈ 53k/day ≈ 21 MB/day (envelopes are ~450 B). The
stream is a REPLAY BUFFER, not the archive — the archive is the `readings`
hypertable and its own retention (§5). Seven days covers far more writer downtime
than this is meant to survive; 8 GiB is ~380 MB/day against that age limit, i.e.
~18x the measured single-broker rate, so age binds until roughly 18 brokers and
size takes over after that. `discard: old` means a full stream drops the OLDEST
messages and never becomes backpressure on the gateway. Every limit is an
environment variable (`VE_IOT_STREAM_*`).

NATS monitoring is now enabled (`-m 8222` in `deploy/docker-compose.yml`; the port
was already published but nothing listened on it), so stream and consumer state
are answerable over HTTP:

    curl -s 'localhost:8222/jsz?streams=1&config=1' | jq
    curl -s localhost:8222/healthz

JetStream's file store also has a named volume now (`natsdata:/data`). It had
none: every stream, message and durable consumer lived in the nats container's
writable layer, so any `--force-recreate` silently wiped the event spine and the
services quietly re-created empty streams on reconnect.

The writer consumes as a **durable queue-group consumer** — a durable PULL
consumer, which is inherently shared: every replica binds the same durable name
and NATS distributes between them. `docker compose up -d --scale reading-writer=2`
is the whole redundancy story. No leader election, nothing per-replica.

## 5. Schema

Lives in a reporting database on the platform's existing Postgres — same server
as `neubit_control` / `neubit_ingest` / `neubit_vision`, its own database, which
is the pattern the platform already uses. TimescaleDB 2.17.2 is installed there
and currently has **zero hypertables**; this is its first use.

```sql
-- One row per reading. Deliberately narrow: cardinality (distinct series), not
-- rows/sec, is what decides whether this stays fast, and a wide row multiplies
-- the cost of every one of them.
CREATE TABLE readings (
  ts         timestamptz      NOT NULL,
  tenant_id  uuid             NOT NULL,
  point_id   uuid             NOT NULL,
  num        double precision,          -- numeric reading; NULL for a text reading
  txt        text,                      -- text reading (mode/status); NULL for numeric
  quality    smallint         NOT NULL,
  PRIMARY KEY (point_id, ts)
);
SELECT create_hypertable('readings', 'ts', chunk_time_interval => INTERVAL '1 day');
```

Everything else — device, tags, unit, category, type, gateway — belongs in a
`points` dimension table keyed by `point_id`, NOT on the reading row. Renaming a
device must not rewrite a hundred million rows.

`PRIMARY KEY (point_id, ts)` also gives idempotency: replays from conflux's
outbox are expected and normal, so the writer upserts (`ON CONFLICT DO NOTHING`)
rather than assuming each message arrives exactly once.

Then:
- continuous aggregates at **1 minute** and **1 hour**
- compression on chunks older than a few days
- retention: raw for days, rollups for years — both configurable, not hard-coded,
  because different deployments have different compliance rules

**Dashboards read the rollups, never the raw table.** That is what makes query
cost independent of ingest rate, which is the whole point: sensors have different
turnaround times and the platform cannot assume any of them.

---

## 6. Writer behaviour

- **Batch.** Never one INSERT per reading — that is what kills these systems.
  Flush on N rows or T milliseconds, whichever comes first, so the code path is
  identical at 10 readings/min and 10,000/sec.
- **Never block the bus on the database.** Accept, buffer, write. A slow disk must
  not become backpressure on the gateway.
- **Unknown `point_id`:** upsert the dimension row from the message and keep the
  reading. Dropping data because a dimension row has not arrived yet is the wrong
  trade.
- **Backpressure must be visible.** When the writer falls behind, that has to be
  observable (lag metric, log, health endpoint). Silent data loss is the worst
  outcome available here.

---

## 7. Ownership

| | owns |
|---|---|
| conflux | devices, points, normalisation, publishing. NOT reading history. |
| reading-writer | the readings schema. The only thing that writes it. |
| analytics engine | reads rollups. Never writes. |

Schema changes happen in the writer, in one place.

---

## 8. Rules for whoever works on this

1. Copy values and names from this file. Do not re-derive them from the other repo.
2. Do not add a second write path. If direct database access looks tempting, the
   answer is a change to this contract, not a bypass of it.
3. Verify against the running stack, not against source. Both defects in §1 were
   found by reading what the code actually does, not what its comments claim.
4. Conflux ships as a cloud-hosted software gateway — not to sites, not
   air-gapped. Deployment-weight arguments that assume per-site installs do not
   apply.

---

## 9. Open questions from Phase C (2026-08-30) — ALL SETTLED, see §10

Phase A (schema) and Phase C (gateway publisher) are done. Four things surfaced
that this contract did not settle. The writer must not guess at them.

**1. `{conn_id}` in the subject: UUID or slug?**
Conflux's *wire* identity is the connection **slug**, frozen at creation so a
rename does not repoint subscribers. §2 says `conn_id`, so Phase C put the
**UUID** in the subject, matching `payload.conn_id`. A consumer parsing the
subject and a consumer reading the body therefore get the same value. If the
platform would rather see slugs on the wire, that is a contract change.

**2. §1 undersold the work.** It presented the publisher fix as two changes in
`nats.go`. In fact nothing in the publisher path carried `tenant_id`,
`device_id` or `point_id` — the `Publisher` interface only ever received the
connection slug and tags. §3's body and §5's `PRIMARY KEY (point_id, ts)` both
need those ids, so Phase C added `model.Origin` (slug+tags *and* tenant+ids),
assembled in the engine, threaded through every publisher, and persisted on the
outbox as an additive `origin` column so a replayed reading keeps the identity it
had when measured. MQTT/Kafka/webhook wire behaviour is unchanged.

**3. The `EVENTS` stream is unbounded and this is now urgent-ish.**
Measured: `max_msgs=-1, max_bytes=-1, max_age=0`, file storage. The bridge is
live and steady-state is ~37 msg/min (~53k/day, ~21 MB/day) from one idle
313-point broker. Nothing drains it yet.
**Phase B's first task is a dedicated `tenant.*.iot.>` stream with real limits**,
not widening `EVENTS` — that would change retention for every other domain event
on the platform. Note NATS monitoring is NOT enabled in
`deploy/docker-compose.yml` (the command is `-js -sd /data` with no `-m 8222`),
so stream state cannot be inspected over HTTP until that is added.

**4. The alert body shape was invented, not specified.** §3 covers readings only.
Phase C used the same wrapper with `event: "alert"` and
`payload: {conn_id, alert}`. This is the one shape nothing in this document
authorised — confirm or change it before a consumer depends on it.

---

## 10. What Phase B settled (2026-08-30)

Phase B is the reading-writer: `backend/reading-writer/`, service
`reading-writer`, consuming `tenant.*.iot.reading.>` off `IOT_READINGS` into
`neubit_reporting.readings`. §9's four open items:

1. **conn_id in the subject: UUID.** Confirmed, unchanged. The writer reads
   `payload.conn_id` and never parses the subject, so it is indifferent — but
   consumers that DO parse the subject get the same value as the body.
2. **§1 undersold the work** — noted, nothing to change.
3. **The unbounded `EVENTS` stream** — fixed. See the rewritten §4.
4. **The alert body shape** — CONFIRMED as Phase C sent it — superseded by §3's alert-body block, which adds four optional identity/classification fields
   (`{tenant_id, domain: "iot", event: "alert", payload: {conn_id, alert}}`).
   Alerts are events, not measurements: they get no row in `readings`, and the
   writer's consumer filter deliberately excludes them. They are captured by
   `IOT_READINGS` (subjects `tenant.*.iot.>`) so they are durable and replayable,
   but nothing on the platform consumes them yet.

### One thing this document did not anticipate: the tenant key is not a UUID

§2 says a connection without a tenant "uses the platform's default tenant id".
The gateway does something different: it publishes ITS OWN default tenant key,
which is the literal string `default` — the live aeon feed is on
`tenant.default.iot.reading.…` and `"tenant_id": "default"` in the body. But
`readings.tenant_id` is `uuid NOT NULL` (§5), so that key has to be resolved.

The writer resolves it (`app/tenants.py`), in this order: a key that parses as a
UUID is used as-is; otherwise `VE_READINGS_TENANT_MAP` (`key=uuid,…`); otherwise
`VE_READINGS_DEFAULT_TENANT_ID`; otherwise a deterministic UUIDv5 of the key,
with a WARNING and a non-zero `reading_writer_unmapped_tenant_keys` metric.
Dropping the reading was the alternative and it is silent data loss.

**Settled 2026-08-30, and it MUST be set on every deployment.** On this machine:

    VE_READINGS_TENANT_MAP=default=c8ca5b7b-050d-4a10-8b06-0f4836d92397

The gateway's `default` key maps to the platform's `bharti` tenant. Verified:
after setting it, a fresh aeon cycle landed 313 rows under the real tenant with
`unmapped_tenant_keys` at 0, and the 1,879 rows already written under the
synthetic id were moved and the aggregates refreshed.

`deploy/.env` is gitignored and there is no `.env.example`, so **this value does
not travel with the repo** — a fresh deployment starts with readings under a
synthetic tenant the UI cannot see, and nothing fails loudly except the metric.
Set it before pointing a gateway at a new platform.

The mapping exists because the two systems have two tenant namespaces: conflux
tenants are its own strings (`default`), platform tenants are UUIDs. A per-key
env var does not scale past a handful of gateways. The durable fix is for a
conflux tenant to carry the platform tenant UUID as a field, so the mapping
lives in data rather than in configuration that someone has to remember.

### Writer behaviour, as built (§6 made concrete)

* **Batch on N rows or T ms, whichever comes first** (`VE_READINGS_BATCH_ROWS`
  500 / `VE_READINGS_BATCH_MS` 1000). One code path at any rate.
* **Ack only after the batch is durably written.** A batch is ONE transaction —
  points upsert and readings insert together — so a failure mid-write leaves
  nothing behind. On failure the writer retries in place twice and then NAKs the
  whole batch: nothing was acked, JetStream redelivers, and
  `ON CONFLICT DO NOTHING` absorbs any row a successful retry already stored.
* **Never blocks the bus on the database.** A bounded queue of batches sits
  between the fetcher and the writer; when it fills the fetcher stops pulling and
  the backlog stays in JetStream, where it is bounded and visible as
  `consumer_pending`. The gateway's publish is acked by the NATS server and is
  never affected.
* **Database down → the fetcher pauses** rather than burning ack_wait timers; a
  `SELECT 1` prober resumes it.
* **Malformed messages are acked, counted and logged** with a reason
  (`reading_writer_malformed_by_reason{reason=…}`). Redelivering a message that
  can never become a row would block the stream behind it. This is the only place
  the writer discards anything, and it is never silent.
* **Observability**: `:8020/health` (liveness), `/readyz` (503 on database down,
  NATS disconnected, or lag over `VE_READINGS_LAG_WARN`), `/metrics`
  (Prometheus), `/stats` (the same as JSON).

---

## 11. Device metadata must reach the store (Phase D)

Building Intelligence filters by what a device IS — HVAC & Assets, Energy &
Metering, IAQ & Environment are category views. The gateway already classifies:
of the 30 aeon devices, 28 carry a category (energy 18, hvac 7, water 2, fire 1;
the `gateway` pseudo-device carries none, correctly).

**None of it reaches `points`.** Measured: `category_set=0` of 314 rows. The §3
body carries `conn_id, device_id, device_tag, point_id, point_tag, env` and
nothing about what the device is, so the writer has nothing to store and every
BI category view would be empty.

Add to the §3 payload, alongside the existing device fields:

```json
"device_category": "energy",
"device_type": "meter"
```

Both optional — omit rather than send empty strings, and the writer must treat a
missing value as "unknown", not overwrite a known value with NULL. A device's
category can be corrected by an operator later, so the writer should update
`points` when the value changes rather than only on first insert.

**`unit` stays empty and that is correct, not a bug.** All 313 aeon points report
`env.u` empty — the source MQTT payloads carry no unit. The writer should keep
storing `env.u` when present. Inferring a unit from a point tag (`PF`, `kW`,
`A`) is a separate feature and must not be smuggled in here: a guessed unit on a
BI energy dashboard is worse than a blank one.

Note `points.type` currently holds the reading KIND (`num` / `text`), not the
device type. Those are two different things and need two columns; do not overload
the one that exists.

---

## 12. What Phase D settled (2026-08-30)

Phase D is done: the classification reaches the store. `points.category` went from
0 of 314 rows to **306 of 314**, and the distribution reproduces the gateway's own
(energy 18 devices / 260 points, hvac 7 / 36, water 2 / 10).

**The wire.** §3's payload gains two OPTIONAL fields, exactly as §11 asked:

```json
"device_category": "energy",
"device_type": "distribution-board"
```

Both `omitempty`. An unclassified device sends neither rather than sending `""`.
On the gateway they ride on `model.Origin` (Phase C's carrier), assembled in the
engine where connection, device and point are held together, so a reading
replayed from the outbox carries the classification the device had WHEN IT WAS
MEASURED. An outbox row written before these fields existed unmarshals with them
empty and replays with them absent — which the writer reads as "unknown" and
leaves the stored value alone. That is the whole reason they are optional.

**The store.** `points` gains a `device_type` column (migration
`0003_points_device_class`) plus `ix_points_tenant_category` for the BI filter.
`points.type` is untouched and still means the reading KIND (`num`/`text`); the
device's equipment kind is a different fact and got its own column, per §11.

Two writer rules, both enforced in `backend/reading-writer/app/store.py`:

* **Missing never clobbers.** `category` and `device_type` are upserted through
  `COALESCE(excluded, stored)`. A message that says nothing leaves the stored
  value alone, so an operator's correction survives the next reading.
  *Verified:* a message published with no `device_category` for a point whose
  category was `energy` updated `last_seen_at` and inserted its reading, and the
  category stayed `energy`.
* **Changed does follow.** A message carrying a value overwrites. The point cache
  now keys on a FINGERPRINT of the dimension fields as well as the touch
  interval, so a reclassification is re-upserted on the very next reading rather
  than up to `point_touch_sec` later. *Verified live:* `B2_Main Incomer` moved
  energy → other → energy in the gateway and `points` followed each way on the
  next real aeon reading.

**Units are still empty and still correct.** All 313 aeon points report `env.u`
empty because the MQTT payloads carry no unit. Nothing was inferred.

### Two gateway bugs Phase D had to fix to make any of this work

Both were invisible from the outside and both silently discarded an operator's
intent. Neither is about the message body; they are why a corrected category
never left the gateway.

1. **`UpdateDeviceScoped` never wrote `category` or `type`.**
   (`edge/internal/config/tenants.go`.) The API validated the new category, set
   it on the struct and returned it in the 200 response — so the UI showed the
   change — while `UPDATE devices SET tag=?, config=?` persisted nothing. The
   unscoped `UpdateDevice` had always written both. Device classification was
   therefore uneditable through the API, silently, for its whole life.

2. **The engine's worker fingerprint ignored `category`/`type`.**
   (`edge/internal/engine/engine.go`.) A running worker holds its own copy of
   `model.Device`, and that copy fills every published `Origin`. With the
   classification outside the fingerprint, `Reload()` left the worker running and
   the wire kept announcing the old category until the process restarted.
   Reclassifying a device now restarts its worker — the same cost as retagging
   it, and the only way the running copy gets refreshed.

### Corrections to this document

* **§11 says "the `gateway` pseudo-device carries none, correctly".** TWO aeon
  devices carry no category, not one: `gateway` and `B1 Guard Room`. The counts
  in §11 are right (18+7+2+1 = 28 of 30); the parenthetical is not.
* **`fire` is 1 device with 1 point, and that point has never produced a
  reading.** So `category='fire'` does not appear in `points` and cannot until
  `ddcg/fire/pub` publishes: the writer creates a dimension row only from a
  reading, by design (§6). A `points` distribution is a distribution of what has
  REPORTED, not of what is configured.

### Known, left alone

* `points.unit` is still assigned unconditionally, so a message with no `env.u`
  writes NULL over a stored unit. Harmless today — the gateway is the only
  source of units and no operator can set one on the platform — but it is the
  same shape as the bug §11 called out for `category`. If units ever become
  editable, `unit` needs the same COALESCE.

---

## 13. The READ side (Phase E, 2026-08-30)

Nothing exposed `neubit_reporting` over HTTP, so Building Intelligence had no way
to see any of this. Phase E adds the read API — **in the reading-writer**, not in
a new service.

**Why there.** §7 gives the readings schema ONE owner. A separate "analytics API"
container would have to open `neubit_reporting` and SELECT tables it does not own,
which is a cross-service read and a second place the schema can drift. The owner
serves its own reads, importing the same `reporting.models`. Everything on the
read path is SELECT-only; the writer is still the only thing that writes.

    backend/reading-writer/app/api/{router,queries,schemas}.py

**Surface** — `{api_prefix}/bi/…`, i.e. `/api/v1/bi/…`:

| endpoint | answers | reads |
|---|---|---|
| `GET /bi/summary` | what is reporting, by category, + estate totals + reading extent | `points`, plus one `readings_1h` aggregate for the current hour |
| `GET /bi/activity?hours=` | hourly SAMPLE volume per category | `readings_1h` (real-time CAgg) |
| `GET /bi/devices?category&device_type&search` | devices that have REPORTED | `points`, grouped |
| `GET /bi/points?device_id&…&with_latest` | a device's points + each one's LATEST value | `points` + RAW over a bounded lookback |
| `GET /bi/series?point_id=…&hours&resolution` | a chart | `readings_1m` / `readings_1h`; `raw` only inside a 3-hour window |

**Which store answers what, and why.** This is the part that must not drift.

* **Charts read the ROLLUPS.** `resolution=auto` (what every screen uses) picks
  `readings_1m` up to a 3-hour window and `readings_1h` beyond it. That is what
  makes query cost independent of ingest rate (§5) — the reason the aggregates
  exist at all. The response carries `resolution` and a one-line
  `resolution_reason` so a screen can PRINT which store answered instead of
  implying a precision it does not have.
* **`resolution=raw` is bounded.** Over 180 minutes it is a 400 naming the
  rollup to ask for. Silently downgrading a raw request would make the chart lie.
* **Current values read RAW, deliberately.** `readings_1m` is `materialized_only`
  with a ~2 minute freshness floor, so it cannot answer "what is it NOW".
  `/bi/points` reads raw with `DISTINCT ON (point_id)` inside a 60-minute
  lookback — an index walk down `PRIMARY KEY (point_id, ts)`, bounded, so its
  cost does not grow with history. A point with nothing in the window returns
  `latest: null`; it never returns an older value dressed as the current one.
* `readings_1h` is real-time, so the current partial hour IS current. The UI
  draws that bar faded and says so.

**Authorization** follows `ingest`'s pattern exactly — the core-minted JWT is
verified locally (shared `VE_JWT_SECRET`), no round trip to core:

* permission `bi.read`, registered in core's catalog
  (`core/app/auth/permissions.py`, group "Building Intelligence") so a role can
  actually grant it. *Note for whoever touches ingest next:* `ingest.read` /
  `ingest.manage` are NOT in that catalog, so today only a wildcard admin can
  hold them. Same bug class, still open.
* module `analytics` ("Dashboards & Reports") + `require_active_license()` on the
  router mount.
* **tenant scope comes from the token claim and is never a query parameter.**
  Every statement carries a `:tenant` bind filled from `get_scope()`. A
  super-admin (no tenant claim) passes NULL and sees every tenant, which is
  `kernel.auth.scoped()`'s semantics everywhere else. `/bi/series` resolves its
  point ids against `points` FIRST and drops any that are not the caller's, so a
  known-good point id from another tenant returns an empty series rather than
  data. *Verified:* a token minted for a different tenant uuid returns `[]` /
  zero from every endpoint, including `/bi/series` with a real Bharti point id.

**Routing.** `gateway/dynamic/routes.yml` gains a `reading-writer` router for
`PathPrefix('/api/v1/bi')` ONLY, at priority 110 with `api-protected`. The rest
of the service (`/health`, `/readyz`, `/metrics`, `/stats`) stays an operational
surface on the container port and is deliberately NOT routed — a bare `/metrics`
prefix here would also collide with core's.

### What Phase E did NOT build, and why

* **IAQ & Environment stays SOON.** There are ZERO `environment` points. A tile
  is not a schedule promise; filling it would be fabrication.
* **Ratings / Insights & Correlation stay SOON.** A rating needs a benchmark and
  a unit; a correlation needs to know what each point MEASURES. `points.unit` is
  empty for every point by design (§11/§12) and nothing on the wire says what a
  tag means, so both would be numbers nobody measured.
* **`water` has no launcher tile** and Phase E did not add one unilaterally. It
  is genuinely reporting (2 devices / 10 points — a sump pump and a flow meter),
  so the Portfolio screen shows the category with an explicit "no console yet"
  marker rather than hiding it. Adding a seventh tile is a product decision.
* **No unit, anywhere.** Not in the API, not on a screen, not on a chart axis.

### One thing the store now shows that is not a building point

`4F-5F Light DB / PHASE_B_TEXT_PROBE` is the synthetic text-kind reading injected
while Phase B was being tested. It stopped reporting at 06:01 and is still in
`points`, so it counts as a 7th point on that device and as one of the 8
unclassified points on every BI screen. The writer only ever INSERTS dimension
rows (§6) — there is no retirement path and no delete API — so a test point is
permanent. That is a real gap, not a display bug: `points` needs either a
retention rule on `last_seen_at` or an explicit retire, and the counts stay
slightly wrong until it has one.

---

## 14. A second consumer on the same store (2026-08-30)

`neubit_reporting` now has two writers, and the split is deliberate.

| | writes |
|---|---|
| `reading-writer` | `readings` / `points` and their rollups. Unchanged; §7 still holds. |
| `reporting-projector` | the relations declared in `reporting_projections` — domain events, starting with access control. |

The projector (`backend/projector`) is a sibling, not an extension: it copies this
contract's §4 and §6 behaviours verbatim — durable pull consumer, batch on N rows
or T ms, one INSERT per batch, `ON CONFLICT DO NOTHING` on a natural key, ack only
after a durable write, NAK the whole batch on failure, pause the fetcher while the
database is down, count malformed messages by reason — because those are
properties of a durable consumer, not of the IoT domain. The differences are only
the ones the domain forces: `EVENTS` instead of `IOT_READINGS`, smaller batches
(domain events arrive at human rates, so the timer is what fires), and per-
projection counters instead of one set.

Two things this change fixed on the IoT side:

* `_fetch_loop` caught only `nats.errors.TimeoutError`. nats-py also raises
  `asyncio.TimeoutError` when the client-side wait expires, so a QUIET gateway
  logged `fetch failed:` with an empty message every second and parked a
  permanent `last_error` on `/stats` and `/readyz`. Both timeouts are now the
  idle path. A health surface that cries wolf while nothing is wrong is worse
  than no health surface.
* Nothing else. The readings pipeline is otherwise untouched.

What has NOT changed: there is still exactly ONE read path over this store
(`reading-writer`'s `/api/v1/bi/...`). The projector serves no tenant API. A
second query path over the same tables is exactly the drift §8 rule 2 is about.

See `docs/dashboard-builder-contract.md` §9 for the projection registry, the
per-domain recipe, and the ownership table.

---

## 15. The alerts are consumed now (2026-08-31)

§10.4 confirmed the alert body shape and ended with a sentence that stayed true
for a day: *"nothing on the platform consumes them yet."* Measured before this
change: **19 alert messages held in `IOT_READINGS`, zero rows anywhere.** The
gateway had been raising faults and the platform had been dropping them, quietly,
for the whole life of the bridge.

They are projected now, and NOT by a new service. `backend/projector` already
consumes a subject into a relation on the strength of one row of
`reporting_projections` (builder contract §9), so this is an INSERT
(`reporting/migrations/versions/0007_iot_alerts_projection.py`) and no code:

```
tenant.*.iot.alert.*  ──IOT_READINGS──►  reporting-projector
                                              │
                                    neubit_reporting.iot_alerts (hypertable)
                                          + iot_alerts_1h (continuous aggregate)
                                          + a dashboard_datasets row
```

Three things this proved, all worth writing down:

1. **A projection can read `IOT_READINGS`.** `spec.Source.stream` was already a
   field and nothing had ever set it to anything but `EVENTS`. It has to be the
   IoT stream here: the alert subject is under `tenant.*.iot.>`, and §4's
   no-overlap rule means `EVENTS` cannot capture it.

2. **A projection does not require the platform envelope.** Every projection so
   far consumed `kernel.events.envelope`; the gateway sends the IoT event body
   with conflux's own alert nested at `payload.alert`. The projector never cared —
   a column declares a dotted path into whatever was decoded. It is a bus→table
   mapper, not an envelope parser.

3. **The projector's tenant map had never been exercised.** Access events carry a
   real uuid, so `VE_PROJECTOR_TENANT_MAP` being empty had never mattered. The
   gateway publishes the literal key `default` (§10), so alerts would have landed
   under a synthetic tenant the console cannot see — while the SAME gateway's
   readings landed correctly, because the reading-writer's map IS set. Two stores
   disagreeing about who owns one gateway's data. `ProjectorConfig` now falls back
   to `VE_READINGS_TENANT_MAP` / `VE_READINGS_DEFAULT_TENANT_ID` when its own are
   unset; both services already share the resolver's UUIDv5 namespace for exactly
   this reason. `VE_PROJECTOR_TENANT_MAP` still wins when it is set.

### What the alert wire does NOT carry, and what each absence costs

* **No device category.** `payload.alert` has `src.{proto,conn,dev,addr}` and
  nothing about what the device IS. The READING payload gained
  `device_category`/`device_type` in Phase D (§12) and the alert payload did not,
  even though `raiseAlert` in `edge/internal/engine/engine.go` already builds a
  `model.Origin` that carries both. So an alert can be grouped by device,
  connection, point address and protocol — never by `energy` vs `hvac`. **The fix
  is the same four lines Phase D used**: add `device_id`, `device_tag`,
  `device_category`, `device_type` as `omitempty` fields on `alertPayload` in
  `edge/internal/publish/nats.go`, fed from the `Origin` already passed to
  `PublishAlert`. Until then the console's queue is a fault queue, and is
  deliberately not labelled "cross-domain".

* **No acknowledgement.** `alert.acked` is on the wire and is ALWAYS `false`: an
  alert is published the instant it is raised, and `AckAlertScoped` /
  `AckAllAlertsScoped` mutate conflux's SQLite and publish nothing. **MTTA is
  therefore not computable from this feed**, and neither is an open/closed split
  or a "time to first response". The column is not stored, precisely so that
  nobody derives one of those from a field that cannot change. An ack event on the
  bus would make all of them real; nothing else will.

* **No point id.** `src.addr` (`aeonhwj/B2_Main Incomer/CAvg_A`) is the only link
  from an alert to a series, and it is a topic path, not a `point_id`. Joining
  alerts to readings is therefore string matching, which is why nothing here does
  it.

### The read side

`GET /api/v1/bi/alerts?hours=&severity=&limit=` on the reading-writer — the ONE
read path over this store (§14) — serves the fault QUEUE from the raw table over a
bounded window, because the queue needs each alert's own message and the hourly
rollup deliberately does not carry it (the message quotes the measured value, so
it is unique per alert; grouping by it would make the rollup a copy of the fact
table). The wider question is a chart, and the registered `iot_alerts` DATASET
answers it from the rollup through `/bi/query`.

The endpoint answers `available: false` with a reason rather than raising when
`iot_alerts` does not exist. A projection is data and can legitimately be disabled;
"nothing is collecting faults" and "there are no faults" are opposite facts and
must not render as the same empty list.

---

## 16. WHERE a point is — spatial columns on `points` (2026-08-31)

`neubit_control` has had `sites`, `floors` and `zones` for a long time. `points`
referenced none of them, so nothing this platform measures was anchored in space:
"what is floor 4 drawing", "scope this page to one building", "the chiller is on
the roof" — none of it was expressible. Not because the data was wrong, because
the column did not exist.

Migration `0008_points_spatial` adds `site_id` / `site_name`, `floor_id` /
`floor_name`, `zone_id` / `zone_name` to `points`, two indexes
(`(tenant_id, site_id)`, `(tenant_id, floor_id)`), and appends six dimensions to
the registered `iot_readings` dataset — appended with a jsonb concat and an
idempotence guard rather than the definition being reprinted, because the
definition is DATA and a migration that rewrote it wholesale would silently
revert anything else that had changed it.

**It places nothing, and that is the point of doing it now.** All 314 points are
unplaced when this runs and stay unplaced:

* nothing on the wire carries a placement. The gateway knows a device's
  connection, tag, category and equipment kind (§11/§12) and has no field in which
  to say which floor it is on;
* a guessed placement is worse than none. `4F Khem Chiller01` looks like it names
  a floor, and parsing floors out of device tags would place most of this estate
  correctly and the rest silently wrongly — a floor-wise chart that is wrong for
  one floor in five is worse than one that says "unplaced". §4 in a new place.

Getting the structure in first means widgets saved from here on can group and
filter by site, floor and zone, and start answering the day placements arrive
rather than needing to be rebuilt.

**Why an id AND a name at each level.** The id is the identity; the name is the
label, and this store may not look it up — `sites`/`floors`/`zones` live in
`neubit_control` and the platform bans cross-service reads. It is the access
projection's "put the LABELS on the wire" rule (builder contract §9.3) applied to
a dimension table: whoever writes a placement writes the name with it, or every
floor legend on the platform reads `a7f3…`. The name is a COPY and goes stale on
a rename — the same cost `points.device_tag` already carries. Group on the id;
display the name.

**The writer cannot touch these columns.** `reading-writer`'s points upsert names
its columns explicitly and these six are not among them, so a reading can never
blank a placement. That is the same failure the `category` COALESCE prevents,
avoided here by construction — a placement is an operator's statement about the
building, not something the gateway reports.

`/bi/summary` now carries `placement` (how much of the live estate is anchored,
per level — the three counts are INDEPENDENT, since a rooftop meter can have a
site and no floor) and `floors`, which includes the UNPLACED group as a row with
a NULL id rather than dropping it. The Portfolio console has a "Floor-wise" panel
that reads "0 of 314 placed" instead of showing an empty list, because a
floor-wise surface with no rows looks broken while a zero is a fact.

### What was still missing, and it was not the schema — SETTLED, see §17


**There is no way to place a point.** No API, no screen, no wire field. The
columns can only be written by hand against the database today, and the honest
next steps are, in order: a placement API on the reading-writer under `bi.manage`
(the key that already exists for retiring a point — deciding what is part of the
estate and deciding where it is are the same kind of decision); a device-level
placement rather than a point-level one, since a placement is a property of the
box, not of each of its measurements; and a copy of the floor's name written at
the same time by whatever does the writing.

*Verified by hand, and then undone:* a real site (`Aeon Tower`) and floor
(`Level 4`) were created through core's own `/api/v1/sites` and `/api/v1/floors`,
three points of `4F Khem Chiller01` were placed on that floor with an UPDATE, and
`/bi/query` grouped by `floor_name` returned `Level 4 → 96 samples` alongside
`null → 9,641`. The placement was then reverted, because nothing in the product
could have written it and a hand-made row in a dimension table is a fixture — the
exact thing builder contract §9 dropped `access_events` for. The site and floor
were kept: they were created through the real API and are ordinary configuration.

---

## 17. Placing a device in a building (2026-08-31)

§16 ended with the sentence that made everything under Building Intelligence
wait: *"There is no way to place a point. No API, no screen, no wire field."*
**314 points, 0 placed.** The Portfolio's Floor-wise panel was a panel about an
empty column, and the VMS floor plan — which has placed cameras for a long time —
could not show a sensor.

It is placeable now. `POST /api/v1/bi/placement/devices`, gated on `bi.manage`,
and a screen at `/bi/placement`.

### The truth is one row per DEVICE

`neubit_reporting.device_locations` (migration `0010_device_locations`), keyed
`(tenant_id, device_id)`, carrying the site / floor / zone ids, a copy of each
name, the device's tag at the time, and `placed_by` / `placed_at` / `source`.

Device-level, not point-level, for three reasons and only the first is about
effort:

1. **A placement is a fact about a box.** Every one of `4F_Solar_Panel01`'s 21
   points is in the same room. This estate is 29 devices to 314 points, so the
   same fact is stated ten times less often — and it is also how the GATEWAY
   models the world, where a point exists only as a child of a device.
2. **It has to travel to a point that does not exist yet.** The writer creates a
   `points` row the first time a point reports (§6). If the six columns were the
   truth, a device placed today whose 22nd point first reports tomorrow would
   have one unplaced point and nothing would say so — a placed estate that
   silently un-places itself as it grows.
3. **"What did the operator say" has to be answerable.** Reconstructing it from
   314 denormalised copies that can disagree is not the same question.

`points.site_id / floor_id / zone_id` are now a DERIVATION of that row, computed
by `reporting.placement.reconcile_placement()` — one statement, in the shared
`reporting` package because it has two callers who must never disagree.

`points.placement_source` says which: `NULL` (unplaced, or derived from a device
with no row), `'device'`, or `'point'`. **`'point'` is the override** — an
operator saying THIS point is not where its device is, for the sub-meter that
genuinely is not. The reconcile never touches such a row, and that exclusion is
the whole of the mechanism. It is the exception, and the screen does not lead
with it.

### It is a JOIN between two systems, and it is stored like one

The gateway owns `device_id`; `neubit_control` owns `site_id` / `floor_id` /
`zone_id`. That is the same shape as the tenant mapping in §10 — and it is stored
in a TABLE precisely because of how that one went wrong. `VE_READINGS_TENANT_MAP`
lives in a gitignored env file, so it does not travel, and a fresh deployment
starts silently wrong. A row travels with a `pg_dump`, is visible to an operator,
and records who asserted it.

**Why in `neubit_reporting` and not in core.** Core has never heard of a conflux
`device_id`, and BI may not read `neubit_control` (§1). Putting the join beside
the thing it decorates means a floor-wise question is answered without a second
service in the request path.

**Why not core's existing `device_placements`.** That table already joins a
device to a floor — it is what pins a camera to a floor plan. Its `floor_id` and
its `floor_position` `{x, y, rotation}` are both NOT NULL, so reusing it would
mean inventing an x/y for 29 devices nobody has drawn, and would make "on the
site, on no particular storey" — a true statement about a rooftop meter —
unexpressible. `device_locations` says WHICH ROOM; `device_placements` says WHERE
ON THE DRAWING, and the first comes first. The names differ so a grep never
confuses them.

### The NAME comes from core, never from the browser

§16 required the label to be copied at write time. The obvious implementation is
to let the client send the name it already has on screen, and this deliberately
does not: a client-supplied name is a label nothing checked, so a request could
place 22 points on a `floor_id` that does not exist, or call a floor `Roof` that
core calls `Level 9`, and `/bi/summary` would print either as fact.

So the placement API resolves every id against core's own `/sites` / `/floors` /
`/zones` **with the CALLER's bearer token** and copies the name from core's
answer, ignoring anything the client said about it. It also checks the three
agree — a floor of another site, or a zone of another floor, is refused.

That is a service-to-service call, not a cross-service read; `permsync` already
does the same thing in the other direction. Using the caller's token rather than
a system one means a caller who cannot read a site cannot place anything into it,
and core's tenant scoping applies for free. A placer therefore needs `bi.manage`
plus `sites.read` / `floors.read`, which is what the screen needs anyway.

**If core is unreachable the placement is REFUSED.** Writing an unverified
placement because the validator was down is how a fixture gets into a dimension
table.

### The no-clobber rule, and the one thing the writer is now allowed to do

§16 said the writer "cannot touch these columns", made true by construction: its
points upsert names its columns and these six are not among them. **That is
unchanged** — a message carries no placement and can neither blank nor move one.

What the writer now does is call `reconcile_placement()` for the points it
upserted, in the same transaction. It is not authorship: the statement's only
source is `device_locations`, which only the placement API writes. It is the only
way point 22 of a placed device is placed when it first reports. The reconcile is
guarded by `IS DISTINCT FROM`, so in the steady state it writes nothing.

*Verified live:* a placed point's derived placement was blanked by hand, the next
real aeon reading arrived, and the point came back `Aeon Tower / Level 4 /
device` — refilled from `device_locations`, never from the message. In the same
cycle the other points of that device kept their placement while their
`last_seen_at` advanced.

### Bulk, and the naming convention that must stay a suggestion

Placing 29 devices one at a time is how the feature does not get used, so the
list is the shape of the API rather than an add-on: `device_ids` plus ONE target
(heterogeneous bulk would be unrelated decisions in one request's clothes).

The screen groups the worklist by the leading token of the gateway's own device
tag — `B1`, `4F`, `1F`, `B2`, `gateway` — because an operator obviously reads
that as a floor, and it turns 29 decisions into six.

**The prefix groups the LIST and pre-selects a SELECTION. It never fills in a
floor.** Nothing on this platform maps `4F` to a floor id, and it must not:
`4F-3F AC DB` names two floors and `4F-5F Light DB` names two more. §4 in a new
place — turning a convention into a stored fact is the fabrication that looks
right for four floors in five.

### Unplaced stays first-class

* `/bi/placement/devices?placed=unplaced` is the screen's DEFAULT view, because
  it is the work.
* The filter is on whether a `device_locations` row EXISTS, not on
  `floor_id IS NULL` — "placed on a site with no floor" is a rooftop meter, not
  an unplaced device.
* `/bi/summary`'s `floors` still returns the unplaced group as a row with a NULL
  id, and the screen renders it in italic as *Unplaced* rather than as a bucket.
* Nothing defaults a device to the first floor, and no device is hidden for
  having no placement.

### What is on the wire, and what still is not

Still nothing. The gateway has no placement field and this change does not add
one, because a placement is not something the gateway can know: conflux sees a
connection, a tag, a category and an equipment kind, and no MQTT payload says
which storey the panel is bolted to. Placement is an operator's statement, it is
made on the platform, and it stays there.

### Verified on live data (2026-08-31)

Through the REAL screen, signed in as a real user:

* the `4F` tag-prefix group was clicked (18 devices), the seven devices whose own
  tag names TWO floors (`4F-3F …`, `4F-5F …`, `4F-6F …`) were deselected by hand,
  and the remaining 11 were placed on `Aeon Tower / Level 4` — the site and floor
  created earlier through core's own `/sites` and `/floors` APIs (§16).
* `/bi/summary` placement moved from `0 of 314` to
  `{points: 314, with_site: 181, with_floor: 181, with_zone: 0, unplaced: 133}`,
  and `floors` returned `Level 4 · Aeon Tower → 181 points / 11 devices` beside
  `null → 133 points / 18 devices`.
* `/bi/query` grouped by `floor_name` over six hours returned
  `Level 4 → 8,513 samples` and `null → 6,251` from `readings_1h`.
* a caller holding `bi.read` but not `bi.manage` got
  `403 missing permission(s): bi.manage` on the write and `200` on the read; a
  role carrying `bi.manage` was created and deleted through core's own
  `/auth/roles`, so the key is genuinely grantable.
* the writer kept running throughout: 0 malformed, 0 batch failures, 0 NAKs.

**Left deliberately undone.** The point-level override has an API
(`POST /bi/placement/points`, `…/points/reset`) and no screen — the device list
reports how many of a device's points carry one, so the state is never invisible,
but placing an individual point is not yet a click. It is the exception, and
building the exception's UI before anyone has hit the case would be guessing at
its shape.

**Two bugs found and not fixed, neither in this work's path.**

* Core's dev container hangs on reload. Editing any file under `backend/core/app`
  triggers uvicorn `--reload`, which logs *"Waiting for connections to close"* and
  never finishes, because the SSE relays (`/api/v1/realtime/…`) hold open
  connections that nothing closes. Core stops answering — including
  `/auth/login` — until `docker compose restart core`. Hit once here by a
  one-line edit to `permissions.py`. The fix is a shutdown timeout or closing the
  relays on the lifespan's teardown; neither is this change's business.
* `GET /files/branding/logo_<hash>.svg` 404s on every page of the app, Portfolio
  and Placement alike. Pre-existing, unrelated, and the only failing request on
  either screen.
