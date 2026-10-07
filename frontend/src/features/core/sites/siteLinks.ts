// Where each number on the estate map leads (SCRUM-311).
//
// Every count an operator can see on a map is a question they will ask next —
// "which cameras?", "which ones are down?", "what alarms?" — and every VMS that
// draws one (Genetec, Milestone, Avigilon) answers it with a click: the count
// opens the list it was counted from, already filtered. These are those lists.
//
// The filters travel in the URL so a link is a link: it opens in a new tab,
// survives a reload, and can be pasted into a handover note.
import type { DevicePlacementIndexRow } from "@/lib/types";

/** The cameras placed at a site; `notOnline` narrows to the ones the map counted
 *  as offline (anything but online — see estateRollup.isOffline). */
export function siteCamerasHref(siteId: string, notOnline = false): string {
  const q = new URLSearchParams({ site: siteId });
  if (notOnline) q.set("status", NOT_ONLINE);
  return `/devices/cameras?${q.toString()}`;
}

/** The unacknowledged events on a site's cameras — what the Alarms count is. */
export function siteAlarmsHref(siteId: string): string {
  return `/events?${new URLSearchParams({ site: siteId, ack: "false" }).toString()}`;
}

/** The site's own page, where its location is set (Edit → Pick on map). */
export function siteSettingsHref(siteId: string): string {
  return `/sites?${new URLSearchParams({ site: siteId }).toString()}`;
}

/** The camera-list status that means "not online" — the map's offline count. */
export const NOT_ONLINE = "not_online";

/**
 * Every id a placed device may be known by.
 *
 * The floor plan pins a federated camera under the composite the wall uses,
 * `fed:<node>:<camera>`; an event carries the NODE-SIDE id the recorder
 * reported. Matching on one form only is how a site's alarms never reached its
 * pin, so both are returned.
 */
export function placementKeys(deviceId: string): string[] {
  const m = /^fed:[^:]+:(.+)$/.exec(deviceId);
  return m ? [deviceId, m[1]] : [deviceId];
}

/** Both ids of every CAMERA placed at a site. */
export function siteCameraKeys(rows: readonly DevicePlacementIndexRow[], siteId: string): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.site_id !== siteId || (r.device_type || "").toLowerCase() !== "camera") continue;
    for (const k of placementKeys(r.device_id)) keys.add(k);
  }
  return keys;
}

/** Drop drill-down filters from the address bar once the operator clears them,
 *  so a reload shows what is on screen. */
export function dropUrlParams(...names: string[]): void {
  const url = new URL(globalThis.location.href);
  for (const n of names) url.searchParams.delete(n);
  globalThis.history.replaceState(null, "", url.toString());
}

/** The site's name as the placement index carries it, for a filter chip. */
export function siteNameFrom(rows: readonly DevicePlacementIndexRow[], siteId: string): string | null {
  return rows.find((r) => r.site_id === siteId && r.site_name)?.site_name ?? null;
}
