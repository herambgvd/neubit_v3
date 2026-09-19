/**
 * What the equipment drawing shows, and where. The rules:
 *
 *   • saved equipment is solid and drawn from the plant, where its values are
 *     live; a device already saved is never ALSO offered as a proposal;
 *   • leftovers (fragments) and devices of no known kind are not drawn;
 *   • a proposal hangs under the feeder the engine proposed — a saved one if
 *     that device is saved, the feeder's own proposal if not;
 *   • a meter with no feeder and nothing under it is NOT the top of the chain;
 *   • a headline is never invented from a missing value.
 */
import { describe, expect, it } from "vitest";

import type { BiPlant, BiPlantEquipment } from "@/lib/types";

import { buildDrawing, chainOf, countsOf, headlineOf, type Node, type SuggestedDevice, type Suggestions } from "./drawing";

const KINDS_OF: Record<string, string[]> = {
  chiller: ["chw_plant"],
  energy_meter: ["power"],
  ups: ["power"],
  tfa: ["air_handling"],
};

const saved = (id: string, tag: string, cls: string, device: string, over: Partial<BiPlantEquipment> = {}) =>
  ({
    equipment_id: id,
    tag,
    name: null,
    equipment_class: cls,
    system_id: "sys",
    fed_by_id: null,
    design: {},
    design_units: {},
    readiness: "reporting",
    readiness_counts: {},
    metrics: {},
    slots: [
      {
        slot: "kw",
        binding: { device_tag: device, point_tag: "TOT KW" },
        latest: { t: null, value: 12.5, text: null },
      },
    ],
    ...over,
  }) as unknown as BiPlantEquipment;

const plant = (...eq: BiPlantEquipment[]): BiPlant =>
  ({ site_id: "s1", systems: [{ equipment: eq }], unassigned_equipment: [] }) as unknown as BiPlant;

const device = (tag: string, cls: string | null, kind: SuggestedDevice["system_kind"], over: Partial<SuggestedDevice> = {}): SuggestedDevice => ({
  device_tag: tag,
  points: 5,
  last_seen_at: null,
  quiet: false,
  fragment: false,
  equipment_class: cls,
  system_kind: kind,
  why: "",
  slots: [],
  warnings: [],
  registered: null,
  feeder: null,
  ...over,
});

const sugg = (...devices: SuggestedDevice[]): Suggestions => ({
  devices,
  totals: { devices: devices.length, machines: 0, unknown: 0, fragments: 0, registered: 0 },
});

describe("buildDrawing", () => {
  it("draws saved equipment solid and never offers its device again", () => {
    const d = buildDrawing(
      plant(saved("e1", "B2_Main Incomer", "energy_meter", "B2_Main Incomer")),
      sugg(device("B2_Main Incomer", "energy_meter", "power"), device("4F_Incomer1_EM", "energy_meter", "power")),
      KINDS_OF,
    );
    expect(d.power.map((n) => [n.id, n.saved])).toEqual([
      ["eq:e1", true],
      ["dev:4F_Incomer1_EM", false],
    ]);
    expect(d.power[0].headline).toBe("12.5 kW");
  });

  it("does not offer a device the server says is registered, even before the plant shows it", () => {
    const d = buildDrawing(
      plant(),
      sugg(device("CH1", "chiller", "chw_plant", { registered: { equipment_tag: "CH-1", equipment_id: "e9" } })),
      KINDS_OF,
    );
    expect(d.chw_plant).toEqual([]);
  });

  it("leaves leftovers and unrecognised devices off the drawing", () => {
    const d = buildDrawing(
      undefined,
      sugg(device("gateway", null, null, { fragment: true }), device("Mystery", null, null), device("old", "chiller", "chw_plant", { fragment: true })),
      KINDS_OF,
    );
    expect(Object.values(d).flat()).toEqual([]);
  });

  it("hangs a proposal under its saved feeder, or under the feeder's own proposal", () => {
    const feed = (to: string) => ({ suggested: to, candidates: [to], reason: "" });
    const d = buildDrawing(
      plant(saved("e1", "MAIN", "energy_meter", "B2_Main Incomer")),
      sugg(
        device("4F_Incomer1_EM", "energy_meter", "power", { feeder: feed("B2_Main Incomer") }),
        device("4F Light DB", "energy_meter", "power", { feeder: feed("4F_Incomer1_EM") }),
        device("B1 Guard", "energy_meter", "power", { feeder: feed("Nowhere") }),
      ),
      KINDS_OF,
    );
    const parent = Object.fromEntries(d.power.map((n) => [n.label, n.parent]));
    expect(parent["4F_Incomer1_EM"]).toBe("eq:e1");
    expect(parent["4F Light DB"]).toBe("dev:4F_Incomer1_EM");
    // A feeder not on the drawing is not a parent it can show.
    expect(parent["B1 Guard"]).toBeNull();
  });

  it("hangs saved equipment off its fed_by_id", () => {
    const d = buildDrawing(
      plant(saved("e1", "MAIN", "energy_meter", "M"), saved("e2", "DB", "energy_meter", "D", { fed_by_id: "e1" })),
      undefined,
      KINDS_OF,
    );
    expect(d.power.find((n) => n.id === "eq:e2")?.parent).toBe("eq:e1");
  });

  it("marks a proposal whose checks raised anything", () => {
    const d = buildDrawing(
      undefined,
      sugg(
        device("A", "chiller", "chw_plant", { slots: [{ slot: "kw", point_tag: "x", value: 2312, at: null, alternatives: 0, warning: "an energy counter" }] }),
        device("B", "chiller", "chw_plant"),
      ),
      KINDS_OF,
    );
    expect(d.chw_plant.map((n) => n.warn)).toEqual([true, false]);
  });
});

