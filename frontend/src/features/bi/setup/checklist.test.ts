/**
 * The checklist's model: one row per Setup task, each a state, a one-line
 * count and the page that changes it — and a read that has not answered is
 * `unknown` with "—", never a zero and never `done`.
 */
import { describe, expect, it } from "vitest";

import type { BiSiteFactsRow, EquipmentPublic, InfrastructureTree } from "@/lib/types";

import { deriveChecklist, openStep, type ChecklistInput, type ChecklistRow } from "./checklist";

const T = "2026-09-01T00:00:00Z";
const building = (over: Partial<BiSiteFactsRow> = {}): BiSiteFactsRow => ({
  site_id: "s1",
  site_name: "Aeon Tower",
  is_active: true,
  gross_floor_area_sqm: null,
  energy_tariff_per_kwh: null,
  tariff_currency: null,
  occupancy: null,
  facts_updated_at: null,
  mirrored_at: null,
  points: 0,
  kwh_points: 0,
  ...over,
});
const eq = (over: Partial<EquipmentPublic>): EquipmentPublic => ({
  equipment_id: "e1",
  site_id: "s1",
  system_id: "sys1",
  tag: "CH-01",
  name: null,
  equipment_class: "chiller",
  design: {},
  design_units: {},
  slots: [],
  created_at: T,
  updated_at: T,
  ...over,
});
const tree = (equipment: EquipmentPublic[], site = "s1"): InfrastructureTree => ({
  site_id: site,
  systems: [
    { system_id: "sys1", site_id: site, name: "Plant", kind: "chw_plant", description: null, created_at: T, updated_at: T, equipment },
  ],
});

const rowOf = (input: ChecklistInput, id: string) => deriveChecklist(input).find((r) => r.task.id === id)!;

describe("the rows", () => {
  it("are the tasks a person here can do, in pipeline order, with the page that works each", () => {
    // Duplicates and Units are not among them: the gateway keeps its point ids
    // across a rebuild and carries the unit on every envelope, so both are
    // answered before a reading reaches this store.
    const rows = deriveChecklist({});
    expect(rows.map((r) => [r.task.label, r.href])).toEqual([
      ["Buildings & devices", "/bi/setup/placement"],
      ["Equipment", "/bi/setup/equipment"],
      ["Metric roles", "/bi/setup/roles"],
      ["Building facts", "/bi/setup/facts"],
    ]);
  });

  it("are all unknown, with no figure, before any read answers", () => {
    for (const r of deriveChecklist({})) {
      expect(r.state, r.task.id).toBe("unknown");
      expect(r.count, r.task.id).not.toMatch(/\b0\b/);
    }
  });
});

describe("buildings & devices", () => {
  it("counts placed against unplaced devices", () => {
    const r = rowOf({ unplaced: { total: 40 }, placed: { total: 12 } }, "placement");
    expect(r.state).toBe("partly");
    expect(r.count).toBe("12 placed · 40 unplaced devices");
  });

  it("prints a placed count it could not read as —, not 0", () => {
    const r = rowOf({ unplaced: { total: 40 } }, "placement");
    expect(r.count).toBe("— placed · 40 unplaced devices");
    expect(r.stateLabel).toBe("to do");
  });
});

describe("equipment", () => {
  it("is not started with no equipment on any building", () => {
    const r = rowOf({ buildings: [building()], trees: { s1: tree([]) } }, "equipment");
    expect(r.state).toBe("todo");
    expect(r.count).toBe("0 chillers · 0 equipment");
  });

  it("is partly done while a chiller has no ΔT band or a slot has no point", () => {
    const noBand = eq({ design: { tr: 350 } });
    const r = rowOf({ buildings: [building()], trees: { s1: tree([noBand]) } }, "equipment");
    expect(r.state).toBe("partly");
    expect(r.count).toBe("1 chiller · 1 equipment · 1 without ΔT band");

    const unbound = eq({
      design: { design_dt_min: 5, design_dt_max: 7 },
      slots: [{ slot: "chws", device_tag: null, point_tag: null, bound: false }],
    });
    expect(rowOf({ buildings: [building()], trees: { s1: tree([unbound]) } }, "equipment").count).toBe(
      "1 chiller · 1 equipment · 0/1 slots bound",
    );
  });

  it("is done with every band on file and every slot bound", () => {
    const ok = eq({
      design: { design_dt_min: 5, design_dt_max: 7 },
      slots: [{ slot: "chws", device_tag: "CH1", point_tag: "OWT", bound: true }],
    });
    expect(rowOf({ buildings: [building()], trees: { s1: tree([ok]) } }, "equipment").state).toBe("done");
  });

  it("is unknown until EVERY building's registry has answered", () => {
    const r = rowOf(
      { buildings: [building(), building({ site_id: "s2" })], trees: { s1: tree([]) } },
      "equipment",
    );
    expect(r.state).toBe("unknown");
    expect(r.count).toBe("—");
  });
});

describe("metric roles", () => {
  it("sends stranded roles to the worklist that re-points them", () => {
    const r = rowOf({ roles: { counts: { confirmed: 20 } }, orphans: { orphans: [{}, {}] } }, "roles");
    expect(r.state).toBe("partly");
    expect(r.count).toBe("20 bound · 2 stranded");
    expect(r.href).toBe("/bi/setup/stranded");
  });

  it("is done with roles bound and none stranded, and opens the role list", () => {
    const r = rowOf({ roles: { counts: { confirmed: 20 } }, orphans: { orphans: [] } }, "roles");
    expect(r.state).toBe("done");
    expect(r.href).toBe("/bi/setup/roles");
  });

  it("is not started with nothing bound", () => {
    expect(rowOf({ roles: { counts: { confirmed: 0 } }, orphans: { orphans: [] } }, "roles").state).toBe("todo");
  });
});

