// The IoT fleet screen's arithmetic.
//
// Every case below was checked by breaking the source and watching it fail. The
// one that matters most is the three-number rule: configured, arrived and
// reporting are three different statements, and a test that lets them collapse
// into one would let the screen hide two faults.
import { describe, expect, it } from "vitest";

import {
  QUIET_AFTER_SEC,
  ackView,
  canAcknowledge,
  openAlerts,
  ageSec,
  devicesFrom,
  filterDevices,
  categoryTabs,
  filterGateways,
  gatewayName,
  inCategory,
  gatewayTotals,
  isQuiet,
  missingPoints,
} from "./selectors";
import type { DeviceRow } from "./selectors";
import type { IotAlert, IotConnection, IotGateway, IotPoint } from "./types";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

const point = (p: Partial<IotPoint> = {}): IotPoint => ({
  point_id: Math.random().toString(36).slice(2),
  device_tag: "meter-1",
  point_tag: "kw",
  unit: null,
  category: "energy",
  device_type: "incomer",
  last_seen_at: ago(60),
  retired_at: null,
  live: true,
  latest: null,
  ...p,
});

const conn = (c: Partial<IotConnection> = {}): IotConnection => ({
  id: "c1",
  slug: "aeon",
  name: "aeon",
  proto: "mqtt",
  devices: 38,
  points: 437,
  arrived: { devices: 38, points: 436, last_seen_at: ago(120) },
  ...c,
});

const gw = (g: Partial<IotGateway> = {}): IotGateway => ({
  gatewayId: "bc589f90-5809-4ad8-af59-2d59f8b31dd9",
  name: "73601100fb85",
  version: "0.3.0",
  health: "healthy",
  uptimeSec: 1384,
  stats: { published: 1745, dropped: 0, buffered: 0, outboxDepth: 0 },
  counts: { connections: 1, devices: 38, points: 437 },
  connections: [conn()],
  label: "Head office",
  site: "Pune",
  notes: "",
  tags: ["central"],
  state: "approved",
  status: "online",
  lastSeenSec: 0,
  ...g,
});

describe("ageSec", () => {
  it("measures back from now", () => {
    expect(ageSec(ago(90), NOW)).toBe(90);
  });

  it("is null for a point that has never reported", () => {
    expect(ageSec(null, NOW)).toBeNull();
  });

  it("is null for a timestamp that does not parse, rather than NaN", () => {
    // NaN would compare false against every threshold and quietly read as fresh.
    expect(ageSec("not a date", NOW)).toBeNull();
  });

  it("never goes negative on a clock that is slightly ahead", () => {
    expect(ageSec(new Date(NOW + 5000).toISOString(), NOW)).toBe(0);
  });
});

describe("isQuiet", () => {
  it("is false inside the freshness window", () => {
    expect(isQuiet(point({ last_seen_at: ago(QUIET_AFTER_SEC - 1) }), NOW)).toBe(false);
  });

  it("is true past it", () => {
    expect(isQuiet(point({ last_seen_at: ago(QUIET_AFTER_SEC + 1) }), NOW)).toBe(true);
  });

  it("counts a point that has never reported as quiet, not as unknown", () => {
    // It is in this table because a reading created its dimension row, so a
    // missing timestamp is a gap rather than a point nobody has heard of.
    expect(isQuiet(point({ last_seen_at: null }), NOW)).toBe(true);
  });
});

