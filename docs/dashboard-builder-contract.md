# Dashboard builder — the contract

> **RETIRED, 2026-09-03 — but do not delete this document.**
>
> NeuBit's own dashboard builder is gone: the `dashboards` service,
> `frontend/src/features/dashboards/`, the `/dashboards` routes and the
> `dashboards.*` permission keys were all removed. DashForge is this platform's
> dashboarding surface now, reached at `/bi/dashboards`. **There is no NeuBit
> screen behind anything this document describes as a builder UI** — §§1–8, 10
> and 11 are history, kept because they record why the design was what it was.
>
> What is NOT history, and is still live code this file is the contract for:
>
> * the **dataset registry** and the **projection registry** (§2, §9) in
>   `neubit_reporting` — how a domain publishes queryable data;
> * the **server-side SQL generation and refusal rules** (§3, §4) in the
>   reading-writer's `/api/v1/bi/query`, which still owns the readings schema;
> * **spec versioning** (§6), which is why the export in
>   `docs/dashboard-builder-final-export-2026-09-03.json` contains two spec
>   grammars.
>
> `docs/iot-pipeline-contract.md` cites §9 of this file for the projection
> registry, which is the immediate reason deleting it would break something real.
>
> The one dashboard anybody had actually built, with its widgets and its version
> history, is preserved as data in
> `docs/dashboard-builder-final-export-2026-09-03.json`.

The builder is a NeuBit module. It must serve every domain on this platform —
IoT readings today, VMS, access control and fire next — not the IoT store it
happens to have been born against.

Source of truth for every agent working on it. Copy from here; do not re-derive.

Reference implementation: the standalone product at
`/Users/snowden/private/dashboard/project`. **READ it, never WRITE to it.** It is
being sold; copying components out is intended, modifying it is not. No
cross-repo imports, no shared package, no symlinks. Verify with `git status`
there before finishing.

---

## 1. Why the generalisation comes first

The v1 builder queries `neubit_reporting.readings` / `points` directly and its
vocabulary is IoT-shaped (`scope: points | device | category | all`). That cannot
chart a door-access event or a fire panel state, so porting twelve chart types
onto it would only make the wrong thing bigger.

Two facts force the design:

- This platform **bans cross-service reads.** VMS, access and fire each own a
  private database. The builder must not reach into any of them.
- The standalone product's builder is domain-agnostic *because* it works against
  tables and columns rather than a fixed vocabulary.

So: domains **publish** into the reporting store; the builder discovers what is
there and queries only that. `neubit_reporting` is the one place data is gathered
for querying, and it is the exception to the cross-service ban by design.

## 2. Dataset registry

A **dataset** is a queryable thing the builder can see: a name, a physical
relation in `neubit_reporting`, its dimensions, its measures, and the permission
required to read it.

Requirements:

- **Registration is data, not code.** A new domain must not require a builder
  release. IoT readings registers itself; VMS/access/fire register the same way
  when they publish.
- A dataset declares its **time column** — every dashboard is time-ranged.
- A dataset declares which columns are **dimensions** (group/filter) and which
  are **measures** (aggregate), with the aggregates each measure permits. A
  measure that must not be summed says so.
- **Rollup awareness stays.** A dataset may declare rollup relations (as IoT has
  `readings_1m` / `readings_1h`) and the executor picks by window — charts read a
  rollup, raw only inside a bounded window. Query cost must stay independent of
  ingest rate; sensors and event streams have wildly different rates.
- Permission per dataset, and a role must actually be able to grant it. **Note
  the bug not to repeat:** `ingest.read`/`ingest.manage` were gated by the
  backend but never added to core's catalog, so no role could grant them and
  only a wildcard admin could reach Ingest.

  **Correction (2026-08-30).** This section first said the permission goes "in
  core's catalog", which reads as a code edit — and that is wrong. If
  registration is data, a static catalog reintroduces exactly the release
  coupling this section removes: a new domain could register a dataset but
  nobody could be granted access to it until core shipped. The catalog therefore
  has a **dynamic half**: a service registers its permission alongside its
  dataset, and role validation accepts static and registered permissions alike,
  with static winning on a clash. An unregistered permission is still refused,
  so the guarantee that a role cannot grant something meaningless survives.

## 3. SQL is GENERATED on the server, never accepted from a client

