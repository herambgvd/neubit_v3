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

Three streams. The first two must not overlap: NATS refuses overlapping subjects
between streams on one account, and that constraint is what forces the split
below. The third is off the tenant subject space entirely.

| stream | subjects | limits |
|---|---|---|
| `EVENTS` | an explicit list of domains — `tenant.*.access.>`, `.core.`, `.device.`, `.erasure.`, `.fire.`, `.ingest.`, `.notify.`, `.sites.`, `.tags.`, `.tenant.`, `.vms.`, `.workflow.` | unbounded (unchanged) |
| `IOT_READINGS` | `tenant.*.iot.>` | `max_bytes` 8 GiB, `max_age` 7 days, `max_msg_size` 1 MiB, `discard: old` |
| `EVENTS_DLQ` | `dlq.>` | `max_age` 30 days, `max_bytes` 1 GiB, `max_msgs` -1, `discard: old` (`VE_DLQ_STREAM_*`) |

### `EVENTS_DLQ` — bounded 2026-08-31, and who owns which half

It was created with exactly the shape that forced the `EVENTS` narrowing —
`max_msgs=-1, max_bytes=-1, max_age=0`, file storage. Unbounded, on disk,
forever. Nothing had gone wrong yet only because little had been dead-lettered,
which is luck rather than a limit.

TWO SIDES create it, so bounding it was a coordination problem before it was a
config change. The split, and it is the only one that cannot flap:

* **Python owns convergence.** `kernel.events.ensure_dlq_stream` now
  `update_stream`s an existing DLQ onto the limits above, the same way
  `ensure_events_stream` converges the subject list. This is the side that has
  the convergence machinery, and the platform always runs Python.
* **Go stays create-only and tolerant.** `gokernel/events`' `ensureStream`
  calls `AddStream` and nothing else, and its `streamExists()` swallows the
  "stream name already in use" error that `AddStream` returns when an existing
  stream's config differs. It therefore CANNOT overwrite the limits, and nothing
  on the Go side had to change for them to hold here.

**⚠ The Go side must never gain an `UpdateStream` for this stream.** Two
converging sides would rewrite each other's config on every restart, which is
the flapping the split exists to avoid.

**Known gap, and it is a Go-repo change.** `ensureStream` passes NO limits, so an
NVR booting STANDALONE — with no Python service behind it to converge — creates
`EVENTS_DLQ` unbounded and it stays that way. The fix is a bounded
`nats.StreamConfig` at CREATE time matching the values above; not an update call.

`discard: old` is not negotiable. With `discard: new` a full DLQ makes the
dead-letter publish FAIL, and both buses then log "message dropped" and terminate
the message anyway — parked messages would become lost ones. A dead-letter queue
must never become backpressure on the thing that feeds it.

Sizing: the DLQ receives only from the kernel bus's terminal failures. The IoT
feed never reaches it — the reading-writer and the projector run `max_deliver=-1`
and have no DLQ path at all (see §18). `EVENTS` holds ~137 messages / 72 KB in
steady state at ~530 B an envelope, so 1 GiB is on the order of two million dead
letters: unreachable for a working system and a hard stop for a poison storm.
AGE is the limit that will bind.

**The DLQ is watched now (2026-09-01).** The projector runs a durable consumer
on it (`backend/projector/app/dlq_watch.py`, durable `projector-dlq-watch`):
counts by origin subject and refusal reason on the projector's `/stats`/`/metrics`
(`dlq_*` keys), the stream's live message count, and a `DEAD LETTER:` warning
line per new arrival. Observation only — `EVENTS_DLQ` is limits-retention, so
the watch's acks remove nothing; replay/purge stays a deliberate `nats` CLI
action. It is a view, not a triage UI.

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

**Narrowing a subject list does not EVICT what is already stored.** `EVENTS` kept
626 `tenant.default.iot.reading.*` messages across 313 subjects long after it
stopped accepting them — the exact disk leak the narrowing existed to prevent,
in fossil form, and it would have sat there forever because the stream is
unbounded on purpose. Purged 2026-08-31:

    nats stream purge EVENTS --subject 'tenant.default.iot.reading.>'

**By SUBJECT, never a bare `nats stream purge EVENTS`.** A bare purge empties the
stream, and `EVENTS` is where every access event, site change and lifecycle ping
on the platform is persisted. Verified after: 0 messages remain on any `iot`
subject, the stream went 755 → 137 messages and 410 KB → 72 KB, every other
subject kept its count, and all 22 durable consumers survived.

Whoever narrows a subject list next inherits this: check for fossils.

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
| reading-writer (`app/`) | the readings schema. The only thing that writes it. |
| reading-writer (`app/projections/`) | the relations declared in `reporting_projections`. The only thing that writes them. Same process since 2026-09-05, still a different owner — §22. |
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

> **2026-09-05.** `reporting-projector` is no longer a container. Both writers are
> `backend/reading-writer` now — `app/` and `app/projections/` — and the two-owner
> table above still describes exactly what each writes. See §22 for what was kept
> and what one process had to be made to hold.

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

---

## 18. Poison messages on this pipeline are ACKED, not dead-lettered (2026-08-31)

> **CLOSED 2026-09-01.** All four defects below are fixed. The reading-writer and
> the projector now copy a malformed message to `EVENTS_DLQ` (body intact,
> refusal reason in the same `Nbt-Dlq-*` headers the Go bus writes) and `term()`
> it on FIRST delivery — `kernel.events.dead_letter` is the one Python
> implementation both use. `kernel.events` gained the `Unprocessable` marker
> (Go's `events.Unprocessable` equivalent: unmarked errors stay retryable,
> marked ones dead-letter + term on delivery 1). `kernel.lifecycle`'s offboard
> and provision handlers no longer catch-and-ack a retryable failure. And the
> projector runs a DLQ watch (`app/dlq_watch.py`): counts by subject/reason on
> `/stats`, a log line per new dead letter. The paragraphs below are the record
> of what the defect WAS.

**The reading-writer and the projector have no dead-letter path at all, by
construction.** Both resolve a message that can never become a row by `ack()`ing
it — `reading-writer/app/pipeline.py` and `projector/app/pipeline.py` — and both
run their consumers with `max_deliver=-1`, so JetStream's own dead-letter
trigger can never fire either. The message is counted
(`*_malformed_by_reason{reason=…}`) and logged, and then it is gone. That is not
silent in the sense of unlogged, but it IS unrecoverable: nothing holds the body.