describe("gatewayTotals", () => {
  it("keeps configured, arrived and reporting as three separate numbers", () => {
    const points = [
      point({ last_seen_at: ago(60) }),
      point({ last_seen_at: ago(60) }),
      point({ last_seen_at: ago(9999) }),
    ];
    const t = gatewayTotals(gw(), points, NOW);
    expect(t.configured).toBe(437); // what the gateway has
    expect(t.arrived).toBe(436); //    what ever reached us
    expect(t.reporting).toBe(2); //    of the points we hold, what is live
    expect(t.quiet).toBe(1);
  });

  it("sums across several connections", () => {
    const g = gw({
      connections: [
        conn({ id: "c1", points: 100, arrived: { devices: 5, points: 90, last_seen_at: ago(60) } }),
        conn({ id: "c2", points: 50, arrived: { devices: 3, points: 50, last_seen_at: ago(60) } }),
      ],
    });
    const t = gatewayTotals(g, [], NOW);
    expect(t.configured).toBe(150);
    expect(t.arrived).toBe(140);
    expect(t.devices).toBe(8);
    expect(t.connections).toBe(2);
  });

  it("reports zero rather than a guess while the points are still loading", () => {
    // `undefined` is "not fetched yet". Inventing a reporting count from the
    // arrived figure would show a number nobody measured.
    const t = gatewayTotals(gw(), undefined, NOW);
    expect(t.reporting).toBe(0);
    expect(t.quiet).toBe(0);
    expect(t.arrived).toBe(436); // this one IS known, from the gateway
  });

  it("flags a gateway that cannot report its connections at all", () => {
    // null is not []. The screen has to be able to say "unknown" instead of
    // "this gateway has no connections".
    const t = gatewayTotals(gw({ connections: null }), [], NOW);
    expect(t.inventoryUnknown).toBe(true);
    expect(t.configured).toBe(0);
  });

  it("does not flag a gateway that reported an empty list", () => {
    const t = gatewayTotals(gw({ connections: [] }), [], NOW);
    expect(t.inventoryUnknown).toBe(false);
  });
});

