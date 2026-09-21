"use client";

// Building Intelligence API module — the read side of the IoT reading store.
//
// Served by the READING-WRITER (`backend/reading-writer/app/api`), not by core and
// not by a new analytics service: the pipeline contract (§7) gives the readings
// schema one owner, and the owner serves its own reads. Routed at the gateway as
// `/api/v1/bi/*` → reading-writer:8000 (gateway/dynamic/routes.yml).
//
// Backend contract:
//   GET /bi/summary                    category rollup + totals + reading extent
//   GET /bi/activity  ?hours           hourly SAMPLE volume per category (readings_1h)
//   GET /bi/devices   ?category&device_type&search&site_id&placement&limit&offset
//   GET /bi/points    ?device_id|device_tag&category&type&search&with_latest
//   GET /bi/series    ?point_id(xN)&start&end&hours&resolution=auto|1m|1h|raw
//   GET /bi/correlation ?point_id(x2..12)&hours&resolution=auto|1m|1h
//   GET /bi/correlations ?hours&start&end            the cross-domain REGISTRY
//   GET /bi/rating/sites                            site facts + rating inputs
//   GET /bi/rating    ?site_id&point_id(xN)&days
//
// `/bi/devices` is also the floor-plan editor's IoT palette (see
// lib/api/deviceInventory.ts): a device is placeable because it has reported,
// which is the same reason it appears here.
//
// Which store answers which call — this is the part that matters and the reason
// the API exposes `resolution` at all:
//   • CHARTS read the ROLLUPS (`readings_1m` / `readings_1h`), never raw. That is
//     what makes query cost independent of ingest rate.
//   • CURRENT VALUES (`points.latest`) read RAW over a bounded lookback, because
//     `readings_1m` is materialized-only with a ~2 minute freshness floor and a
//     live tile must not be two minutes behind the building.
//   • `resolution=raw` exists for drill-down and the server refuses a window
//     wider than 3 hours rather than silently downgrading it.
//
// NOTE ON UNITS: `unit` comes back null for every point on this deployment, and
// that is CORRECT — the source MQTT payloads carry no unit (contract §11/§12).
// Never substitute a guess. A fabricated "kW" on an energy screen is worse than
// a blank one.
import { api } from "@/lib/api";

const BI = "/bi";

const unwrap = (p: Promise<any>): Promise<any> => p.then((r) => r.data);