describe("chainOf", () => {
  const n = (id: string, label: string, parent: string | null = null) => ({ id, label, parent }) as Node;

  it("puts a feeder with something under it at the top, and a lone meter apart", () => {
    const { roots, loose } = chainOf([n("a", "Incomer"), n("b", "Board", "a"), n("c", "Guard room")]);
    expect(roots.map((r) => [r.node.id, r.children.map((c) => c.node.id)])).toEqual([["a", ["b"]]]);
    expect(loose.map((x) => x.id)).toEqual(["c"]);
  });

  it("treats the main incomer as the top even with nothing under it yet", () => {
    const { roots, loose } = chainOf([n("m", "B2_Main Incomer")]);
    expect(roots.map((r) => r.node.id)).toEqual(["m"]);
    expect(loose).toEqual([]);
  });

  it("draws a chain three deep, sorted by name at each level", () => {
    const { roots } = chainOf([n("m", "Main"), n("z", "Z", "m"), n("a", "A", "m"), n("b", "B", "a")]);
    expect(roots[0].children.map((c) => c.node.id)).toEqual(["a", "z"]);
    expect(roots[0].children[0].children[0].node.id).toBe("b");
  });
});

describe("headlineOf", () => {
  it("gives a chiller its ΔT, and nothing when half the pair is missing", () => {
    expect(headlineOf("chiller", { chwr: 12, chws: 7 })).toBe("5 °C ΔT");
    expect(headlineOf("chiller", { chwr: 12, chws: null })).toBeNull();
  });

  it("gives a UPS its power and battery, whichever it has", () => {
    expect(headlineOf("ups", { kw: 3.2, battery: 98 })).toBe("3.2 kW · 98% battery");
    expect(headlineOf("ups", { battery: 98 })).toBe("98% battery");
    expect(headlineOf("ups", {})).toBeNull();
  });

  it("never prints a zero for a value that is not there", () => {
    expect(headlineOf("energy_meter", {})).toBeNull();
    expect(headlineOf("energy_meter", { kw: 0 })).toBe("0 kW");
  });
});

describe("countsOf", () => {
  it("counts saved of total per kind", () => {
    const d = buildDrawing(
      plant(saved("e1", "M", "energy_meter", "M")),
      sugg(device("X", "energy_meter", "power"), device("T", "tfa", "air_handling")),
      KINDS_OF,
    );
    const c = countsOf(d);
    expect(c.power).toEqual({ saved: 1, total: 2 });
    expect(c.air_handling).toEqual({ saved: 0, total: 1 });
    expect(c.chw_plant).toEqual({ saved: 0, total: 0 });
  });
});
