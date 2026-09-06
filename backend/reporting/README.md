# reporting

Schema owner for `neubit_reporting` — the one database on the platform where data
from several services is gathered so it can be queried together. That is the
documented exception to the no-cross-service-reads rule, and it is bought by a
rule of its own: **nothing here reads another service's database.** Everything
arrives over NATS.

This package is a **migrator, not a server**. It runs `ensure_db → alembic upgrade
head → apply the Timescale policies` and exits. The long-running process that
fills the schema is [`reading-writer`](../reading-writer), which imports
`reporting.models` rather than redeclaring anything.

## What is in the database

**The IoT schema.** `readings` is the fact table and is deliberately narrow — ts,
tenant, point, value, quality, nothing else. What decides whether it stays fast is
the number of distinct series, not rows per second, and every extra column
multiplies the cost of every row. Everything that is not a measurement lives in
`points`, the dimension table, so renaming a device rewrites one row instead of a
hundred million.

`num` and `txt` are separate columns and must stay that way. A text reading is a
mode or a status and carries no measurement; storing `0` for it would put a fake
zero into every average on the dashboard. A text reading has `num IS NULL`.

**Site read-models** — `site_facts`, `site_tariff_slabs`, `site_emission_factors`,
`device_locations` — mirrors of what an operator typed into core, fed by durable
consumers of core's site events. NULL means NOT RECORDED, everywhere: `/bi/rating`
produces no rating for a site with no floor area rather than an estimate.

**Registry and catalog tables** — `dashboard_datasets`, `reporting_projections`,
`benchmark_standards`, `benchmark_site_config`, `metric_definitions`,
`point_roles`.

**Projection relations** — `access_events`, `iot_alerts` and their hourly rollups.
These are created at RUNTIME from a `reporting_projections` row, not by a
migration. That is the point of registering a projection as data: a new domain
starts being collected on an INSERT, with no release.

## Nothing here is ever inferred

A point's `unit`, a point's `role`, a device's placement and a site's floor area
are all operator statements, and none of them is guessed from a tag. `KWH_kwh`
looks like it declares its unit and `4F Khem Chiller01` looks like it declares a
floor — but `4F-3F AC DB` names two floors, and a floor-wise chart that is wrong
for one floor in five is worse than one that says "unplaced". Building Intelligence
offers readings like these as SUGGESTIONS for a human to confirm; nothing writes
them without one.

The writer enforces the same rule from the other side: its `points` upsert refuses
to change a unit marked `operator` at all, and never names the six placement
columns, so a reading cannot author or blank a placement.

## Every table a migration creates has a model

`Base.metadata` is not documentation. Two things read it and both are silent when
it is wrong: `alembic revision --autogenerate` proposes `DROP TABLE` for anything
in the database that no model declares, and the tenant erase walks it. Eight
tables had accumulated with no model, including two hypertables of live telemetry.

`tests/test_schema_completeness.py` (in reading-writer, which is where the suite
lives) reads the revision files and fails if a migration creates a table nothing
models. `alembic check` against a live database is the exact form of the same
question and runs at deploy.

The projection relations are absent from both sides of that comparison — no
migration creates them and no model declares them. `migrations/env.py` reads their
names back out of `reporting_projections` so autogenerate leaves them alone. A
hardcoded list would be wrong the first time somebody added a projection.

## Right to erase

`reporting/erasure.py`, wired to core's `tenant.*.tenant.offboarded` in
reading-writer's lifespan as the durable `reporting-offboard`. It does not
enumerate anything: it asks the database which relations carry the tenant and
deletes from each, so a projection added next month is covered the day it is added.

The kernel's metadata walk is not enough here and this store is the only one where
that is true. Measured, on a tenant with rows in every kind of relation: the
metadata walk removed 9 rows and left `access_events` (door-level movement, with
`cardholder_ref`), `iot_alerts`, and all four continuous aggregates, which retain
derived rows for up to 1825 days.

Aggregates are deleted through their materialization hypertable, whose name comes
from `timescaledb_information.continuous_aggregates`. `DELETE FROM access_events_1h`
fails outright — a real-time aggregate is a UNION view. The documented alternative,
refreshing the aggregate after clearing the source, is wrong here: source retention
(90 days for readings) is shorter than aggregate retention (400 and 1825 days), so
refreshing an old window recomputes those buckets from source data that has been
dropped and erases every OTHER tenant's history along with the one being offboarded.

## Things worth knowing

**Timescale is not expressible in SQLAlchemy metadata.** The hypertable
conversions, the continuous aggregates and the compression/retention policies live
in the Alembic revisions and in `reporting/policies.py`. The models define columns
and keys only.

**`PRIMARY KEY (point_id, ts)`, in that order.** Declared explicitly, because two
`primary_key=True` columns would order the key by definition order and give the
wrong index for "one point over a time range". Replays from the gateway's outbox
are normal, so the writer inserts `ON CONFLICT DO NOTHING` and lets the database
make a redelivery a no-op.

**`ts` is the reading's own timestamp**, not when it was published or written. A
replay can deliver a reading minutes late and the row must still say when it
happened.

**`reconcile_placement`'s `tenant` argument is not what keeps tenants apart.** The
isolation is in the join: `device_locations` is matched on `tenant_id` and
`device_id` together. The argument is optional because the writer calls it with the
points of one batch, and a batch is whatever the durable pulled off
`tenant.*.iot.reading.>` — several tenants at once, routinely.

**`device_locations` is device-level and that is the design.** A placement is a
fact about a box, not about each of the box's measurements, and a device's points
are in the same room. Point-level precision is still reachable through
`placement_source = 'point'`, which the reconcile never touches, but it is the
exception.

**Name copies go stale.** `site_name`, `floor_name`, `door_name` are copies taken
at write time, because this store may not read `neubit_control`. Group on the id;
the name is only ever displayed.

## Tests

```bash
./backend/reading-writer/run-tests.sh
```

136, offline: a throwaway container from the shipped image, tree mounted read-only,
no network. The suite lives with reading-writer because that is the process; it
covers this package's models, migrations and erase logic.

Two checks need a live database and are not in that suite: `alembic check`, and the
erase reaching the projection relations and aggregates.

## Known gaps

* `metric_definitions.tenant_id` is nullable and NULL means PLATFORM: the listing
  is `tenant_id IS NULL OR tenant_id = :tenant`, so such a row is visible to every
  tenant and a tenant erase correctly leaves it alone. That is the design, and the
  8 seeded definitions are what it is for. The limitation is the other direction —
  a super-admin cannot author a definition scoped to ONE tenant, because the
  registration takes the tenant from the caller's own token.
* `benchmark_site_config` is keyed on `site_id` alone, so it holds one config per
  site across all tenants. Sound while site ids are globally unique uuids minted by
  core, but it is not enforced here. Its `tenant_id` now comes from the SITE rather
  than from the actor, so a super-admin's write is still reachable by that tenant's
  erase.
* The erase finds a tenant column named `tenant_id`, plus whatever a projection
  spec declares. A future table using some other name and no spec would be missed.

## Configuration

`VE_DATABASE_URL`, plus the retention and compression knobs documented in
`reporting/policies.py` and set in `deploy/docker-compose.yml`:
`VE_READINGS_CHUNK_INTERVAL`, `VE_READINGS_COMPRESS_AFTER`,
`VE_READINGS_RETENTION`, `VE_READINGS_1M_*`, `VE_READINGS_1H_*`. Set any retention
var to `off` to disable that policy. After editing:
`docker compose up -d reporting-migrate` re-reconciles.