// Drop null/undefined/"" so URLSearchParams doesn't emit empty filters. NOTE the
// deliberate exception: `category=""` is MEANINGFUL to this API (it selects the
// devices nothing has classified), so callers pass the sentinel below instead of
// relying on an empty string surviving this.
function qs(params: any = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries<any>(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** The "unclassified" category filter. The API reads an EMPTY `category` as
 *  "devices with no classification"; qs() would strip that, so callers pass this
 *  and it is re-expanded to `category=` on the wire. */
export const UNCLASSIFIED = "__unclassified__";

function categoryParam(category?: string | null) {
  if (category === UNCLASSIFIED) return "";
  return category ?? undefined;
}

export const bi = {
  summary: () => unwrap(api.get(`${BI}/summary`)),

  activity: (hours = 24) => unwrap(api.get(`${BI}/activity${qs({ hours })}`)),

  // The FAULT QUEUE — alerts the gateway raised, projected into the reporting
  // store by the reading-writer's projection consumers and read back here.
  // Bounded to 48 hours by the server because it reads RAW: the queue needs
  // each alert's own message, and the hourly rollup deliberately does not carry
  // it (the message is unique per alert, so grouping by it would make the rollup
  // a copy of the table).
  // A wider question is a chart, and the `iot_alerts` DATASET answers it.
  //
  // `available: false` means nothing is COLLECTING alerts, which is not the same
  // fact as "no alerts" and must not render the same way.
  alerts: ({ hours = 24, severity, limit }: any = {}) =>
    unwrap(api.get(`${BI}/alerts${qs({ hours, severity, limit })}`)),

  // Gate 6's own read: what this building's equipment is saying right now, each
  // finding carrying the incident body that would raise work about it. The UI
  // never composes that body — it posts what the store handed it.
  findings: ({ site_id, hours }: any) =>
    unwrap(api.get(`${BI}/sites/${site_id}/findings${qs({ hours })}`)),

  // `placement` is `placed | unplaced` and has NO default: omitted, the whole
  // estate comes back. `unplaced` is gate 3's worklist — devices no building owns.
  devices: ({ category, device_type, search, site_id, placement, limit, offset }: any = {}) => {
    const cat = categoryParam(category);
    const suffix = qs({ device_type, search, site_id, placement, limit, offset });
    // `category=` (empty) has to survive, so it is appended by hand.
    const sep = suffix ? "&" : "?";
    return unwrap(
      api.get(
        `${BI}/devices${suffix}${cat !== undefined ? `${sep}category=${encodeURIComponent(cat)}` : ""}`,
      ),
    );
  },

  points: ({ device_id, device_tag, category, type, search, site_id, with_latest, limit, offset }: any = {}) => {
    const cat = categoryParam(category);
    const suffix = qs({ device_id, device_tag, type, search, site_id, with_latest, limit, offset });
    const sep = suffix ? "&" : "?";
    return unwrap(
      api.get(
        `${BI}/points${suffix}${cat !== undefined ? `${sep}category=${encodeURIComponent(cat)}` : ""}`,
      ),
    );
  },

  // `point_id` repeats once per series. `resolution` defaults to "auto", which is
  // what every screen uses — the server picks 1m up to 3 hours and 1h beyond, and
  // says which it used in `resolution_reason` so the UI can print it rather than
  // implying a precision it does not have.
  series: ({ point_id, hours, start, end, resolution }: any) =>
    unwrap(api.get(`${BI}/series${qs({ point_id, hours, start, end, resolution })}`)),

  // CORRELATION. Two or more series, compared pairwise over the buckets they
  // BOTH filled, read from the same rollups every chart reads.
  //
  // Why this needs no unit: Pearson's r is a covariance over two standard
  // deviations, so units cancel — and the series are not anonymous, they carry
  // the source's own `device_tag` / `point_tag`. What the coefficient does not
  // license is an INTERPRETATION, and neither this client nor the server
  // supplies one: no ranking of causes, no "driver", no explanation.
  //
  // Every field the screen needs in order to be honest comes back with it:
  // `n` (buckets that actually overlapped), `resolution` (+ the reason, printed
  // verbatim), and a `status`/`reason` per pair for the cases where r does not
  // exist — a FROZEN series has zero variance and therefore an UNDEFINED r, not
  // a zero. There is no `raw` resolution here at all.
  //
  // Passing exactly two point ids also returns the aligned (t, a, b) samples the
  // coefficient was computed from, so the scatter and the number cannot disagree.
  correlation: ({ point_id, hours, start, end, resolution }: any) =>
    unwrap(api.get(`${BI}/correlation${qs({ point_id, hours, start, end, resolution })}`)),

  // ── CROSS-DOMAIN CORRELATIONS ─ the registry, not the coefficient ──────
  //
  // `correlation()` above computes r between two series a caller names. THIS one
  // answers the question a step earlier and the one a buyer is actually asking:
  // which cross-domain questions can this estate answer at all, and for the ones
  // it cannot, WHAT KIND of thing is missing.
  //
  // A BMS owns one domain, so it can only ask questions inside one. Every
  // correlation here declares the signals it needs — a role, a confirmed unit, a
  // module's events, a typed site fact — and the server resolves those
  // declarations against this estate over the SAME window the coefficient would
  // be computed over. A signal counts as present because it produced readings
  // inside that window, never because a row exists or a role was bound once.
  //
  // THE FIELD THIS ENDPOINT EXISTS FOR is `gap.needs_new_hardware`, and it is a
  // TRI-STATE: true costs money, false does not, and `null` is UNDETERMINED —
  // the fact that would settle it lives in a database the reading-writer is not
  // allowed to open. `totals` carries three buckets for exactly that reason, and
  // a client that folds `hardware_undetermined` into `no_new_hardware_needed`
  // has made a claim the backend deliberately refused to make. So the totals are
  // read, never re-derived here: the headline is a `totals` lookup and not
  // arithmetic over `correlations`.
  //
  // `blocking_gaps_*` is ONE gap per blocked correlation — what the headline
  // counts. `signal_gaps_*` is every unsatisfied signal, which is the real
  // backlog and a bigger number. They are two populations and must not be mixed.
  correlations: ({ hours, start, end }: any = {}) =>
    unwrap(api.get(`${BI}/correlations${qs({ hours, start, end })}`)),

  // ── STRANDED ROLES ─ what a gateway rename leaves behind ────────────────
  //
  // When a rebuild RENAMES a point's tag, the operator's role binding is
  // stranded on a point that stopped reporting — which is the state every
  // `point_roles` row on this deployment is in.
  //
  // `roleOrphans()` is the worklist: each stranded role with who asserted it, why
  // it is stranded (`orphan_reason`), how many points on its device were LOOKED
  // AT (`candidates_considered`), and the credible successors on the SAME device
  // ordered by score — each one carrying the EVIDENCE that produced the score, a
  // sentence per signal. The evidence is the output, not a debugging aid: a score
  // an operator cannot check is a score they must not act on.
  //
  // Orphaned is measured against the DEVICE'S OWN CLOCK, not the freshness
  // window: this estate is routinely outside that window between ingest runs, and
  // a worklist that empties and fills with ingest timing is not a worklist.
  // `fresh` still comes back per point so the screen can say the estate is
  // between runs; it decides nothing.
  // Device by device: which of a device's readings something computed needs a
  // meaning for, what the tag suggests, and what the reading says right now.
  // Only roles an EFFECTIVE metric definition reads are asked about — the estate
  // stores hundreds of readings nothing computes with. See role_asks.py.
  // One building's facts record: what is on file with its source and date, and
  // what is missing with the figure it holds up. Only facts an effective metric
  // definition reads, plus the benchmark inputs the standard in force reads.
  // Writes nothing — see building_facts.py for where each write lives.
  buildingFacts: (siteId: string) =>
    unwrap(api.get(`${BI}/sites/${encodeURIComponent(siteId)}/facts`)),

  /** Record the site's climate zone / AC share for the star bands. `null`
   *  CLEARS; a zone the standard does not publish is refused by name. */
  setBenchmarkConfig: (body: {
    site_id: string;
    standard_key?: string;
    climate_zone?: string | null;
    ac_category?: string | null;
    ac_share_percent?: number | null;
  }) => unwrap(api.put(`${BI}/rating/benchmark-config`, body)),

  roleAsks: ({ site_id, hours }: { site_id?: string; hours?: number } = {}) =>
    unwrap(api.get(`${BI}/points/roles/asks${qs({ site_id, hours })}`)),

  roleOrphans: ({ role, site_id }: any = {}) =>
    unwrap(api.get(`${BI}/points/roles/orphans${qs({ role, site_id })}`)),

  // The write, and it carries exactly the ids a human named. There is no mode, no
  // threshold and no "apply everything above a score" — a role is a statement
  // about what a number MEANS, and a plausible wrong binding computes silently
  // where a refusal would have been visible.
  //
  // One transaction PER MOVE, so a batch can half-apply: every move comes back in
  // `results` with `moved` or `refused` and the reason, and `moved` is a count of
  // writes rather than of requests. The caller renders each outcome — a summary
  // count would hide the four that were refused behind the six that were not.
  repointRoles: ({ moves }: any) =>
    unwrap(api.post(`${BI}/points/roles/repoint`, { moves })),
  // Put a move back. Posted with the move AS REPORTED — `from` is the point the
  // role came off, `to` the one it went to — and refused unless that is still
  // the succession on record. The assertion returns as it was made: whoever
  // presses undo is not the person who said what the number means.
  undoRepoints: ({ moves }: any) =>
    unwrap(api.post(`${BI}/points/roles/repoint/undo`, { moves })),

  // The other half of the worklist, and the only thing that can be done to a
  // stranded role whose POINT ROW IS GONE: a repoint needs a successor on the
  // same device and there is no device left to read, so without this the
  // assertion is unfixable AND undeletable from any screen.
  //
  // This DELETES a human's statement about what a number meant and no self-heal
  // puts it back, so it is narrower than every other write here: point ids a
  // person named, no mode, no sweep, no "forget every missing one". The server
  // enforces the same narrowness — the "point is missing" condition is in the
  // DELETE, so a point that came back between the read and the press is refused
  // rather than silently unbound.
  //
  // One transaction per id. Three refusals come back as 200-with-a-reason so one
  // stale id cannot discard the batch: the point exists again, no role is
  // recorded for that id in this tenant, and the race where the DELETE touched
  // nothing. Each FORGOTTEN result echoes the assertion back — after the delete
  // that response is the last place it exists, which is why the caller renders
  // every outcome rather than a count.
  forgetRoles: ({ point_ids }: any) =>
    unwrap(api.post(`${BI}/points/roles/forget`, { point_ids })),

  // ── INTAKE ──────────────────────────────────────────────────────────────
  //
  // What arrived in a window, what is still unconfirmed ranked so the useful
  // work is first, and — the distinction the units screen cannot make — which
  // rows are addresses that have NEVER carried a reading. Classification reads
  // `max(readings.ts)`, not `points.last_seen_at` — still, now that the writer
  // no longer advances `last_seen_at` on a message that stored nothing
  // (`e9818d2`). Two reasons it stays on the data: the rows the old writer
  // already inflated cannot heal, and they are exactly what this surface exists
  // to expose; and the screen whose job is catching drift should not be the one
  // place that trusts a denormalised copy. Read-only; nothing here confirms.
  intake: ({ days, state, pending, new_only, search, limit, offset }: any = {}) =>
    unwrap(
      api.get(`${BI}/intake${qs({ days, state, pending, new_only, search, limit, offset })}`),
    ),

  // ── RATINGS ────────────────────────────────────────────────────────────
  //
  // `ratingSites()` reads `site_facts` — this store's read-model of core's
  // `sites`, fed by the site-facts event mirror. A null area is NOT RECORDED and
  // the screen renders it as "cannot rate", pointing at Setup → Building facts
  // (where the area is typed), never as a default. Setup's building pickers
  // read this list too: it is BI's own copy of Configurations → Sites.
  //
  // `rating()` takes the METERS as an argument. There is no stored fact saying
  // which register measures a site's whole supply; picking one by tag would be
  // an invention and summing every confirmed kWh point would double-count an
  // incomer against its own sub-meters. So the operator names them, and the
  // response carries each meter's own subtraction so the total can be checked
  // by hand.
  ratingSites: () => unwrap(api.get(`${BI}/rating/sites`)),

  rating: ({ site_id, point_id, days }: any) =>
    unwrap(api.get(`${BI}/rating${qs({ site_id, point_id, days })}`)),

  // What each device placed in a building probably IS — class, slots with the
  // values they read, checks on those readings, what probably feeds it. A
  // proposal: nothing is saved by reading it. See suggest_equipment.py.
  equipmentSuggestions: (siteId: string) =>
    unwrap(api.get(`${BI}/sites/${encodeURIComponent(siteId)}/equipment/suggestions`)),

  // The plate facts still missing on a building's machines — and, for the ΔT
  // band, what its own readings show over the window, so the range is confirmed
  // rather than remembered. Writes nothing; the write is core's design PUT.
  equipmentNameplate: (siteId: string, { days }: { days?: number } = {}) =>
    unwrap(api.get(`${BI}/sites/${encodeURIComponent(siteId)}/equipment/nameplate${qs({ days })}`)),

  // ── THE PLANT ─ L3: one building's systems → equipment → slots ─────────
  //
  // Every slot with its DATA READINESS (reporting / silent / unbound /
  // unresolved / ambiguous) judged over the window, and every equipment-scope
  // metric's value or refusal. The schematic colours by readiness, never by a
  // metric. A 404 is a building this store has no record of at all.
  plant: (siteId: string, { hours }: { hours?: number } = {}) =>
    unwrap(api.get(`${BI}/sites/${encodeURIComponent(siteId)}/plant${qs({ hours })}`)),

  // ── PLACEMENT ─ read here, written by core ──────────────────────────────
  //
  // This store only READS where a device is: `devices({ placement })` above,
  // and every row's `site_id` / `site_name`. The WRITE is core's
  // `POST /device-placements/assign` (lib/api/sites.ts → devicePlacements.assign),
  // the same table the Sites floor plan writes, so there is still one fact and
  // one owner. Core emits the event; the reading-writer mirrors it into
  // `device_locations` and every point of the device inherits it.
};

export default bi;
