# Dashboard builder — the contract

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
