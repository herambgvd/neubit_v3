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
    "env": { "src": …, "v": 0.98, "u": "", "ts": 1756450000000, "q": 0, "kind": "" }
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

---

## 4. JetStream configuration

`EVENTS` already exists (`subjects=["tenant.>"]`) and therefore already captures
these subjects. Check its retention and limits before relying on it: a stream
sized for occasional domain events is not sized for a sensor feed. If it is not
suitable, add a dedicated stream for `tenant.*.iot.>` rather than widening
`EVENTS` and changing the retention of everything else.

The writer consumes as a **durable queue-group consumer**. That is what gives
redundancy without any coordination code: run two or more writer replicas and
NATS distributes messages between them. No leader election, nothing to configure
per replica.

---

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
