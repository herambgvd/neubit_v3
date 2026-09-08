// What each site is worth on the estate map, rolled up from three feeds.
//
// The map pinned a site's threat level and nothing else — a colour an operator
// set by hand, which says nothing about whether the site is actually in trouble
// right now. These are the facts that make a pin worth clicking: how many
// devices are placed there, how many of its cameras are offline, and how many
// unacknowledged alarms it is carrying.
//
// Nothing is derived from geography. The join is:
//   placement index (core)  device_id → site_id
//   estate cameras (vision) device_id → status
//   events (vision)         camera_id → unacknowledged alarm
// so a device that was never placed on a floor plan belongs to no site, and is
// counted nowhere rather than being attributed to the nearest one.
import type { DevicePlacementIndexRow } from "@/lib/types";

/** The camera fields this rollup reads — a narrow slice of `EstateCamera`. */
export interface RollupCamera {
  id: string;
  status?: string;
}

/** The event fields this rollup reads — a narrow slice of the VMS event feed. */
export interface RollupEvent {
  camera_id?: string | null;
  acknowledged?: boolean | null;
  severity?: string | null;
}

export interface SiteOps {
  /** Placements of any kind at this site. */
  devices: number;
  /** Of those, cameras. */
  cameras: number;
  /** Cameras whose live status is not online. */
  offline: number;
  /** Unacknowledged events on this site's cameras. */
  alarms: number;
}

export const EMPTY_OPS: SiteOps = { devices: 0, cameras: 0, offline: 0, alarms: 0 };

/**
 * A camera counts as offline when its status is anything but online.
 *
 * The two sources word it differently — a local camera row says "online" /
 * "offline" / "error", a federated recorder passes its own vocabulary through —
 * so this asks the one question both can answer, and an UNKNOWN status is not
 * counted as offline: a camera the estate list has not described yet would
 * otherwise light the whole map red on first paint.
 */
export function isOffline(camera: RollupCamera): boolean {
  const s = (camera.status || "").toLowerCase();
  if (!s) return false;
  return s !== "online" && s !== "ok" && s !== "streaming";
}

export interface RollupInput {
  placements: DevicePlacementIndexRow[];
  cameras: RollupCamera[];
  events: RollupEvent[];
}

/** site_id → the numbers its pin shows. Sites with nothing placed are absent. */
export function rollupBySite({ placements, cameras, events }: RollupInput): Map<string, SiteOps> {
  const statusById = new Map(cameras.map((c) => [c.id, c]));
  const siteOf = new Map<string, string>();
  const out = new Map<string, SiteOps>();

  const bucket = (siteId: string): SiteOps => {
    let b = out.get(siteId);
    if (!b) {
      b = { ...EMPTY_OPS };
      out.set(siteId, b);
    }
    return b;
  };

  for (const p of placements) {
    if (!p.site_id) continue;
    siteOf.set(p.device_id, p.site_id);
    const b = bucket(p.site_id);
    b.devices += 1;
    if ((p.device_type || "").toLowerCase() !== "camera") continue;
    b.cameras += 1;
    const cam = statusById.get(p.device_id);
    if (cam && isOffline(cam)) b.offline += 1;
  }

  for (const e of events) {
    if (e.acknowledged) continue;
    const siteId = e.camera_id ? siteOf.get(e.camera_id) : undefined;
    // An event from a camera nobody placed belongs to no site. Attributing it to
    // one would put a red badge on a building that has nothing to do with it.
    if (!siteId) continue;
    bucket(siteId).alarms += 1;
  }

  return out;
}

/**
 * How a pin should read: alarms beat offline cameras, which beat the threat
 * level an operator set by hand.
 *
 * Returned as a rank so the clustering layer can aggregate it with `max` — a
 * cluster is as urgent as its worst member.
 */
export type OpsSeverity = "alarm" | "offline" | "normal";

export function opsSeverity(ops: SiteOps | undefined): OpsSeverity {
  if (!ops) return "normal";
  if (ops.alarms > 0) return "alarm";
  if (ops.offline > 0) return "offline";
  return "normal";
}

export const SEVERITY_RANK: Record<OpsSeverity, number> = { normal: 0, offline: 1, alarm: 2 };
