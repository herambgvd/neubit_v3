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
//   GET /bi/devices   ?category&device_type&search&limit&offset
//   GET /bi/points    ?device_id|device_tag&category&type&search&with_latest
//   GET /bi/series    ?point_id(xN)&start&end&hours&resolution=auto|1m|1h|raw
//   GET /bi/correlation ?point_id(x2..12)&hours&resolution=auto|1m|1h
//   GET /bi/units     ?category&search&confirmed=all|confirmed|unconfirmed
//   POST /bi/units/confirm  {point_ids, unit}      (bi.manage)
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

  devices: ({ category, device_type, search, site_id, limit, offset }: any = {}) => {
    const cat = categoryParam(category);
    const suffix = qs({ device_type, search, site_id, limit, offset });
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

  // ── UNITS ─ the one thing that turns a number into a quantity ──────────
  //
  // `points.unit` is null for every point because the wire carries none
  // (contract §11/§12). That costs a trend chart nothing and it is fatal for a
  // RATING: kWh/m²/yr is a statement about units.
  //
  // `units()` returns each point with its unit, WHO said so (`unit_source`:
  // null = nobody, "reading" = the wire, "operator" = a human), and a
  // `suggestion` derived from the point TAG — computed at read time and NEVER
  // stored. That distinction is the whole feature: `KWH_kwh` looks like it
  // carries its unit, offering that reading for confirmation is honest, and
  // writing it silently is the naming-convention fabrication the contract
  // forbids (`4F-3F AC DB` names two floors).
  //
  // `confirmUnits()` writes an OPERATOR's assertion over an explicit list of
  // point ids — the ones the screen showed before the button was pressed. There
  // is no server-side pattern expansion, deliberately. `unit: null` clears back
  // to unconfirmed, which must stay reachable: a mis-typed unit nobody can take
  // back would corrupt every rating computed from it. Needs `bi.manage`.
  units: ({ category, search, confirmed, limit, offset }: any = {}) =>
    unwrap(api.get(`${BI}/units${qs({ category, search, confirmed, limit, offset })}`)),

  confirmUnits: ({ point_ids, unit }: any) =>
    unwrap(api.post(`${BI}/units/confirm`, { point_ids, unit })),

  // ── RATINGS ────────────────────────────────────────────────────────────
  //
  // `ratingSites()` reads `site_facts` — this store's read-model of core's
  // `sites`, fed by the site-facts event mirror. A null area is NOT RECORDED and
  // the screen renders it as "cannot rate", with a link to Configurations →
  // Sites, never as a default.
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

  // ── PLACEMENT ─ NOT HERE ────────────────────────────────────────────────
  //
  // This client used to carry a `placement` block: a worklist read and four
  // writes into `device_locations`. It is gone with the screen that used it.
  //
  // A device is placed in ONE place — Configurations → Sites → floor plan, which
  // has pinned cameras and doors at `{x, y, rotation}` since it was ported and
  // now offers IoT devices in the same palette. Core writes
  // `neubit_control.device_placements` and emits a domain event; the
  // reading-writer mirrors the site / floor / zone into
  // `neubit_reporting.device_locations`, and every point of that device inherits
  // it. Two screens for one fact is two answers waiting to disagree.
  //
  // `summary()` above still reports placed / unplaced counts. Those read `points`
  // and stay true no matter which surface made the placement.
};

export default bi;
