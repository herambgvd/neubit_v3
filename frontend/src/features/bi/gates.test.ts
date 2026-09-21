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
    total_points_with_unit: 4,
    sites: [{ site_id: null, points: 4, categories: [] }],
  },
  orphans: { orphans: [{ role: "r", point_id: "p", category: null, candidates: [] }] },
  unplaced: { total: 2, items: [] },
  alerts: { available: true },
  may: { bi: true },
});
const action = (id: string) => shut.find((g) => g.id === id)!.action?.href;

describe("a shut gate's action", () => {
  it("gates 1 and 2 offer no action here — the gateway is where they are opened", () => {
    // Identity and unit are the GATEWAY's: it keeps its point ids across a
    // rebuild and carries the unit on every envelope. A link to a screen on
    // this platform would be a door onto work that cannot be done behind it.
    expect(action("arrives")).toBeUndefined();
    expect(action("means")).toBeUndefined();
  });

  it("gate 1 still states the inflation left by rows that predate that", () => {
    const one = shut.find((g) => g.id === "arrives")!;
    expect(one.state).toBe("shut");
    expect(one.blocking).toContain("2 of the 10 rows");
  });

  it("gate 2 counts the points carrying no unit at all", () => {
    const two = shut.find((g) => g.id === "means")!;
    expect(two.state).toBe("shut");
    expect(two.count).toBe(6);
    expect(two.blocking).toContain("gateway");
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


// ── GATE 6 · ACTS ────────────────────────────────────────────────────────────
//
// The gate that hands something to a person. Its two failure modes are opposite
// and both expensive: counting a healthy chiller as work (there is no pass mark
// in the registry, so `ok` is not a fault), and counting every finding as
// unattended because the console was not allowed to ask who is already on it.

const f = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    source_key: "bi:equipment:e1:slot:chws",
    kind: "data_fault",
    status: "silent",
    equipment_tag: "CH-1",
    title: "CHW supply has gone quiet",
    work: { source_key: "bi:equipment:e1:slot:chws", name: "n", description: "d", site_id: "s1", trigger_data: {} },
    ...over,
  }) as never;

const acts = (input: Record<string, unknown>) =>
  deriveGates({
    subject: { kind: "site", siteId: "s1", label: "Aeon Tower" },
    summary: { total_points: 10, sites: [{ site_id: "s1", points: 10, score: 61, categories: [] }] },
    orphans: { orphans: [] },
    alerts: { available: true },
    may: { bi: true, work: true },
    findingHours: 24,
    ...input,
  } as never).find((g) => g.id === "acts")!;

describe("gate 6", () => {
  it("passes when there is nothing to act on, and says so quietly", () => {
    const g = acts({ findings: [], openWork: {} });
    expect(g.state).toBe("pass");
    expect(g.count).toBeNull();
  });

  it("shuts on findings nobody has work open about, and counts only those", () => {
    const g = acts({
      findings: [f(), f({ source_key: "k:2", title: "Band not recorded", kind: "equipment_metric", status: "missing_fact" })],
      openWork: { "k:2": { instance_id: "i1", name: "INC-1", sop_name: "s", status: "open", priority: null, current_state_name: "Triage", assigned_to: null, created_at: "t" } },
    });
    expect(g.state).toBe("shut");
    expect(g.count).toBe(1);
    expect(g.blocking).toContain("1 already");
    expect(g.rows.map((r) => r.key)).toEqual(["bi:equipment:e1:slot:chws"]);
  });

  it("opens its worklist, keeping the building in scope", () => {
    const g = acts({ findings: [f()], openWork: {} });
    expect(g.action?.href).toBe("/bi/work?site=s1");
  });

  it("passes once every finding has work open", () => {
    const g = acts({
      findings: [f()],
      openWork: { "bi:equipment:e1:slot:chws": { instance_id: "i", name: "INC", sop_name: "s", status: "open", priority: null, current_state_name: null, assigned_to: null, created_at: "t" } },
    });
    expect(g.state).toBe("pass");
  });

  it("says it does not know rather than calling everything unattended", () => {
    // Reading who is already on a finding is the workflow service's key, not a
    // BI one. Without it the honest answer is unknown — never a backlog.
    const g = acts({ findings: [f()], openWork: undefined, may: { bi: true, work: false } });
    expect(g.state).toBe("unknown");
    expect(g.count).toBeNull();
    expect(g.blocking).toContain("workflow.instance.read");
  });

  it("names the window the findings were read over", () => {
    expect(acts({ findings: [f()], openWork: {} }).blocking).toContain("last 24 hours");
  });
});