This is the receiving half of the loss §3 names as `bad_uuid:conn_id`, and it is
wider than that one field. `projector/app/extract.py` can refuse a message as
`missing:<col>`, `bad_time:<col>`, `bad_uuid:<col>`, `bad_int:`, `bad_number:`,
`bad_bool:`, `undecodable_body` or `body_not_an_object`, and every one of those
ends in an ack. A conflux-side fix for the `conn_id` half does not make the next
poison message visible. Measured today: 2 alerts dropped as `bad_uuid:conn_id`
on `tenant.default.iot.alert.aeon`, and their bodies are not anywhere.

The honest fix is `term()` after a copy to `EVENTS_DLQ`, exactly what
`kernel.events` already does for the domain bus — which is also what would make
the DLQ's limits matter to this pipeline rather than only to the kernel bus.

**Two more, on the kernel bus rather than this pipeline:**

* `kernel/kernel/events.py` has no retryable / non-retryable taxonomy. Only a
  `json.loads` failure terms early; a cross-tenant mismatch, an unknown tenant
  and a bad UUID each burn the full five-delivery backoff budget before reaching
  the DLQ they were always going to reach. The Go bus grew
  `events.Unprocessable` / `Retryable` for this, so the two buses are asymmetric
  until Python gains an equivalent.
* `kernel/kernel/lifecycle.py`'s `subscribe_tenant_offboard` acks a RETRYABLE failure: a tenant-offboard (GDPR
  erasure) that fails because the database is down is acked and never retried.
  That one is a correctness bug, not an observability one.

---

## 18. Correcting §17 — the pin already had a home (2026-08-31)

§17 built a placement feature: `POST /api/v1/bi/placement/devices`, a worklist at
`/bi/placement/devices`, a point-level override, and a screen. It worked, and it
was the wrong shape, because the platform already had this feature.

**Configurations → Sites → floor plan** (`frontend/src/components/floor-builder/`)
is a full editor: upload a plan, draw zones, pin devices onto the drawing at
`{x, y, rotation}`. `neubit_control.device_placements` carries `site_id` /
`floor_id` / `zone_id` beside that position, and `app/sites/device/service.py` has
emitted `placed` / `placement_updated` / `placement_removed` on the NATS spine
since it was ported. So placement had a table, a UI and an event stream. §17 gave
the same fact a second table, a second UI and a second write path — and nothing
that would notice when the two disagreed.

`0010_device_locations`'s docstring argued the two were different facts:
`device_locations` says WHICH ROOM, `device_placements` says WHERE ON THE
DRAWING. That is still true of the columns. It is not a reason for two SCREENS.

### What is true now

* **One statement.** An IoT device is one more placeable device in the floor-plan
  palette, beside cameras, NVRs, controllers and doors — sourced from
  `GET /bi/devices` (a device is placeable because it has REPORTED), placed as
  `device_type: "sensor"`, `service: "iot"`, with its BI category and equipment
  kind carried in the placement's `metadata` so the canvas can draw a chiller
  differently from a meter.
* **One mirror.** `reading-writer`'s `app/placement_sync.py` binds a durable
  JetStream consumer on `tenant.*.sites.device_placement.>` (EVENTS) and writes
  `device_locations` through the same `place_devices` / `unplace_devices` §17
  built, ending in the same `reconcile_placement()`. `device_placements` is the
  source of truth; `device_locations` is reporting's read-model of it, which is
  what lets `/bi/*` join without crossing databases.
* **Names still come from core.** Not by an HTTP round-trip any more: core reads
  `sites` / `floors` / `zones` and publishes `site_name` / `floor_name` /
  `zone_name` ON the event. The authority states the label instead of being asked
  to confirm one, and no browser is in the path.
* **The tenant comes from the BODY.** `sites/events.py` publishes a super-admin
  action (tenant NULL) under the reserved literal subject segment `platform`.
  `device_locations.tenant_id` is a real uuid. Such a message is ACKED, counted as
  `placement_sync_skipped_no_tenant` on `/stats`, and logged once at INFO — not
  retried forever, not stored under a fabricated tenant, not an exception.
* **Inheritance is unchanged.** A point reporting for the first time still
  inherits its device's placement on the write path. Re-verified below.

### Removed

`/bi/placement/*` (all four routes), their request/response schemas, the
`placement_devices` / `placement_overview` queries, `features/bi/Placement.tsx`,
the route `app/(app)/bi/placement/page.tsx`, the launcher's "Placement" tile and
`bi.placement` in `features/bi/api.ts`. Portfolio keeps its placed/unplaced counts
— they read `points` and stay true — and now links to Sites.

### Two capabilities genuinely lost, stated rather than hidden

1. **Site-without-floor placement.** `device_placements.floor_id` is NOT NULL, so
   the rooftop meter that belongs to the building and to no storey can no longer
   be expressed. `device_locations` still models it and the reconcile still
   handles it; nothing can write it.
2. **The point-level override.** `/bi/placement/points` was the only way to say
   "this sub-meter is not where its panel is". `reconcile_placement` still refuses
   to touch a row marked `placement_source = 'point'`, and
   `app/api/placement.py`'s `place_points` / `reset_points` are kept whole, but no
   route reaches them: today the capability is unreachable outside SQL. The floor
   plan is device-level by construction, so restoring it needs a decision about
   where a point-level pin would live, not just a route.

### Verified on live data (2026-08-31)

Through the REAL floor-plan editor, signed in as a real user, on the live `aeon`
estate (29 devices / 314 points; baseline 11 devices placed, 181 points placed):

* a zone was drawn on `Aeon Tower / Level 4` and two IoT devices were dragged out
  of the palette onto it — `4F-3F Light DB` (energy / distribution-board, 6
  points) and `1F York Chiller01` (hvac / chiller, 6 points). The palette listed
  all 29 IoT devices with their point counts and a per-category icon.
* `device_placements` gained two rows with `service: "iot"`,
  `metadata: {iot_category, iot_type, device_tag}`.
* `device_locations` went 11 → 13, both new rows `source = 'floor_plan'`,
  `zone_name = 'Zone 1'`, `placed_by` = the acting user; `points` went
  181 → 193 placed / 133 → 121 unplaced, and Portfolio's panel reported
  `193 of 314` with `Level 4 · Aeon Tower → 193`.
* **inheritance:** a reading was published on `tenant.default.iot.reading.*` for a
  BRAND-NEW `point_id` of the already-pinned `4F-3F Light DB`. The `points` row the
  writer created came out `Aeon Tower / Level 4 / Zone 1`,
  `placement_source = 'device'` — placed, with no new pin. (The synthetic point and
  its reading were then deleted; the estate is back to 314 points.)
