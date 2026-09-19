// WHICH BUILDING IS THIS DEVICE IN — suggested from evidence, decided by a person.
//
// A device's building is an operator's assertion about a physical box, and
// `assign.ts` refuses the one tempting shortcut: no default building, not even
// when the estate has exactly one. That rule stands. What this file adds is the
// part a machine CAN do — read the evidence the store already holds and put it
// beside each row:
//
//   SAME NAME   a device with this exact name is already in a building. A
//               gateway rebuild gives a device a new id, so the same chiller
//               turns up here as "unplaced" while its older self is placed.
//   SAME GATEWAY  every placed device on this device's gateway is in ONE
//               building. A gateway is a box on a wall; it rarely serves two.
//
// Either one PRE-FILLS the row, with the reason printed beside it. Nothing is
// written until a person presses Save. When the evidence disagrees with itself
// — same name in two buildings, a gateway serving two — there is no pre-fill
// and the row says why. No evidence at all is also no pre-fill: one building
// in the estate is not evidence.
//
// A QUIET device is never pre-filled: it stopped reporting a day or more before
// the rest of the estate did, and is most often the old copy of something that
// is already placed. It is shown, with the date, for a person to decide.
import type { BiDeviceRow } from "@/lib/types";

export type Why = "same_name" | "same_gateway";

export interface Suggestion {
  siteId: string;
  siteName: string;
  why: Why;
}

export interface Row {
  device: BiDeviceRow;
  /** What the evidence says, if it says one thing. */
  suggestion: Suggestion | null;
  /** Stopped reporting well before the rest of the estate. */
  quietSince: string | null;
  /** The sentence in the WHY column. */
  reason: string;
  tone: "evidence" | "gateway" | "warn" | "none";
}

const DAY = 86_400_000;

const key = (tag: string | null | undefined) => (tag ?? "").trim().toLowerCase();
const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The building(s) a set of placed devices is in, by site id. */
function sitesOf(devices: BiDeviceRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of devices) if (d.site_id) out.set(d.site_id, d.site_name ?? "a building");
  return out;
}

/** Every unplaced device, with its evidence, ordered so the rows a person can
 *  accept come first and the ones that need thought come last. */
export function suggest(unplaced: BiDeviceRow[], placed: BiDeviceRow[]): Row[] {
  const byName = new Map<string, BiDeviceRow[]>();
  const byGateway = new Map<string, BiDeviceRow[]>();
  for (const p of placed) {
    const n = key(p.device_tag);
    if (n) byName.set(n, [...(byName.get(n) ?? []), p]);
    if (p.gateway_id) byGateway.set(p.gateway_id, [...(byGateway.get(p.gateway_id) ?? []), p]);
  }

  // "Quiet" is measured against the ESTATE's newest reading, not the wall
  // clock: between ingest runs every device looks old, and a rule on the wall
  // clock would call the whole estate quiet and pre-fill nothing.
  const newest = Math.max(
    ...[...unplaced, ...placed].map((d) => time(d.last_seen_at) ?? -Infinity),
  );

  const rows = unplaced.map((device): Row => {
    const seen = time(device.last_seen_at);
    const quiet = Number.isFinite(newest) && seen != null && newest - seen > DAY;
    const quietSince = quiet ? device.last_seen_at ?? null : null;

    const sameName = sitesOf(byName.get(key(device.device_tag)) ?? []);
    const sameGw = device.gateway_id ? byGateway.get(device.gateway_id) ?? [] : [];
    const gwSites = sitesOf(sameGw);

    let suggestion: Suggestion | null = null;
    let reason = "no evidence — choose a building";
    let tone: Row["tone"] = "none";

    if (sameName.size === 1) {
      const [siteId, siteName] = [...sameName][0];
      suggestion = { siteId, siteName, why: "same_name" };
      reason = "same name already there";
      tone = "evidence";
    } else if (sameName.size > 1) {
      reason = `a device with this name is in ${sameName.size} buildings`;
      tone = "warn";
    } else if (gwSites.size === 1) {
      const [siteId, siteName] = [...gwSites][0];
      suggestion = { siteId, siteName, why: "same_gateway" };
      reason = `same gateway as ${sameGw.length} ${sameGw.length === 1 ? "device" : "devices"} there`;
      tone = "gateway";
    } else if (gwSites.size > 1) {
      reason = `its gateway serves ${gwSites.size} buildings`;
      tone = "warn";
    }

    if (quiet) {
      // Stated, not pre-filled: most often the old copy of a placed device.
      return {
        device,
        suggestion: null,
        quietSince,
        reason: `quiet since ${fmtDay(quietSince)} — an old copy?`,
        tone: "warn",
      };
    }
    return { device, suggestion, quietSince: null, reason, tone };
  });

  const rank = (r: Row) =>
    r.suggestion?.why === "same_name" ? 0 : r.suggestion ? 1 : r.quietSince ? 3 : 2;
  return rows.sort(
    (a, b) => rank(a) - rank(b) || key(a.device.device_tag).localeCompare(key(b.device.device_tag)),
  );
}

export function fmtDay(iso: string | null | undefined): string {
  const t = time(iso);
  if (t == null) return "—";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The writes a set of choices makes: one assignment per building, only for
 *  devices whose choice differs from where they already are. */
export function changesOf(
  choices: Record<string, string>,
  current: Record<string, string | null>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [deviceId, siteId] of Object.entries(choices)) {
    if (!siteId || current[deviceId] === siteId) continue;
    out.set(siteId, [...(out.get(siteId) ?? []), deviceId]);
  }
  return out;
}
