// The arithmetic behind the IoT fleet screen, kept out of the component so it
// can be tested without a DOM.
//
// One idea runs through all of it: **a point count is three different numbers**,
// and collapsing them loses two faults. What the gateway has configured, what
// ever reached this platform, and what is reporting right now are three
// statements about three different failures, so nothing here ever adds them up.

import type { IotAlert, IotConnection, IotGateway, IotPoint } from "./types";

/**
 * How long a point may be silent before it counts as quiet.
 *
 * Matches the engine's own default freshness window, which is what the
 * Overview's "points reporting" figure uses. A second, different threshold here
 * would make two screens disagree about the same estate.
 */
export const QUIET_AFTER_SEC = 900;

export interface GatewayTotals {
  /** Points the gateway has configured, summed over its connections. */
  configured: number;
  /** Points that have ever delivered a reading to this platform. */
  arrived: number;
  /** Of those, the ones that reported inside the freshness window. */
  reporting: number;
  /** arrived − reporting. */
  quiet: number;
  devices: number;
  connections: number;
  /** True when the gateway cannot report its connections at all. */
  inventoryUnknown: boolean;
}

/** Seconds since an ISO timestamp, or null when there is none. */
export function ageSec(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

/** A point that has not reported inside the freshness window. */
export function isQuiet(p: IotPoint, now?: number): boolean {
  const age = ageSec(p.last_seen_at, now);
  // A point that has never reported at all is quiet, not unknown: it is in this
  // table because a reading created its dimension row, so a missing timestamp
  // is a gap rather than a point nobody has heard of.
  return age === null || age > QUIET_AFTER_SEC;
}

/**
 * The three point counts for one gateway.
 *
 * `reporting` needs the points list, which is a second request — until it
 * arrives this returns `reporting: 0, quiet: 0` rather than guessing. The
 * caller decides whether to render a dash or a number, and neither is invented
 * here.
 */
export function gatewayTotals(
  gw: IotGateway,
  points: IotPoint[] | undefined,
  now?: number,
): GatewayTotals {
  const conns = gw.connections;
  const configured = (conns || []).reduce((s, c) => s + (c.points || 0), 0);
  const arrived = (conns || []).reduce((s, c) => s + (c.arrived?.points || 0), 0);
  const devices = (conns || []).reduce((s, c) => s + (c.arrived?.devices || 0), 0);
  const quiet = points ? points.filter((p) => isQuiet(p, now)).length : 0;
  return {
    configured,
    arrived,
    reporting: points ? points.length - quiet : 0,
    quiet,
    devices,
    connections: (conns || []).length,
    inventoryUnknown: conns === null,
  };
}

export interface DeviceRow {
  tag: string;
  category: string | null;
  type: string | null;
  points: number;
  quiet: number;
  /** Age of this device's freshest point, in seconds. */
  newestSec: number | null;
}

/**
 * Points folded into the devices that own them, busiest first.
 *
 * A device is not a thing this platform stores — `points` carries `device_tag`
 * and nothing else does — so the device list is derived rather than fetched.
 * That is also why the tag is the key: there is no device id on this side.
 */
export function devicesFrom(points: IotPoint[], now?: number): DeviceRow[] {
  const by = new Map<string, DeviceRow>();
  for (const p of points) {
    const tag = p.device_tag || "(no device)";
    let row = by.get(tag);
    if (!row) {
      row = { tag, category: p.category, type: p.device_type, points: 0, quiet: 0, newestSec: null };
      by.set(tag, row);
    }
    row.points += 1;
    if (isQuiet(p, now)) row.quiet += 1;
    // A device carries its classification from whichever of its points has one:
    // the gateway sets it per device, so any point that has it agrees.
    row.category ||= p.category;
    row.type ||= p.device_type;
    const age = ageSec(p.last_seen_at, now);
    if (age !== null && (row.newestSec === null || age < row.newestSec)) row.newestSec = age;
  }
  return [...by.values()].sort((a, b) => b.points - a.points || a.tag.localeCompare(b.tag));
}

/** Devices matching a search term, across tag, equipment type and point tags. */
export function filterDevices(rows: DeviceRow[], points: IotPoint[], term: string): DeviceRow[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  // A point tag is what an operator has in front of them when something looks
  // wrong, and it is usually not the device's name, so searching only the
  // device would miss the case this box exists for.
  const byPoint = new Set(
    points
      .filter((p) => (p.point_tag || "").toLowerCase().includes(q))
      .map((p) => p.device_tag || "(no device)"),
  );
  return rows.filter(
    (d) =>
      d.tag.toLowerCase().includes(q) ||
      (d.type || "").toLowerCase().includes(q) ||
      byPoint.has(d.tag),
  );
}

/** Gateways matching a search term, across label, name, site and connection slug. */
export function filterGateways(gws: IotGateway[], term: string): IotGateway[] {
  const q = term.trim().toLowerCase();
  if (!q) return gws;
  return gws.filter(
    (g) =>
      (g.label || "").toLowerCase().includes(q) ||
      (g.name || "").toLowerCase().includes(q) ||
      (g.site || "").toLowerCase().includes(q) ||
      (g.connections || []).some((c) => (c.slug || "").toLowerCase().includes(q)),
  );
}

/** How many points a connection configured that have never arrived. */
export function missingPoints(c: IotConnection): number {
  return Math.max(0, (c.points || 0) - (c.arrived?.points || 0));
}

/** The gateway's display name: the operator's label wins over the hostname. */
export function gatewayName(g: IotGateway): string {
  return g.label?.trim() || g.name || g.gatewayId.slice(0, 8);
}

/** How an alert's acknowledgement renders. */
export type AckView = "acknowledged" | "reopened" | "open" | "unknown";

/**
 * The THREE states of `ack_state`, and why the third is not a synonym for the
 * second.
 *
 * `null` means the alert predates the acknowledgement wire — the gateway that
 * raised it could not report an acknowledgement at all, so nobody ever said
 * whether it was dealt with. Rendering that as "open" invents a fact about
 * whether a human looked at it, and a fault queue that does so is claiming work
 * is outstanding when it does not know.
 *
 * "reopened" is the fourth: state says open and history says it was once
 * acknowledged. Both are true, and an operator seeing a fault come back wants
 * to know it is a repeat rather than a first.
 */
export function ackView(a: IotAlert): AckView {
  if (a.ack_state === "acked") return "acknowledged";
  if (a.ack_state === null || a.ack_state === undefined) return "unknown";
  return a.acked_at ? "reopened" : "open";
}

/**
 * Whether this alert can be acknowledged from here.
 *
 * An alert in the unknown state cannot: there is no acknowledgement to change,
 * because the gateway carrying it does not report one. Offering the button
 * would produce a command the gateway accepts and never reflects.
 */
export function canAcknowledge(a: IotAlert): boolean {
  return ackView(a) !== "unknown";
}

/** Alerts an operator still has to deal with — "unknown" is NOT one of them. */
export function openAlerts(alerts: IotAlert[]): IotAlert[] {
  return alerts.filter((a) => {
    const v = ackView(a);
    return v === "open" || v === "reopened";
  });
}

/** One category tab: what it is, and how many devices sit under it. */
export interface CategoryTab {
  key: string;
  label: string;
  devices: number;
  /** Points on those devices that are not reporting. Drives the tab's warning. */
  quiet: number;
}

/**
 * The tabs, in a fixed order with "all" first.
 *
 * Order is deliberate and NOT by count: a tab bar whose tabs move when a device
 * is retired is one an operator cannot build muscle memory on. Categories the
 * estate does not have are dropped — an empty "Water" tab on a site with no
 * water meters is a dead end, not information.
 */
export const CATEGORY_ORDER = ["energy", "hvac", "water", "unclassified"] as const;

export function categoryTabs(rows: DeviceRow[]): CategoryTab[] {
  const tabs: CategoryTab[] = [
    {
      key: "all",
      label: "All",
      devices: rows.length,
      quiet: rows.reduce((s, d) => s + d.quiet, 0),
    },
  ];
  for (const key of CATEGORY_ORDER) {
    const mine = rows.filter((d) => (d.category || "unclassified") === key);
    if (mine.length === 0) continue;
    tabs.push({
      key,
      label: key === "hvac" ? "HVAC" : key[0].toUpperCase() + key.slice(1),
      devices: mine.length,
      quiet: mine.reduce((s, d) => s + d.quiet, 0),
    });
  }
  return tabs;
}

/** Devices under one tab. "all" is every device, not a category named "all". */
export function inCategory(rows: DeviceRow[], key: string): DeviceRow[] {
  if (key === "all") return rows;
  return rows.filter((d) => (d.category || "unclassified") === key);
}