The standalone product's builder is not a free-SQL editor — it is a pure
generator over picker state, with identifiers checked against
`^[A-Za-z_][A-Za-z0-9_]*$` and then quoted, string literals escaped, numerics
validated, only SELECT ever emitted, and a rejected identifier collapsing the
whole generation to `""` rather than interpolating. That design is sound and is
what makes it domain-agnostic. Port it.

Two changes, both deliberate:

1. **The generator runs on the server.** The client sends builder STATE. An
   endpoint that accepts SQL from a browser must not exist — this platform runs
   video surveillance and access control, and that is a different risk from a
   standalone BI tool.
2. **Widgets store builder STATE, not generated SQL.** The standalone product
   persists SQL in `Widget.query`; that freezes every generator bug into every
   saved dashboard. Storing state means a fix to the generator fixes widgets that
   were saved before it.

Queries execute as the existing read-only role. A builder that can write to a
store is a bug waiting to happen.

## 4. Honesty rules — keep these, they are already enforced

Carried from the v1 executor and not negotiable:

- **Never invent a unit.** `points.unit` is NULL for every IoT point because the
  source payloads carry none. A fabricated `kW` on an axis is worse than a blank.
  Generalised, this is a dataset capability: a dataset may name a unit *column*,
  and must never assert a unit that is not in the data.
- **A value metric cannot be grouped across incomparable series.** Averaging a
  power factor with a voltage is meaningless; the v1 executor refuses it and says
  what to do instead. Generalise the rule, do not drop it.
- **No silent downgrades.** Asking for raw over a window wider than the limit is
  an error naming the rollup to use, not a quiet substitution.
- **Every result carries its resolution and the reason.** A chart must never
  imply precision it does not have.
- **Absence renders as absence.** A point with no sample is null, never zero.
- **Never fabricate a screen.** The launcher's own rule: a surface with no data
  behind it stays SOON.

## 5. Scope

**In:** dataset registry; server-side generated SQL from builder state; the full
chart set (the reference has bar, bar3d, candle, gauge, heatmap, kpi, line, map,
pie, scatter3d, table); dashboard filters and variables; drill-down; number
formatting; widget palette; calculated fields; version history and diff; refresh
and cache control.

**Out — the platform already has these, or the user excluded them:** user
authentication, RBAC, the permissions dialog, configuration screens, share and
embed tokens, writeback, and any second WebSocket client.

**Ask before building:** the AI query assistant and the insights dialog.

## 6. Migration

v1 widgets exist and are saved against the IoT-shaped spec. They must keep
working or be migrated — a saved dashboard going blank is not an acceptable cost.
`spec_version` already refuses a future version loudly and `_migrate` is the one
place a past one is brought forward; use it.

## 7. Rules for whoever works on this

1. Copy values and names from this file. Do not re-derive them from the other repo.
2. Do not write to the standalone product's repo. Ever.
3. Verify against the running stack, not against source.
4. The frontend dev container is fragile — `/app/node_modules` is an anonymous
   volume Docker seeds from the HOST directory, so it can end up with macOS
   binaries or a corrupt Turbopack cache. Adding a dependency will make you hit
   this. Recovery: `docker compose up -d --force-recreate --renew-anon-volumes
   frontend` — **`--renew-anon-volumes` is required**; plain `--force-recreate`
   keeps the anonymous volume and therefore keeps the corrupt Turbopack cache,
   which is how this reads as "the recovery does not work". If lightningcss then
   fails to load,
   `docker exec neubit-v3-frontend-1 npm install --no-save lightningcss-linux-arm64-musl@1.32.0`.
   Do not conclude your code broke the app.

## 8. Cache control, and why the builder does not offer one (2026-08-30)

§5 lists "refresh and cache control" as in scope. The REFRESH half is built: a
widget picks its own polling interval. The CACHE half is deliberately not, and
this is a §4 consequence rather than an omission.

The reference's control sets a server-side TTL on a cached query result. Here
every result carries `resolution` and `resolution_reason` — which store answered
and what that means for freshness — and a widget prints that line. A TTL layered
on top lets a tile print "1-minute rollup, real-time" over a number that is five
minutes old, which is precisely the quiet precision claim §4 exists to prevent.

If result caching is wanted, it belongs in the executor, where it can amend the
reason line to say the result was served from a cache and how old that cache is.
It does not belong in a per-widget option that changes the number's age without
changing what the widget says about it.

