/**
 * GATES 1–4 OPEN IN SETUP. A shut gate's action is the Setup task that opens
 * it — the gate strip and the checklist are two views of one to-do list, so a
 * gate that sent an operator anywhere else would be a second door to the same
 * work.
 */
import { describe, expect, it } from "vitest";

import { deriveGates } from "./gates";

const shut = deriveGates({
  subject: { kind: "estate", label: "the estate" },
  summary: {
    total_points: 10,
    total_registers: 8,
    sites: [{ site_id: null, points: 4, categories: [] }],
  },
  ghosts: { groups: [{ device_tag: "D", point_tag: "P", mode: "auto", members: [] }] },
  patterns: { totals: { points: 10, already_confirmed: 2, eligible: 5, unmatched: 3 }, patterns: [] },
  orphans: { orphans: [{ role: "r", point_id: "p", category: null, candidates: [] }] },
  unplaced: { total: 2, items: [] },
  alerts: { available: true },
  may: { bi: true },
});
const action = (id: string) => shut.find((g) => g.id === id)!.action?.href;

describe("a shut gate's action", () => {
  it("gate 1 lands on Setup → Duplicates", () => {
    expect(action("arrives")).toBe("/bi/setup/duplicates");
  });

  it("gate 2 lands on Setup → Units", () => {
    expect(action("means")).toBe("/bi/setup/units");
  });

  it("gate 3 lands on Setup → Buildings & devices, scoped for a domain", () => {
    expect(action("belongs")).toBe("/bi/setup/placement");
    const hvac = deriveGates({
      subject: { kind: "domain", category: "hvac", label: "HVAC" },
      summary: {
        categories: [{ category: "hvac", points: 4 }],
        sites: [{ site_id: null, points: 4, categories: [{ category: "hvac", points: 4 }] }],
      },
      may: { bi: true },
    });
    expect(hvac.find((g) => g.id === "belongs")!.action?.href).toBe("/bi/setup/placement?category=hvac");
  });

  it("gate 4 lands on Setup's stranded-role worklist", () => {
    expect(action("binds")).toBe("/bi/setup/stranded");
  });
});
