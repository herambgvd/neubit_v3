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
  // store by the reporting-projector and read back here. Bounded to 48 hours by
  // the server because it reads RAW: the queue needs each alert's own message,
  // and the hourly rollup deliberately does not carry it (the message is unique
  // per alert, so grouping by it would make the rollup a copy of the table).
  // A wider question is a chart, and the `iot_alerts` DATASET answers it.
  //
  // `available: false` means nothing is COLLECTING alerts, which is not the same
  // fact as "no alerts" and must not render the same way.
  alerts: ({ hours = 24, severity, limit }: any = {}) =>
    unwrap(api.get(`${BI}/alerts${qs({ hours, severity, limit })}`)),

  devices: ({ category, device_type, search, limit, offset }: any = {}) => {
    const cat = categoryParam(category);
    const suffix = qs({ device_type, search, limit, offset });
    // `category=` (empty) has to survive, so it is appended by hand.
    const sep = suffix ? "&" : "?";
    return unwrap(
      api.get(
        `${BI}/devices${suffix}${cat !== undefined ? `${sep}category=${encodeURIComponent(cat)}` : ""}`,
      ),
    );
  },

  points: ({ device_id, device_tag, category, type, search, with_latest, limit, offset }: any = {}) => {
    const cat = categoryParam(category);
    const suffix = qs({ device_id, device_tag, type, search, with_latest, limit, offset });
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

  // ── PLACEMENT ─ where a device is, and the write that says so ──────────────
  //
  // The truth is one row per DEVICE (`device_locations`), not per point: a
  // placement is a fact about a box, and this estate is 29 devices to 314
  // points. `points.site_id / floor_id / zone_id` are a derivation of it, so a
  // point that reports for the first time inherits its device's placement.
  //
  // THREE THINGS THIS CLIENT MUST NOT DO, all of them contract §4:
  //   • It never sends a site/floor/zone NAME. The server resolves every id
  //     against core and copies the label from core's answer; a name from a
  //     browser is a label nothing checked.
  //   • It never derives a floor from `tag_prefix`. That field groups the LIST
  //     so an operator can select twelve devices at once; the floor is still
  //     theirs to pick. `4F-3F AC DB` names two floors, so a convention is not
  //     data.
  //   • It never hides an unplaced device. Unplaced is the state this screen
  //     exists to change, not one to filter away.
  placement: {
    devices: ({ placed, search, limit, offset }: any = {}) =>
      unwrap(api.get(`${BI}/placement/devices${qs({ placed, search, limit, offset })}`)),

    // Bulk by construction: every device in one call goes to the SAME place.
    place: ({ device_ids, site_id, floor_id, zone_id }: any) =>
      unwrap(api.post(`${BI}/placement/devices`, { device_ids, site_id, floor_id, zone_id })),

    // A separate call rather than a nullable site_id, so an omitted field can
    // never be destructive. The points go back to UNPLACED, not to a default.
    unplace: ({ device_ids }: any) =>
      unwrap(api.post(`${BI}/placement/devices/unplace`, { device_ids })),

    // The point-level OVERRIDE — the sub-meter that is genuinely not where its
    // panel is. The exception, not the unit of work.
    placePoints: ({ point_ids, site_id, floor_id, zone_id }: any) =>
      unwrap(api.post(`${BI}/placement/points`, { point_ids, site_id, floor_id, zone_id })),

    resetPoints: ({ point_ids }: any) =>
      unwrap(api.post(`${BI}/placement/points/reset`, { point_ids })),
  },
};

export default bi;