* **removal:** deleting the chiller's placement drove `device_locations` 13 → 12
  and `points` 193 → 187 placed; re-registering it restored 13 / 193.
* **the `platform` tenant:** a `device_placement.placed` event published on
  `tenant.platform.…` with a NULL body tenant was acked with
  `placement_sync_skipped_no_tenant: 1`, `placement_sync_errors: 0`.
* `/readyz` green throughout, `placement_sync_errors: 0`.

---

## 19. Insights and Ratings (2026-08-31)

The last two Building Intelligence tiles. §13 left both SOON for the same stated
reason — "a rating needs a benchmark and a unit; a correlation needs to know what
each point MEASURES". **One half of that was wrong and the other was right about
the obstacle and wrong about the conclusion.**

### Insights & Correlation was never blocked

Correcting §13: a correlation does NOT need to know what a point measures.

* **Pearson's r is dimensionless.** It is a covariance divided by two standard
  deviations, so the units cancel. An empty `points.unit` blocks a RATING
  (kWh/m²/yr is a unit statement); it does not block a coefficient.
* **The series are not unnamed.** Each carries `device_tag` / `point_tag` — the
  source's own labels, stored as sent.

What is forbidden is INTERPRETING the number, and `/bi/correlation` + the screen
supply no interpretation: no driver, no ranking of causes, no "because". The
warning is rendered on the screen, not left in a comment.

Four rules the endpoint enforces, because a coefficient without them misleads:

1. **Rollups only.** `auto` picks 1m/1h as the charts do, and the reason is
   returned to be printed. There is no raw path at all: r over raw samples would
   be r over whatever happened to share a timestamp.
2. **Aligned buckets only.** The pair query joins on the bucket column, and `n`
   travels with every coefficient. +0.98 over 4 buckets and over 400 are
   different claims.
3. **A frozen series has NO correlation.** One distinct value → zero variance →
   `corr()` is NULL → `status: "undefined_frozen"`, naming the flat side. Not
   0.00. On this estate every energy register is frozen, so this is the normal
   case.
4. **No overlap is absence**, never a zero.

Passing exactly two point ids also returns the aligned `(t, a, b)` samples, so
the scatter and the coefficient come from one definition of "overlapping".
*Verified live:* `4F Khem Chiller01 / IWT` vs `B1-2F4-Sump Pump1 / KW_L1` = +0.58
over 20 aligned 1h buckets, across two categories; `B2_Main Incomer / KWH_kwh`
renders FROZEN with r undefined over the same 20 overlapping buckets.

### Ratings was blocked on inputs with no home, so the inputs got one

An EPI is `kWh / m² / year`. Three inputs; the platform could state none.

**UNIT — the hard part and the trap.** The unit is often visible in the tag
(`_kwh`, `_Hz`, `_V`, `_A`, `_pf`). `GET /bi/units` offers that as a SUGGESTION
carrying the pattern it matched in words, bulk-selectable over rows the operator
sees first. `POST /bi/units/confirm` takes an EXPLICIT list of point ids and
there is deliberately **no server-side pattern expansion** — "apply to everything
matching `_kw`" evaluated on the server is a guess wearing a human's authority.
Silently deriving a stored unit from a tag stays forbidden; this is §17's
floor-prefix rule in a new place (`4F-3F AC DB` names two floors). A point nobody
confirms keeps a NULL unit and is counted as unconfirmed.

`points.unit_source` / `unit_confirmed_at` / `unit_confirmed_by` (reporting
migration `0012`) record who said it, which makes the writer's guard strictly
stronger than the COALESCE added in `a427e0b`. COALESCE only stops a message that
says NOTHING from blanking a unit; a unit marked `'operator'` is now **not touched
at all**, so a message that says something DIFFERENT cannot erase an operator's
assertion either. That closes the last note in §12's "Known, left alone".
*Verified live:* 14 points confirmed as kWh through the screen, then real aeon
readings arrived — `last_seen_at` advanced and `unit` / `unit_source` did not
move.

**AREA / TARIFF / OCCUPANCY — beside the address, not on a BI screen.** `sites`
gains `gross_floor_area_sqm`, `energy_tariff_per_kwh`, `tariff_currency`,
`occupancy` plus their own `building_facts_updated_at` / `_by` (core migration
`0018`), edited on a new "Building" tab in Configurations → Sites. §18's rule
again: one place per fact. `PUT /sites/{id}/building-facts` is its own route
because `PATCH /sites` applies `exclude_none=True`, so a null cannot be sent
there and a recorded area could never be taken back — and a wrong figure an
operator cannot retract is worse than none.

They reach BI as `neubit_reporting.site_facts` through `site_facts_sync.py`, a
second durable consumer on `tenant.*.sites.site.>`, built exactly like the
placement mirror: the tenant comes from the BODY (a `platform` subject segment is
not a uuid), a tenant-less message is acked and counted, and every site event
carries the facts read from the row core just committed — so a missed message is
corrected by the next site edit of any kind. *Verified live:* saved on the Sites
screen and present in `site_facts` within the same second.

**BENCHMARK — still absent, and stated.** BEE star bands and IGBC thresholds are
published per building type, per climate zone and per version of a standard. This
repository holds no such document, and a threshold typed from memory would be an
invented grade wearing a real EPI's credibility. So the EPI ships as a MEASURED
figure and the band panel says what it would take to exist. **This is the one
part of Ratings still incomplete, and it is incomplete on purpose.**

**The rating** (`GET /bi/rating`) reads `readings_1h`, never the hypertable.
Consumption is `last − first` per register; a register that went DOWN is a reset
or rollover and contributes nothing (never an absolute value), and one that did
not move contributes zero, which is a measurement. **Which meters count is an
argument, not a stored fact**: nothing says which register measures a whole
supply, guessing from a tag would be an invention, and summing every confirmed
register would double-count an incomer against its own sub-meters. The response
carries each meter's own subtraction, the days actually covered, the annualisation
factor and the division, so the score can be checked by hand.

Any missing input → `epi: null` and a `blocked` list in words, with a link to
Configurations → Sites. Never a partial score, never a default area, never a
national average.

### What is left SOON in Building Intelligence

**IAQ & Environment only.** There are still ZERO `environment` points.

## 20. The metric registry — derived metrics as DATA (2026-08-31)

§11 of the dashboard contract put the first derived value (chiller ΔT) in the
DATASET registry as a row, with the argument that "the mechanism generalises;
the row is specific". This section is the same argument one level up: a
**metric** — a formula over named point roles, with unit requirements, guards
and display — is now a row in `neubit_reporting.metric_definitions`, so a new
sensor domain becomes configuration instead of code. There is no end-user
formula editor in this iteration; specs enter as data (seeded by migration
`0014_metric_registry`, or `POST /bi/metrics` under `bi.manage`). The registry
is the foundation a later editor UI sits on.