## 9. How data gets IN: the reporting projector (2026-08-30)

§2 made "what can be charted" data. It did not say how anything gets into
`neubit_reporting` in the first place, and for a while nothing did — the
`access_events` dataset that proved the registry was domain-agnostic was a
FIXTURE: 2,800 rows generated by hand into a table no service wrote. It proved
the point and then went stale, which is how a proof becomes a lie in somebody's
dashboard. It has been dropped.

The one legal way in follows directly from §1. A domain owns its database and
nothing may read it, so a domain **publishes** and something consumes the bus and
writes the reporting store. That something is
`backend/reading-writer/app/projections` — and what a domain must declare in
order to be projected is data, exactly like a dataset.

It was its own container, `reporting-projector`, until 2026-09-05. The OWNER did
not change and neither did anything in this section: the projection consumers are
still the only writer of these relations, still open one database, still serve no
tenant API. Only the process boundary went. See pipeline contract §22.

### 9.1 The shape

```
access service ──publish──► NATS EVENTS ──durable pull consumer──► projections
                            tenant.<t>.access.<cat>.<type>            │
                                                                      ▼
                             neubit_reporting.access_events (hypertable)
                                     + access_events_1h (continuous aggregate)
                                     + a dashboard_datasets row
                                                                      │
                       reading-writer /api/v1/bi/query ◄──────────────┘
```

One row of `neubit_reporting.reporting_projections` holds the whole recipe: the
subject, the target relation and its columns, the rollups, and the
`dashboard_datasets` row to publish. The projector re-reads that table every
`VE_PROJECTOR_RELOAD_SEC`, creates what the spec declares, and starts consuming.

### 9.2 What is not negotiable, and why

* **The projection consumers open ONE database.** `neubit_reporting`, never
  `neubit_access` or `neubit_vision`. That ban is why the reporting store exists.
  They also open their own POOL onto it, which is a different rule and is about
  not starving the readings writer — pipeline contract §22.
* **Ack only after a durable write.** A batch is one transaction; nothing is
  acked until it commits, and a failed batch is NAK'd whole. Verified by stopping
  Postgres mid-flight: six write failures, two NAK'd batches, twelve messages
  held unacked, zero rows lost, and the backlog drained on restart.
* **Batched and idempotent.** One INSERT per batch, never per event, with
  `ON CONFLICT DO NOTHING` on a declared natural key. Replay on a durable
  consumer is normal: deleting the durable and replaying the stream re-delivered
  36 messages and inserted 0 rows.
* **The natural key is the SOURCE's own event id**, plus the event time. Not the
  envelope's `event_id` — `kernel.events.envelope` mints that fresh on every
  publish, so using it would make a redelivery look like a new event.
* **Backpressure is visible and per projection.** A single aggregate number would
  let a healthy access projection hide a fire projection failing every batch.
  `/readyz` goes red for a refused projection too: a domain that believes it is
  being collected and is not is the worst failure available here. (That readiness
  endpoint was the projector's own until 2026-09-05; it is the reading-writer's
  now, and the union reds when EITHER half is wedged.)
* **DDL is additive only.** The projector creates tables, columns, indexes,
  hypertables and continuous aggregates; it never drops one, never drops a
  column, and never rewrites a column's type. A spec that would need any of those
  is refused by name.
* **§4 applies to every dataset.** The fixture had `credential_type` and
  `dwell_sec` columns and a "Dwell time (s)" measure. Nothing on the access wire
  carries either, so the real table has neither. A door with no event in a bucket
  is absent, not zero.

### 9.3 The recipe for the next domain (vision, fire)

Nothing below is a code change. In order:

1. **Publish, if the domain does not already.** Use `kernel.events`' `subject()`
   and `EventBus.publish` so the body is the standard envelope
   `{event_id, tenant_id, type, occurred_at, source, payload}`.
2. **Check the domain is in `kernel.events.EVENTS_SUBJECTS`.** `vms` and `fire`
   are. A domain that is not publishes onto a subject no stream captures: the SSE
   relays still see it, but no durable consumer can be created on it and the
   projector will refuse the projection by name.