describe("building facts", () => {
  it("marks each fact for a single building", () => {
    const r = rowOf(
      {
        buildings: [building({ gross_floor_area_sqm: 18500, energy_tariff_per_kwh: 8.5 })],
        slabs: { s1: 0 },
        factors: { s1: 0 },
      },
      "facts",
    );
    expect(r.count).toBe("area ✓ · tariff ✓ · emission factor ✗");
    expect(r.state).toBe("partly");
  });

  it("counts a tariff recorded as time-of-use slabs", () => {
    const r = rowOf({ buildings: [building({ gross_floor_area_sqm: 1 })], slabs: { s1: 3 }, factors: { s1: 1 } }, "facts");
    expect(r.count).toBe("area ✓ · tariff ✓ · emission factor ✓");
    expect(r.state).toBe("done");
  });

  it("prints a fact it could not read as —, and does not call the row done", () => {
    const r = rowOf({ buildings: [building({ gross_floor_area_sqm: 1, energy_tariff_per_kwh: 2 })] }, "facts");
    expect(r.count).toBe("area ✓ · tariff ✓ · emission factor —");
    expect(r.state).toBe("unknown");
  });

  it("counts across buildings", () => {
    const r = rowOf(
      {
        buildings: [building({ gross_floor_area_sqm: 1 }), building({ site_id: "s2" })],
        slabs: { s1: 0, s2: 0 },
        factors: { s1: 0, s2: 0 },
      },
      "facts",
    );
    expect(r.count).toBe("area 1/2 · tariff 0/2 · emission factor 0/2");
  });

  it("is not started when nothing is recorded anywhere", () => {
    expect(rowOf({ buildings: [building()], slabs: { s1: 0 }, factors: { s1: 0 } }, "facts").stateLabel).toBe(
      "not started",
    );
  });
});


// ── the step the screen opens ────────────────────────────────────────────────

const rows = (...states: ChecklistRow["state"][]): ChecklistRow[] =>
  states.map((state) => ({ state }) as ChecklistRow);

describe("which step is open", () => {
  it("is the first one that is not done", () => {
    expect(openStep(rows("done", "done", "partly", "todo"))).toBe(2);
    expect(openStep(rows("todo", "done"))).toBe(0);
  });

  it("stops on a gate it could not read, rather than skipping past it", () => {
    // A failed read cannot say the gate is fine, and opening the next step
    // would say exactly that about this one — on top of the order being the
    // point: a role bound on a device no building owns is work thrown away.
    expect(openStep(rows("done", "unknown", "todo"))).toBe(1);
  });

  it("opens nothing at all when every gate is answered", () => {
    expect(openStep(rows("done", "done", "done"))).toBe(-1);
  });
});

// ── how far along, where the read can measure both ends ──────────────────────

describe("progress", () => {
  it("measures placement against placed plus unplaced", () => {
    const [place] = deriveChecklist({ placed: { total: 11 }, unplaced: { total: 38 } });
    expect(place.progress).toEqual({ done: 11, total: 49 });
  });

  it("measures roles against every assertion, stranded ones included", () => {
    const list = deriveChecklist({ roles: { counts: { confirmed: 19 } }, orphans: { orphans: [1, 2] } });
    expect(list[2].progress).toEqual({ done: 19, total: 21 });
  });

  it("claims no progress from a read that did not answer", () => {
    const [place] = deriveChecklist({ unplaced: { total: 38 } });
    expect(place.progress).toBeUndefined();
  });
});

// ── what a green tick does not mean ──────────────────────────────────────────

describe("the Equipment caveat", () => {
  const tree = (equipment: EquipmentPublic[]): InfrastructureTree => ({
    site_id: "s1",
    systems: [{
      system_id: "sys1", site_id: "s1", name: "Plant A", kind: "chw_plant",
      description: null, equipment, created_at: T, updated_at: T,
    }],
  });
  const bound = [{ slot: "chws", device_tag: "d", point_tag: "p", bound: true }];

  it("says a registry with no chiller in it has nothing to grade", () => {
    // `done` means every slot on every REGISTERED machine is bound. It is not
    // a claim that the plant has been described.
    const [, eqRow] = deriveChecklist({
      buildings: [building()],
      trees: { s1: tree([eq({ equipment_class: "ahu", slots: bound })]) },
    });
    expect(eqRow.state).toBe("done");
    expect(eqRow.note).toMatch(/no chiller is registered/);
  });

  it("says nothing of the sort once a chiller is registered", () => {
    const [, eqRow] = deriveChecklist({
      buildings: [building()],
      trees: { s1: tree([eq({ design: { design_dt_min: 4.5, design_dt_max: 6 }, slots: bound })]) },
    });
    expect(eqRow.note).toBeUndefined();
  });

  it("says nothing of the sort when no machine is registered at all — the count already does", () => {
    const [, eqRow] = deriveChecklist({ buildings: [building()], trees: { s1: tree([]) } });
    expect(eqRow.state).toBe("todo");
    expect(eqRow.note).toBeUndefined();
  });
});