**The shape.** `metric_definitions(tenant_id NULL=platform, key, version,
effective_from, kind formula|composite, applies_to, inputs, formula,
components, output, guards, display, created_by/at)`. An input is
`name → {role, dimension|unit, aggregation}` — the binding to actual points
goes through `point_roles`, never through a tag. `kind='composite'` is a
weighted sum of other metrics' outputs (the future CCEI shape) — schema and
evaluator support only, no UI.

**Type-check AT REGISTRATION.** The formula is a tiny whitelisted language —
literals, input names, `+ − × ÷`, parentheses, `abs()`, `annualize()` — parsed
with Python `ast` against a strict node whitelist (`app/metric_registry/expr.py`;
never `eval`). At insert, the dimension algebra (`units.py`) must produce the
declared output: temperature − temperature = temperature_delta (a DISTINCT
dimension, so a ΔT can never average with an absolute reading); temperature +
temperature is refused; kWh − °C is refused; °C vs °F is refused because
conversion is not modelled — nothing converts silently. A spec that cannot
type-check is a 422 naming the dimension error and NOTHING is stored.
*Verified live:* an `e − t` spec over kWh and °C came back
`definition rejected: formula does not type-check: cannot subtract 'energy'
and 'temperature'` and the definitions list did not grow.

**Versioning.** A formula change is a NEW version with its own
`effective_from` — recomputing yesterday's window with today's formula is
silent history rewriting. `GET /bi/metrics/evaluate` picks the version
effective at the END of the evaluated window and returns which one it used.
There is no PUT and no DELETE.