3. **Put the LABELS on the wire.** The projector may not join the publisher's
   dimension tables, so a chart legend reading `a7f3…` instead of `Lobby North`
   is the publisher's problem to fix. The access service resolves its own
   `access_doors` row and publishes `door_id` + `door_name`; see
   `_DoorCache` in `backend/access/app/access/ingestion.py` for the pattern,
   including why a miss is cached and published as NULL rather than as
   "Unknown door".
4. **INSERT one row into `reporting_projections`.** Copy the access spec in
   `backend/reporting/migrations/versions/0005_projection_registry.py` and change
   the names. Watch three things:
   * the subject must match ONLY projectable events — `tenant.*.access.*.*`, not
     `tenant.*.access.>`, because the one-token `access.startup` lifecycle ping
     has no event time and would tick a data-loss counter on every restart;
   * the natural key must include the time column (a hypertable's unique index
     has to contain its partitioning column);
   * **every `base` dimension the dataset registers must be a GROUP BY column of
     every rollup.** The registry has one dimension list for all of a dataset's
     relations, so a dimension the rollup does not carry makes a chart that works
     over six hours and 500s over six days. The spec validator enforces this and
     refuses the projection rather than letting it be discovered by a user.
5. **Nothing else.** Within `VE_PROJECTOR_RELOAD_SEC` the projector creates the
   relations, starts consuming, and registers the dataset; the reading-writer's
   `permsync` pushes its permission into core's catalog on the next
   `/bi/datasets` read, and a role can grant it.

### 9.4 Ownership

| | owns |
|---|---|
| a domain service | its own database, and publishing its events with the labels on them |
| reporting-migrate | the IoT schema, `dashboard_datasets`, `reporting_projections` |
| reading-writer `app/projections` | every relation declared in `reporting_projections`. The only thing that writes them. |
| reading-writer `app/` | the readings schema, and the ONE read path (`/api/v1/bi/...`) over the whole store |

A migration cannot own the projected relations: a projection is inserted at any
time with no deploy, so a migration cannot know which relations exist. If it had
to, "registration is data" would hold only for the last mile.

### 9.5 Correction to §2 — `choose_relation` and bounded stores

`registry.Definition.choose_relation`'s docstring says `resolution=auto` "never
picks a relation with a window ceiling". The code does no such thing: it returns
a bounded relation whenever an `auto` rule names it and the window fits under its
ceiling. The IoT dataset simply has no `auto` rule naming `raw`; the access
dataset does (`{max_hours: 6, relation: "raw"}`) and correctly answers a
six-hour question from the raw table. The behaviour is right and useful — the
docstring is what is wrong.

## 10. Period-over-period comparison (2026-08-31)

The API could name ONE window and that was all, so the most basic analytical
question there is — "is this week worse than last week" — was not expressible.
Every "vs baseline" figure on a building dashboard is that question, so a screen
that wanted one had to fake it or leave it out.

`query.compare` is an OFFSET, not a second window:

```json
"compare": { "period": "previous" | "day" | "week" }
```

* `previous` shifts back by the widget's OWN window length, so it follows
  whatever range the page is showing.
* The two periods are the same length **by construction**. A client that could
  name both ends of a comparison period could compare six hours with six days and
  present the ratio as a change, with nothing in the result to say it had.
* **Calendar offsets are deliberately absent.** February against January compares
  28 days with 31 and most of the delta is calendar. Doing them properly needs
  bucket-aware calendar arithmetic and a rule for the ragged end; that is a
  separate piece of work, not a `relativedelta` dropped into the shift.

### Alignment is the SERVER's job

Both periods run through the same `_run_once` — same generator, same widening,
same NULL semantics — and a split chart's comparison pass is pinned to the
**primary window's series keys**. Discovering the earlier window's own top-N
would silently answer a different question: the columns would not line up, and
the ones that did would be the wrong pairs.

Rows are then paired on the server (`execute._row_key`):

* a **time bucket** keys on its ordinal position in its own window,
  `round((t − window_start) / grain)`, so "the third hour of the period" lines up
  across the two windows even when the offset is not a whole number of buckets.
  Over a raw relation there is no grain, so the key is the timestamp itself;
* a **group** keys on its dimension cells, so a group only one period has simply
  does not match — which is the point;
* an **ungrouped single row** keys on the empty tuple.

The client is never handed two loose tables to zip together. A group present in
one period and not the other is precisely where a position-by-position pairing
starts subtracting two different things and calling the difference a change.

### §4, applied to a delta