describe("devicesFrom", () => {
  it("folds points into their device, busiest first", () => {
    const rows = devicesFrom(
      [
        point({ device_tag: "a" }),
        point({ device_tag: "b" }),
        point({ device_tag: "b" }),
        point({ device_tag: "b" }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.tag, r.points])).toEqual([
      ["b", 3],
      ["a", 1],
    ]);
  });

  it("counts a device's quiet points separately from its total", () => {
    const rows = devicesFrom(
      [
        point({ device_tag: "a", last_seen_at: ago(60) }),
        point({ device_tag: "a", last_seen_at: ago(9999) }),
      ],
      NOW,
    );
    expect(rows[0]).toMatchObject({ points: 2, quiet: 1 });
  });

  it("takes the freshest point as the device's last reading", () => {
    // The fresh point comes FIRST here on purpose: with it last, "keep the
    // newest" and "keep whichever was seen last" give the same answer and the
    // test proves nothing.
    const rows = devicesFrom(
      [
        point({ device_tag: "a", last_seen_at: ago(30) }),
        point({ device_tag: "a", last_seen_at: ago(500) }),
      ],
      NOW,
    );
    expect(rows[0].newestSec).toBe(30);
  });

  it("takes a classification from whichever point carries one", () => {
    // The gateway sets category per device, so a point that has it agrees with
    // every other point on that device; one that does not is simply older.
    const rows = devicesFrom(
      [
        point({ device_tag: "a", category: null, device_type: null }),
        point({ device_tag: "a", category: "hvac", device_type: "chiller" }),
      ],
      NOW,
    );
    expect(rows[0]).toMatchObject({ category: "hvac", type: "chiller" });
  });

  it("gives points with no device a home rather than dropping them", () => {
    const rows = devicesFrom([point({ device_tag: null })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).toBe("(no device)");
  });

  it("ties break by name, so the order does not shuffle between refetches", () => {
    const rows = devicesFrom([point({ device_tag: "z" }), point({ device_tag: "a" })], NOW);
    expect(rows.map((r) => r.tag)).toEqual(["a", "z"]);
  });
});

describe("filterDevices", () => {
  const points = [
    point({ device_tag: "4F_UPS01", point_tag: "BettVolt_V", device_type: "ups" }),
    point({ device_tag: "B2_Main Incomer", point_tag: "CAvg_A", device_type: "incomer" }),
  ];
  const rows = devicesFrom(points, NOW);

  it("matches the device tag", () => {
    expect(filterDevices(rows, points, "ups0").map((r) => r.tag)).toEqual(["4F_UPS01"]);
  });

  it("matches the equipment type", () => {
    expect(filterDevices(rows, points, "incomer").map((r) => r.tag)).toEqual(["B2_Main Incomer"]);
  });

  it("matches a POINT tag and returns the device that owns it", () => {
    // A point tag is what an operator has in front of them when something looks
    // wrong, and it is usually not the device's name.
    expect(filterDevices(rows, points, "cavg").map((r) => r.tag)).toEqual(["B2_Main Incomer"]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(filterDevices(rows, points, "  BETTVOLT  ").map((r) => r.tag)).toEqual(["4F_UPS01"]);
  });

  it("returns everything for an empty term", () => {
    expect(filterDevices(rows, points, "   ")).toHaveLength(2);
  });
});

describe("filterGateways", () => {
  const list = [gw(), gw({ gatewayId: "g2", label: "", name: "plant-01", site: "Nashik", connections: [] })];

  it("matches the operator's label", () => {
    expect(filterGateways(list, "head").map(gatewayName)).toEqual(["Head office"]);
  });

  it("matches the site", () => {
    expect(filterGateways(list, "nashik").map(gatewayName)).toEqual(["plant-01"]);
  });

  it("matches a connection slug", () => {
    expect(filterGateways(list, "aeon").map(gatewayName)).toEqual(["Head office"]);
  });

  it("survives a gateway whose inventory is unknown", () => {
    expect(() => filterGateways([gw({ connections: null })], "aeon")).not.toThrow();
  });
});

describe("missingPoints", () => {
  it("is the configured points that have never arrived", () => {
    expect(missingPoints(conn())).toBe(1);
  });

  it("never goes negative when more arrived than are configured", () => {
    // A point deleted on the gateway keeps its dimension row here, so arrived
    // can legitimately exceed configured. That is not "−3 missing".
    expect(missingPoints(conn({ points: 10, arrived: { devices: 1, points: 13, last_seen_at: null } }))).toBe(0);
  });
});

describe("gatewayName", () => {
  it("prefers the operator's label over the hostname", () => {
    expect(gatewayName(gw())).toBe("Head office");
  });

  it("falls back to the hostname when the label is blank", () => {
    expect(gatewayName(gw({ label: "   " }))).toBe("73601100fb85");
  });

  it("falls back to a short id when there is neither", () => {
    expect(gatewayName(gw({ label: "", name: "" }))).toBe("bc589f90");
  });
});


describe("ackView", () => {
  const alert = (p: Partial<IotAlert> = {}): IotAlert => ({
    alert_id: "a1",
    ts: ago(60),
    severity: "critical",
    alert_type: "rule",
    device_tag: "B2_Main Incomer",
    point_addr: "aeonhwj/x",
    message: "over 100 A",
    device_category: "energy",
    ack_state: null,
    acked_at: null,
    ...p,
  });

  it("reads acked as acknowledged", () => {
    expect(ackView(alert({ ack_state: "acked", acked_at: ago(30) }))).toBe("acknowledged");
  });

  it("reads open with no history as open", () => {
    expect(ackView(alert({ ack_state: "open" }))).toBe("open");
  });

  it("reads open WITH history as reopened", () => {
    // State says open, history says it was once acknowledged. Both are true,
    // and an operator seeing a fault come back wants to know it is a repeat.
    expect(ackView(alert({ ack_state: "open", acked_at: ago(600) }))).toBe("reopened");
  });

  it("does NOT read a missing state as open", () => {
    // THE case. null means the alert predates the acknowledgement wire, so
    // nobody ever said. Calling it open claims work is outstanding when we do
    // not know that.
    expect(ackView(alert({ ack_state: null }))).toBe("unknown");
  });

  it("treats a stale acked_at on an unknown alert as still unknown", () => {
    // acked_at without ack_state cannot mean acknowledged: the column is
    // history, and the alert's current state was never reported.
    expect(ackView(alert({ ack_state: null, acked_at: ago(600) }))).toBe("unknown");
  });
});

describe("canAcknowledge", () => {
  const alert = (ack_state: string | null): IotAlert => ({
    alert_id: "a1", ts: ago(60), severity: "warning", alert_type: "rule",
    device_tag: "d", point_addr: "p", message: "m", device_category: null,
    ack_state, acked_at: null,
  });

  it("allows acknowledging an open alert", () => {
    expect(canAcknowledge(alert("open"))).toBe(true);
  });

  it("allows reopening an acknowledged one", () => {
    expect(canAcknowledge(alert("acked"))).toBe(true);
  });

  it("refuses an alert whose gateway cannot report acknowledgement", () => {
    // The command would be accepted and never reflected.
    expect(canAcknowledge(alert(null))).toBe(false);
  });
});

describe("openAlerts", () => {
  const alert = (id: string, ack_state: string | null, acked_at: string | null = null): IotAlert => ({
    alert_id: id, ts: ago(60), severity: "warning", alert_type: "rule",
    device_tag: "d", point_addr: "p", message: "m", device_category: null,
    ack_state, acked_at,
  });

  it("counts open and reopened, and not acknowledged", () => {
    const rows = [alert("a", "open"), alert("b", "acked", ago(30)), alert("c", "open", ago(30))];
    expect(openAlerts(rows).map((a) => a.alert_id)).toEqual(["a", "c"]);
  });

  it("does not count an alert whose state was never reported", () => {
    // A queue that counted these would tell an operator there is outstanding
    // work it cannot actually name.
    expect(openAlerts([alert("a", null)])).toHaveLength(0);
  });
});

describe("categoryTabs", () => {
  const dev = (tag: string, category: string | null, quiet = 0): DeviceRow => ({
    tag,
    category,
    type: null,
    points: 5,
    quiet,
    newestSec: 60,
  });

  it("puts All first and keeps a FIXED order after it", () => {
    // Not ordered by count, and not alphabetical: a tab bar whose tabs move
    // when a device is retired is one nobody can build muscle memory on.
    //
    // `unclassified` is in here on purpose — it is the one category where the
    // declared order and alphabetical order disagree (water would sort after
    // it), so without it this test passes against a plain sort().
    const rows = [
      dev("a", "water"),
      dev("b", "energy"),
      dev("c", "hvac"),
      dev("d", null),
    ];
    expect(categoryTabs(rows).map((t) => t.key)).toEqual([
      "all",
      "energy",
      "hvac",
      "water",
      "unclassified",
    ]);
  });

  it("drops a category the estate does not have", () => {
    // An empty "Water" tab on a site with no water meters is a dead end.
    expect(categoryTabs([dev("a", "energy")]).map((t) => t.key)).toEqual(["all", "energy"]);
  });

  it("files a device with no category under unclassified", () => {
    const tabs = categoryTabs([dev("a", null)]);
    expect(tabs.map((t) => t.key)).toEqual(["all", "unclassified"]);
    expect(tabs[1].devices).toBe(1);
  });

  it("counts devices and their quiet points per tab", () => {
    const rows = [dev("a", "energy", 2), dev("b", "energy", 1), dev("c", "hvac", 0)];
    const tabs = categoryTabs(rows);
    expect(tabs.find((t) => t.key === "all")).toMatchObject({ devices: 3, quiet: 3 });
    expect(tabs.find((t) => t.key === "energy")).toMatchObject({ devices: 2, quiet: 3 });
    expect(tabs.find((t) => t.key === "hvac")).toMatchObject({ devices: 1, quiet: 0 });
  });

  it("spells HVAC in capitals and the rest in title case", () => {
    const tabs = categoryTabs([dev("a", "hvac"), dev("b", "energy")]);
    expect(tabs.map((t) => t.label)).toEqual(["All", "Energy", "HVAC"]);
  });

  it("is just All for an empty estate", () => {
    expect(categoryTabs([]).map((t) => t.key)).toEqual(["all"]);
  });
});

describe("inCategory", () => {
  const dev = (tag: string, category: string | null): DeviceRow => ({
    tag, category, type: null, points: 1, quiet: 0, newestSec: 1,
  });

  it("returns everything for all", () => {
    const rows = [dev("a", "energy"), dev("b", "hvac")];
    expect(inCategory(rows, "all")).toHaveLength(2);
  });

  it("narrows to one category", () => {
    const rows = [dev("a", "energy"), dev("b", "hvac")];
    expect(inCategory(rows, "hvac").map((d) => d.tag)).toEqual(["b"]);
  });

  it("matches uncategorised devices under unclassified", () => {
    expect(inCategory([dev("a", null)], "unclassified").map((d) => d.tag)).toEqual(["a"]);
  });
});