**Roles are §19's unit rule in a new place.** `GET /bi/metrics/roles` offers
tag-derived SUGGESTIONS with the matched pattern in words (`IWT` →
`inlet_water_temp`, "the tag is `IWT` — entering water temperature by this
estate's convention"); `POST /bi/metrics/roles/confirm` takes an EXPLICIT
point-id list under `bi.manage`, no server-side pattern expansion, and
`role: null` clears (the `point_roles` row is deleted). The vocabulary is
closed (`roles.py::ROLE_DEFS`), each role carrying the dimension the
type-checker holds definitions to. Screen: `/bi/metrics`
(`features/bi/MetricRoles.tsx`), the Units tab's anatomy exactly.

**Refusals are structured, mechanized from dashboard-contract §4.** Every
evaluation item is `{status, reason}`: `missing_role`, `ambiguous_role`,
`unit_unconfirmed` (an input whose point has no OPERATOR-confirmed unit never
computes on an assumed one), `unit_mismatch`, `no_data`, `undefined_frozen`
(zero variance over the window, naming the flat input — Insights' discipline
inherited), `blocked` (division by zero; a composite of a refusal is a
refusal). Never 0, never null-that-renders-as-0. The evaluator reads
`readings_1m`/`readings_1h` ONLY, states its resolution and reason, and
refuses `raw` by name. `avg` is the sample-weighted mean
`sum(num_sum)/sum(num_count)` — the SAME definition the dataset registry's
`ratio` uses, so the two paths cannot disagree on a mean.

**First row: `chiller_delta_t` v1** (`owt − iwt`, roles outlet/inlet_water_temp,
output temperature_delta, guards roles_present + units_confirmed + same_unit +
non_frozen), seeded by migration 0014. With 0 units and 0 roles confirmed its
honest state on this deployment is BLOCKED on every chiller, and that is
correct. **Fixture parity, run and retracted the same hour:** roles + `degC`
temporarily confirmed via the registry's own APIs on `4F Khem Chiller01`'s
IWT/OWT (and `1F York Chiller01`'s, to exercise the frozen path), then:

* registry `chiller_delta_t` on Khem01 over 24h @1h: **−1.9173421633554106**,
  with the working shown (`owt - iwt = 16.7013 − 18.6187 = -1.91734`);
* the hardcoded dataset path (`/bi/query`, measure `delta_t`, avg, same
  window): **−1.917342163355407** — parity to 1e-12;
* York01: `undefined_frozen — input iwt (IWT) held one distinct value (7)
  across 144 samples`; a demo composite over it: `blocked — a composite of a
  refusal is a refusal`;
* everything retracted through the same APIs (`role: null`, `unit: null`):
  store back at **0 confirmed units, 0 point_roles**, and the metric BLOCKED
  again. Nothing invented remains.

The hardcoded ΔT display path (`DeltaT.tsx` → dataset measure `delta_t`) is
UNTOUCHED; swapping it onto the registry is deliberately deferred until the
portfolio work lands.

## 21. Building Intelligence goes live on decided inputs (2026-09-01)

§19 built the surfaces and §20 built the registry, and both left the estate at
0 confirmed units, 0 confirmed roles, no benchmark, no emission factor, no
score. This section records the day the inputs were DECIDED — what was
confirmed, what was refused, and the evidence for each.

**The delegation, and its scope.** The platform owner explicitly delegated
these decisions to the operating agent ("joh mere inputs hai uskoh tum apne
seh proper decide karrloh"). Every confirmation below therefore went through
the REAL APIs under the owner's account (user `3cd1c8ca-c927-41af-9101-
c345241c7492`), which is whose decisions they are, and the store's provenance
records them as operator assertions. The delegation covers decisions EVIDENCE
can support; it does not license invention — which is why the honest outcome
below is 186 of 314 units, 17 roles, one cited benchmark, one cited emission
factor, and a portfolio score that refuses.

### Units: confirmation by corroboration, never by tag alone

The rule: a unit is confirmed ONLY where the tag pattern AND the measured
values agree. Every live point's rollup history was sampled first
(`readings_1h`, 2026-08-30T05:00Z → the confirmation instant, n≈238–269
hourly samples per point), then confirmations went through
`POST /bi/units/confirm` in pattern-sized batches with EXPLICIT id lists (the
API refuses patterns by design; each batch's exact ids are logged in the
session record, mirroring the UI's show-the-list-first honesty).

**186 confirmed, 10 batches:**

| batch | unit | n | corroboration evidence (sampled) |
|---|---|---|---|
| Hz | `Hz` | 14 | every value 49.86–50.03, inside the 45–65 grid band |
| degC | `degC` | 13 | IWT/OWT 6.8–34 °C chilled-water band (Khem01 live 0–34 avg 22.8, **0.00 placeholder readings present** — noted, they do not disprove °C); Amb Temp 30.4/30.8; Inv_Temp 32.8–49.9 (inverter internals) |
| PF | `""` (dimensionless) | 16 | every value within \|v\| ≤ 1 (0.51–1.00 and −0.67…−1.00; the negatives read as the signed/IEEE convention — CT polarity or export — and are physically PF-shaped; documented, not hidden) |
| kWh-register | `kWh` | 16 | lifetime registers 2.75–208,972 kWh, non-decreasing (0 decreases over 26 bucket steps each) |
| kWh-period | `kWh` | 6 | TodayKWH/YestKWH 10.5–60.1 kWh — plausible daily solar production; **the unit is true even though these are not lifetime registers; register-vs-period is a ROLE distinction** (see below) |
| kW | `kW` | 37 | cross-checked against each device's own V·I·PF: e.g. 4F_Incomer1_EM 33.55 kW vs 3×0.239 kV×51.4 A×0.94 = 34.6; Sub Incomer1 per-phase 11.1+11.8+12.3 = 35.26 vs its own TOTKW 35.198; UPS 4.585 kW vs 5.75 kVA×0.79 PF = 4.55 |
| kVA | `kVA` | 6 | = 3×V×I on the same device (B2: 3×0.238×113.5 = 81.0 vs 80.19 stored) |
| kVAh | `kVAh` | 6 | non-decreasing apparent-energy registers |
| V | `V` | 52 | 218–243 V — phase band 180–260 (batteries 218/219 V, plausible ~216 V nominal strings) |
| A | `A` | 20 | plausible load currents 8–119 A; B2 cross-check 113 A×3×237 V×0.9757 = 78.7 kW ≈ its own Total_kw 77.6 |

**Contradictory tags were decided by VALUES, and only there.** `KWL1_A`
(prefix says kW, suffix says A) confirmed **kW**: the three phase values sum
to the device's own TOTKW to 0.2% and match V·I·PF; the device's actual
currents are 50–54 A, not 11–12. `BpVoltL1_A`, `VoltAvg_A`, `VoltL2_A`,
`VoltL3_A` confirmed **V**: 237–239, in the phase band, beside sibling `_V`
points reading the same. Where values could NOT decide, nothing was confirmed.

**128 left unconfirmed, each with its reason** (full per-point list in the
session record; the classes):

* **Frozen at exactly 0.0 for their whole history (76 points)** — `B1-1F1-
  Incomer` entirely (V/A/kW/kWh/Hz/PF all zero), `4F_Sub Incomer2`'s kW/kVA
  side, `4F_Incomer_EM`'s instantaneous side, solar TOTKW/TOTDCKW/TOTKWH and
  This/Last-period registers, UPS battery currents, four PF points, two dead
  kWh registers. A constant 0 corroborates every unit equally, i.e. none.
* **Solar inverter deci-scaling (17 points)** — `DCVolt*` store 3792–5097,
  IMPOSSIBLE as PV-string volts (≤1500 V); under a ×10 reading (379–510 V)
  everything reconciles: DC power ≈ AC power ≈ the measured daily kWh
  (TodayKWH/YestKWH 10.5–60.1 for 3–10 kW inverters). The same test convicts
  `CurrL*_A`@Panel02 (130 stored → 13 A real: 130 A would be 93 kW AC from a
  9.6 kW DC array) and `CurrL*_V`@Panel01/03 (38–52 stored → 3.8–5.2 A). The
  stored NUMBER is not in the tag's unit, so the unit was NOT confirmed —
  confirming V or A onto deci-values would poison every downstream quantity.
  The fix is a gateway scaling correction, not a unit assertion.
* **No unit vocabulary for the tag (23 points)** — `On Off STS` (a state),
  `Work_Mode`, `Load`/`SYS Load` (%, of an unrecorded capacity), `Batt_Cap_*`
  (%), `Batt_Time_Rem` (probably minutes), `Run Hours`, counters (`Point1`,
  `Last_Year`), and the water meter's four flow points (`Cum_Flow` 0.149
  lifetime — m³? L? counts? — nothing corroborates a magnitude that small for
  a building supply).
* **A kW spike that isn't one (1 point + its board)** — `KW_L2`@`B1-2F6-LDB-1
  Count Timer`: zero except a single 42.5 excursion; 42.5 kW on one phase of a
  lighting DB is ~190 A, implausible, and the device is a *Count Timer* — the
  number may be a count. Unconfirmed.
* Plus `Freq_Hz`@B1-1F1 (0.0 ≠ grid frequency) and the remaining frozen-zero
  singletons counted above.

The target was honesty, not 314/314. **Live counts after the batches:
`points: 314, confirmed: 186, unconfirmed: 128`** — and the writer's §19
guard keeps every one of them safe from the wire.

### Roles: chillers bound; energy registers bound WITHOUT double-counting

* **`inlet_water_temp` / `outlet_water_temp`** confirmed on all four chillers'
  IWT/OWT (8 points). Each registry suggestion was verified against sampled
  values before confirming (York 1F 7.0/9.3, York 2F 6.8/10.8, Khem01 live,
  Khem02 25.6/13.5 — all chilled-water-plausible °C).
* **`energy_register`** confirmed on exactly THREE registers, because the
  registers themselves exposed duplicate metering: `KWH_kwh`@4F_Incomer_EM =
  7350.731 kWh, IDENTICAL to `KWH`@4F_Sub Incomer2, and its kVAh twin is
  identical too (8840.7607) — one physical meter listed as two devices.
  `KWH_kwh`@4F_Incomer1_EM = 208,951 vs `KWH_kwh`@4F_Sub Incomer1 = 208,972 —
  the same meter (or same feeder) captured ~21 kWh apart. Binding both of a
  twin double-counts the same energy, so the `*_EM` device of each pair was
  bound and the `Sub Incomer` twin left unbound with that reason. Bound:
  **B2_Main Incomer, 4F_Incomer1_EM, 4F_Incomer_EM** (their `KWH_kwh`
  registers). The register magnitudes argue these are parallel supplies, not
  a series chain (a 9.4k-kWh register upstream of a 209k-kWh one would need a
  very recent meter install); if the feeder tree is ever recorded and says
  otherwise, rebind — the topology is NOT a stored fact today and that gap is
  stated here rather than papered over.
* **Left unbound, with reasons:** every downstream DB board (4F-3F/5F/6F,
  B1-2F*, Guard Room — sub-meters of the bound supplies; binding them would
  double-count), the dead `KWH`@B1-1F1-Incomer (frozen 0, unit unconfirmed),
  and `2FChiller1EM_kVAh` (apparent energy, wrong dimension for the role).
* **`energy_period_total` — the vocabulary grew** (roles.py, code this section
  owns): TodayKWH/YestKWH are genuinely kWh but RESET each period, so a role
  now exists that says so, and the 6 live solar period totals are bound to it.
  The suggestion rules were fixed in the same change: period-scoped tags
  (`This_Year_KWH` was the trap — it matched the register rule) now suggest
  the period role, never `energy_register`.
* **Placement gap, found not fixed:** `B2_Main Incomer` and `2F York
  Chiller01` are UNPLACED (no `site_id`), so their role bindings exist but no
  SITE metric counts them until somebody places the devices on the floor
  plan. Placement is a floor-plan statement; inventing one here would be §17's
  sin, so the gap is recorded instead.

### The ΔT swap: one definition of a number, then the dead one deleted

With roles and units now REAL (not fixtures), §20's parity was re-verified
live over one shared 24h window: registry `chiller_delta_t` on Khem01
**−1.8558794708476256**, dataset measure `delta_t` **−1.855879470847622** —
diff 3.6e-15, within the 1e-12 bound. `DeltaT.tsx` then swapped onto
`GET /bi/metrics/evaluate` (value + working when ok; the refusal's own
`{status, reason}` when not — the frozen York fleet renders
`undefined_frozen` naming the flat input, never 0.0), and migration
**0015_retire_dataset_delta_t** deleted the dataset measure — the same
UPDATE 0009's downgrade specified, after checking that no saved widget or
dashboard version referenced it. `/bi/query` now refuses `delta_t` by name.
The `difference`/`where` MECHANISM stays; only the domain row went. The UI
copy stands: negative ΔT is the correct sign (leaving − entering).

### The benchmark: pinned, seeded WITH its citation — and versioned honestly

Searched: BEE's star-rating scheme for office buildings. PINNED to the
primary document and read in full:

> Bureau of Energy Efficiency (Ministry of Power, Govt. of India), "Scheme
> for BEE Star Rating for Office Buildings — Details of the scheme for rating
> of office buildings", **February 2009**, Annexure 4.
> https://beeindia.gov.in/sites/default/files/BEE%20Star%20Rating%20for%20existing%20Office%20Buildings.pdf

Annexure 4's tables are seeded VERBATIM by migration
**0016_benchmark_standards** (`benchmark_standards`, key `bee_star_office`,
version `feb-2009`): EPI bands in kWh/m²/yr for three climate zones
(Composite 190→90, Warm & Humid 200→100, Hot & Dry 180→80 at >50% AC; 80→40,
85→45, 75→35 at <50% AC; 1★–5★). Two scheme facts ride in the row's notes
because a graded EPI must be computed the scheme's way: the EPI **excludes
on-site renewable generation** (the solar registers are correctly NOT in the
supply roles) and excludes basement area; eligibility is ≥100 kW connected
load. **KNOWN AND STATED:** BEE reports a band revision effective January
2022; its table could not be pinned to a primary document during this work,
so it was NOT seeded — a cited 2009 table beats an uncited 2022 rumour, the
seeded version is printed wherever a band renders, and the revision enters as
a NEW version row when pinned.

**The band still does not render for Aeon Tower, correctly:** the site's
climate zone and AC-share category are UNKNOWN. Both are operator inputs on
`benchmark_site_config` (`PUT /bi/rating/benchmark-config`, values validated
against the standard's own tables, null clears; nothing derives a zone from a
city name — the zone→city mapping is its own unpinned document). Ratings'
benchmark panel now states BOTH halves: what exists (the cited standard, by
name and version) and what is missing (zone, category, and the EPI's own
blocked inputs).

### The emission factor: pinned, entered through the real route

Searched: CEA's CO2 Baseline Database. PINNED to the primary document and
read:

> Central Electricity Authority (Ministry of Power, Govt. of India), "CO2
> Baseline Database for the Indian Power Sector — User Guide, **Version
> 21.0, November 2025**", Table S: weighted average emission factor of the
> Indian Grid for FY 2024-25 (adjusted for cross-border electricity
> transfers, including RES & captive power injection) = **0.710 tCO2/MWh**.
> https://cea.nic.in/wp-content/uploads/baseline/2025/12/User_Guide_V_21.0.pdf

Entered for Aeon Tower as **0.710 kgCO2/kWh** via
`PUT /sites/{id}/emission-factors` (core; `source` REQUIRED there — factor id
`548694fb-c6f4-4f67-8298-639380aa642f`), with the source text carrying the
full citation PLUS the assumption said out loud: *national grid average; the
site's country/DISCOM is not recorded — replace with a state/DISCOM factor if
desired; India inferred from the estate's own context (INR tariff, BEE/IGBC
benchmarks, Indian tenants).*

### CCEI v1 — the definitions are DESIGN, recorded here as such

Three definitions registered live through `POST /bi/metrics` (type-checked at
registration, versioned, operator-attributed):

* **`ccei` v1 (composite, site scope): 0.6 × intensity_score + 0.4 ×
  hvac_health.** The weights are DATA in the row. A composite of a refusal is
  a refusal — and the item now carries EVERY component's own `{status,
  reason}` (per-device on a fan-out), so the leaderboard's "—" explains
  itself input by input.
* **`intensity_score` v1 (formula, site scope):**
  `benchmark_score(annualize(energy / area))` — energy = Σ(last − first) over
  the site's `energy_register` bindings (the new `consumption` aggregation:
  monotonic-guarded, a decreased register is excluded and reported, exactly
  `/bi/rating`'s arithmetic), area = the `gross_floor_area_sqm` site fact,
  `annualize()` over the COVERED span (same definition as `/bi/rating`, so
  the paths cannot disagree), `benchmark_score()` = position against the
  effective standard's edges — best band edge → 100, worst → 0, linear
  between, clamped. Blocked today: `missing_fact` (no area); once area
  arrives it blocks `no_benchmark` (zone not set) until the config is
  recorded. Each gap is named in order of actionability.
* **`hvac_health` v1 (formula, device scope, chillers):**
  `band_score(abs(owt - iwt), 3, 7)` — a 0–100 score of |ΔT| against a design
  band of **[3 K, 7 K]**, the lo/hi as LITERALS in the formula row (spec
  parameters, visible and versioned, not buried constants). **Band
  rationale:** standard chilled-water practice designs ΔT ≈ 5.5 K (10 °F)
  with a healthy at-load range of roughly 4–7 K and "low-ΔT syndrome" below
  ~3 K; the estate's own live evidence (Khem01 holds |ΔT| ≈ 2–4.4 K, mean
  ≈ 1.9) sits around and below that floor — and the score REFLECTS that
  (Khem01 ≈ 61/100) rather than moving the goalposts to flatter it. Shape:
  100 inside the band, linear to 0 at 0 K below, linear to 0 at 14 K above
  (very high ΔT = starved flow). Frozen chillers refuse (`undefined_frozen`),
  never score.

**The evaluator grew, per the registry's own contract** (§20's rules held:
type-check at registration, structured refusals, rollups only):
`applies_to.scope: "site"` (items = sites from the `site_facts` mirror);
`source: "site_fact"` inputs against a CLOSED fact vocabulary (`FACT_DEFS`);
the `consumption` aggregation (energy dimension only); `band_score` /
`benchmark_score` in the expression whitelist; and two NEW refusal statuses,
both structured: **`missing_fact`** (a site fact is NOT RECORDED — names the
fact and where it is recorded) and **`no_benchmark`** (the standard, the
zone, or the AC category is missing — names which). Composites at both
scopes now report all components; a device-scope component under a site
composite fans out over the site's devices and refuses if ANY device refuses,
each device's status attached.

**The truthful result for this estate, today** (leaderboard `score` slot,
wired to `ccei`): Aeon Tower = **blocked** — `intensity_score: missing_fact`
(no area recorded), `hvac_health: blocked` (2 of the 3 PLACED chillers frozen;
Khem01 alone scores ≈61). The score is a dash WITH its reasons, which is the
designed outcome, not a failure. The unplaced pseudo-row states that a score
is a site's.

### The baseline rule — decided, seeded as config, absence wired live

**Rule: same calendar month, previous year.** Weather drives HVAC load;
August answers August, and a rolling-30-day baseline would compare a monsoon
to a summer and call the difference savings. Until **≥13 months** of history
exist (12 to reach the same month last year + the current month), every "vs
baseline" surface states the absence WITH the day count. Carried as
`BASELINE_RULE` beside `benchmark_state()` in `rating.py` (the same
config-as-code pattern), surfaced on `GET /bi/rating` as `baseline` and
rendered on the Ratings screen. Live today: *"baseline unavailable — needs
≥13 months of history, have 1.6 days."* The absence path is the one thing
~2 days of history can verify, and it is verified.

### Permanence, and what was cleaned up

The unit confirmations, role bindings, metric definitions (`hvac_health` v1,
`intensity_score` v1, `ccei` v1), the seeded benchmark standard, and the
emission factor are DELIBERATE AND PERMANENT — they are the estate's decided
inputs, not fixtures, and nothing retracted them. Nothing throwaway was left
behind: no test specs were registered beyond the three real definitions, no
benchmark config was set for Aeon Tower (its zone is genuinely unknown — an
invented zone would grade a real EPI against the wrong table), and the only
thing entered under core's site facts is the cited emission factor.

### §21 addendum — the BEE January-2022 revision, pinned and seeded (2026-09-01)

§21 left a promise standing: "the revision enters as a NEW version row when
somebody pins it." Pinned, read in full, and seeded by migration
**0017_bee_jan2022_revision** as `bee_star_office` version **jan-2022** —
the feb-2009 row untouched (versioning is data; history stays):

> Bureau of Energy Efficiency, "Schedule for Star Rating of Commercial
> Buildings — Office Buildings", **w.e.f. 01 January 2022**, Section 6 (Star
> Rating Table). Copy hosted by JREDA (Jharkhand Renewable Energy
> Development Agency):
> https://api.jreda.com/all-uploaded-img/Directory/6343f17ec4de0.pdf

**The equation model.** Unlike 2009's fixed EPI ranges, each 2022 band is a
straight-line equation — "y=(a\*b)+c, where 'b' denotes the percentage of AC
area out of total built-up area" — per climatic zone × building size
category (in line with ECBC 2017: Large BUA > 30,000 m²; Medium
10,000 ≤ BUA ≤ 30,000 m²; Small BUA < 10,000 m²). The coefficients are
seeded verbatim (`bands.kind = "linear_by_ac_share"`); the site-specific
band table is computed at resolution time by
`evaluator.linear_band_table()`. Two site inputs feed it: the **size
category DERIVES from `site_facts.gross_floor_area_sqm`** (never stored
separately — a corrected area re-categorises the site), and the **AC share
is a new continuous operator input** `ac_share_percent` (0–100) on
`benchmark_site_config` (`PUT /bi/rating/benchmark-config`; the 2009
`ac_category` column stays for the 2009 version). NULL blocks the jan-2022
band naming exactly `ac_share_percent`.

**Boundary semantics — encoded from the document's own worked example.** The
document's header line ("The equations provide the upper limit of the
corresponding Star Rating. Lower limit will be the value obtained by the
equation of next higher rating") disagrees with its own worked example,
which is the precise statement and is what the evaluator encodes: *"any
building having 75% AC area, and having EPI less than 131.25 kwh/sqm. but
equals to or more than 117.5 kwh/sqm. that building will be awarded 2-star
rating"* (Large, Composite; 131.25 = the 1★ equation at x=75, 117.5 = the
2★ equation). So the s-star equation value is the INCLUSIVE LOWER edge of
the s-star band, the exclusive upper edge is the (s−1)-star equation, 5★ is
open below, and EPI ≥ the 1★ value grades 1★ ("Lowest EPI value for
1-Star"). The contradiction is stated in the seeded row's notes rather than
silently resolved.

**Which version applies.** The latest version whose effective date ≤ the
evaluation window's END — `benchmark_standards.effective_from` (backfilled
2009-02-01 for feb-2009; 2022-01-01 for jan-2022), the same rule the metric
registry applies to definitions. jan-2022 governs today's windows; feb-2009
still grades historical windows ending before 2022. The version in force is
printed wherever a band (or its refusal) renders.

**Known document defects, recorded not repaired silently:** the Terminology
section prints the Medium range garbled as "30,000 m² ≤ BUA < 10,000 m²"
(read as 10,000–30,000, per ECBC 2017 and the document's own fees table),
and the header-line/worked-example disagreement above. Eligibility
(connected load ≥ 100 kW) rides along as a note, NOT a refusal — our EPI is
a measurement, not a scheme application.

**Aeon Tower today:** zone `warm_humid` and `ac_category` `gt50pct_ac` are
operator-recorded placeholders; `ac_share_percent` is UNSET, so the jan-2022
band renders **blocked naming `ac_share_percent`** until someone records it
— and EPI-band grading stays withheld anyway while every supply register is
frozen (that discipline is untouched). Found while wiring this in and fixed:
`PUT /bi/rating/benchmark-config` had been decorating the
`_withhold_band_if_frozen` helper instead of its handler, so the config
route was unreachable.

---

## 22. The projector is a module of the reading-writer now (2026-09-05)

`backend/projector` was 2,520 lines in its own container. It is
`backend/reading-writer/app/projections` and there is no `reporting-projector`
service. This is the second and last of the consolidations; the first folded the
dashforge satellite into core.

### What the split was actually arguing, and why it survives

The projector's `main.py` argued it was *"deliberately a sibling of reading-writer
rather than part of it"* because *"the reading-writer owns the readings schema and
serves its reads (§7, one owner); this owns the relations declared in
`reporting_projections`. Two consumers, two ownership boundaries, one store."*

That argument is correct and it is about OWNERSHIP OF RELATIONS. Ownership of
relations is a code boundary, and a code boundary does not need a second process.
It is unchanged and stated in both directions:

* nothing in `app/projections` writes `readings`, `points` or their rollups, and
  nothing there declares them in `reporting.models`;
* nothing in `app/` writes a projected relation. The BI read API reads
  `iot_alerts`; it has never written it and still does not. `app/api/router.py`
  and `queries.py` say so in the module/PROCESS terms the fold-in made necessary,
  because the old wording ("this service does not write it") stopped being true
  the moment the containers merged and would have read as a false assurance.
* `app/projections` has no `/api/...` and must not acquire one. One read path
  over this store, §8 rule 2 — and the fact that the read path now lives in the
  same process makes reaching for a second EASIER, not more acceptable.

### The constraint that decided the design

The reading-writer is on the hot path: every device reading in the estate flows
through it and it is the only writer of the readings hypertable. Projections
handle domain events at a completely different rate and shape. The failure a
merge creates is a projection backlog, or one slow or wedged projection, stalling
reading ingestion. Four things stop it, and only the last one was new:

1. **A NATS connection each.** Both call `nats.connect` themselves, so a hung pull
   consumes its own client's inflight budget. Four connections from this process,
   named apart (`neubit-reading-writer`, `-projections`, `-placement`,
   `-site-facts`, plus the DLQ watch).
2. **Separate durables.** `reading-writer` on IOT_READINGS versus one durable per
   projection. Unchanged: those durable names live in `reporting_projections`
   ROWS and still read `reporting-projector-*`. Renaming them would abandon a live
   cursor and replay the whole stream to rediscover rows already stored — a
   cosmetic rename buying a real outage.
3. **Separate asyncio tasks and bounded queues.** Every wait is an `await`. The
   one shared resource left is the event loop, and the only synchronous work on it
   is building one batch's parameter dict — bounded by `batch_rows` (200 for
   projections).
4. **Separate connection pools.** THE ONE THE MERGE EXPOSED. `reporting.db`'s
   engine is a single pool (SQLAlchemy's default 5+10). Shared, a projection
   holding connections — a lock wait, a `CREATE MATERIALIZED VIEW` in `ensure`,
   batches piling up across projections — could take all of them, and the readings
   write loop would then block in the pool CHECKOUT. That is the worst possible
   place for it to block: no `statement_timeout` covers a checkout, `db_healthy`
   is never flipped because nothing failed, and the stall watchdog is not armed
   because `begin_write` has not run. Readings stop, silently, because of a
   projection. So `app/projections/db.py` builds its OWN engine on the same
   database (`VE_PROJECTOR_POOL_SIZE` 4 + `VE_PROJECTOR_POOL_OVERFLOW` 4). Two
   pools, two owners, one store.

   Proven, not asserted: with all 8 projection connections held and a 9th checkout
   blocking for the full timeout, the readings pool served
   `select count(*) from readings` in 0.06s.

### Health: two of everything, and a union

`Metrics` and `ProjectorMetrics` are separate objects — separate `db_healthy`,
separate lag, separate stall clocks. `/metrics` carries both exposition blocks,
`reading_writer_*` and `projector_*`, the latter per-projection
(`{projection="access_events"}`), so neither half's number can stand in for the
other's and a healthy access feed cannot hide a wedged alerts feed. `/stats`
nests the projection block rather than merging it, because the two halves have
counters of the same NAME measuring different things and a flat merge would
silently overwrite one.

`/readyz` is the union: 503 when EITHER is wedged, every reason prefixed
`readings:` or `projections:` so a page names the consumer.

The two readiness definitions disagreed and the projector's is strictly the
stronger — it goes red for a REFUSED projection (a domain that believes it is
being collected and is not; this pipeline has produced two of those) and for a
consumer whose pulls keep failing while it receives nothing. Both are KEPT,
applied to the half that has them. Neither was weakened. The readings half did
NOT gain a `consuming` flag here: its fetch loop has the same blind spot, and
that is a change to the hot path deserving its own commit and its own proof, not
a rider on a move.

### Verified on the live stack (2026-09-05)

16 containers, no `reporting-projector` among them. With `reporting-projector-access`
deleted out of band and re-deleted every 500 ms for seven minutes, `/readyz` held
503 with the single reason `projections: projection 'access_events' is not
consuming (pulls failing; rebinding)`, `projector_consuming{projection="access_events"}`
read 0 while `{projection="iot_alerts"}` read 1 — and in the middle of that window
the readings burst landed: `reading_writer_rows_inserted_total` 640 → 960,
`select count(*) from readings` 216,926 → 217,246, `reading_writer_db_healthy` 1
throughout. When the wedge was released the worker rebound itself and JetStream
replayed EVENTS from the start: 189 messages, 3 batches, 117 rows absorbed as
`rows_duplicate`, `access_events` still exactly 39 rows. `ON CONFLICT DO NOTHING`
on the natural key is what made that a no-op instead of an incident, which is why
it is in this contract and not in a comment.

Nothing was injected to prove any of this. The replay re-delivered events already
in the store, so the live store is byte-identical to before.

### `reporting-migrate` did not move

It is the `reporting` package's one-shot migrator
(`build: { dockerfile: reporting/Dockerfile }`), it owns the IoT schema and the
two registry tables, and it was never the projector's. It still runs and exits,
everything still gates on `service_completed_successfully`, and the split it
documents is unchanged — a migration cannot know which relations a projection
declares, so `app/projections/ensure.py` creates those, additively, at runtime.

`neubit_reporting` is unchanged and `deploy/postgres/init-service-dbs.sh` is
untouched: no database left the list, so the healthcheck's completion marker
(`dashforge`) is unchanged. Checked against a FRESH volume in a throwaway compose
project rather than by reading the list, because reading the list is what failed
on 2026-09-01.
