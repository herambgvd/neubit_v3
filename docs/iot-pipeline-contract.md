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
4. **The alert body shape** — CONFIRMED as Phase C sent it
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

**This is a live deployment decision, deliberately left unmade.** Until
`VE_READINGS_TENANT_MAP` names a real platform tenant, readings land under a
synthetic tenant id that the UI does not know. Either configure the gateway
connection with the platform tenant UUID (the clean fix, and then rule 1 applies
and no mapping is needed), or set the map in `deploy/.env`.

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