| situation | what is returned | why not the obvious thing |
|---|---|---|
| group has no row in the earlier period | row of NULLs, `delta_pct` NULL | it did not fall by 100%; there is nothing to compare with |
| earlier value is exactly 0 | `delta_pct` NULL | the change is undefined; "+100%" and "+∞%" are both inventions |
| earlier window returned nothing at all | `comparison.no_data = true` | a flat comparison line at zero reads as a measurement |
| group existed then, not now | counted in `only_previous`, not drawn | the widget asked about THIS period, but "four devices stopped reporting" is not "nothing changed" |
| comparison asked for with no measure selected | 400 naming the fix | a comparison of labels has nothing to be a change in |

`DeltaBadge` renders **nothing at all** for a NULL delta rather than an em dash:
a dash still occupies the slot a number would and reads as "we measured, and it
was nothing". The badge's colour is deliberately not semantic — up is not good
and down is not bad (a rise in samples is neither, a rise in faults is bad), and
nothing on this wire says which way round any measure runs.

## 11. Derived measures — a value that is a function of TWO series (2026-08-31)

Every measure the registry could express was a function of ONE column of one
series. That is the whole of what a meter reports and almost none of what a
building engineer asks. The worked case is chiller ΔT — leaving water temperature
minus entering water temperature, `OWT − IWT` — which is the headline diagnosis on
this product's own mockup and was not expressible even though both points have
been reporting since the store existed.

Two additions to the physical-aggregate vocabulary carry it, and both are closed
forms rather than SQL fragments:

* **`where: {dimension, equals}`** on any physical aggregate → `FILTER (WHERE …)`.
  The dimension is a registry KEY resolved through `Definition.dimension()`; the
  value is BOUND. A composite passes its filter down to any child that has none,
  so a two-sided definition states it once.
* **`difference: {left, right}`** → `(left) − (right)` over the same rows.

That is the whole mechanism, and it is deliberately in the REGISTRY rather than
in the executor. A `if device_type == 'chiller'` branch in `sqlgen.py` would make
ΔT work and make the next derived value — a pressure drop, a cooling-tower
approach, a power factor from kW and kVA — another branch in the one file that
has to stay domain-agnostic. **The mechanism generalises; the row is specific.**
The next derived value is an INSERT.

Three rules the first row had to meet, and they apply to every one after it:

1. **Nothing is written back.** A derived value is computed at query time. Stored,
   it becomes a second copy of a number that can be wrong in a second way, and it
   ages silently the moment the formula is corrected.
2. **Only LINEAR aggregates may be differenced.** `avg(A) − avg(B)` is the mean
   difference because the mean is linear. `min(A) − min(B)` is NOT the minimum
   difference: the two minima can fall in different samples. The registry model
   cannot check this — it does not know what a measure means — so `delta_t` offers
   `avg` and `last` and deliberately not `min`, `max` or `sum`, and the reviewer of
   the row is the check. A definition that offers `min` of a difference is lying.
3. **Absence propagates, and here it MATTERS.** Neither side is coalesced, so a
   bucket where only one point reported yields NULL. On this metric that is not a
   nicety: a ΔT near zero IS the fault being looked for, so a fabricated zero would
   read as a critical diagnosis.

Comparability is inherited from the reading value and for the same reason: no unit
is on the wire, so nothing says the two tags are degrees of anything, and a mean
ΔT across four chillers could be combining quantities that are not the same. The
measure is declared incomparable within `device_id` / `device_tag`, and the
executor refuses to aggregate it unpinned with a message naming what to do.

**No threshold, anywhere.** The mockup states "1.8°C vs 5–7°C design"; the design
figure is a property of the machine and it is in nobody's database here. A
threshold invented to make a row turn red is a diagnosis this platform has not
earned, so the console prints ΔT and a person reads it.

*Verified on live data:* `1F York Chiller01` reports `OWT 9.3` / `IWT 7.0`, and
`/bi/query` returns ΔT `2.30` for it from `readings_1h`; the unpinned form is
refused by name. **A real finding that was left alone:** both Khem chillers return
a NEGATIVE ΔT (−3.85 and −12.10), i.e. the water they return is colder than the
water they take in. Either those two devices have their tags the other way round
on the gateway or they are not running as chillers. Nothing here corrects the
sign — an `abs()` would hide a genuine configuration fault behind a plausible number.
