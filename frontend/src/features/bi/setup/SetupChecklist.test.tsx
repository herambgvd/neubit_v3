/**
 * BI → Setup opens on a PATH: one row per task in gate order, and exactly one
 * of them OPEN — the first that is not done — carrying the question that gate
 * asks, the press, and what answering it frees. The other five are one line
 * each with their state, their figure and "Open →".
 *
 * The rule that matters: the walk stops at the first row that is not `done`,
 * `unknown` included. Skipping an unreadable gate would tell an operator it is
 * fine, which is the one thing a failed read cannot say.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub, type Recorded } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import SetupChecklist from "./SetupChecklist";

const perms = { granted: new Set<string>(), modules: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

let stub: ApiStub;

beforeEach(() => {
  perms.granted = new Set(["bi.read", "sites.read"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/points/ghosts": { total: 3, auto: 2, manual: 1, groups: [], resurrected: [] },
    "GET /bi/units/patterns": { totals: { points: 283, already_confirmed: 190 }, patterns: [] },
    "GET /bi/devices": (req: Recorded) => ({ total: req.search.get("placement") === "placed" ? 12 : 40, items: [] }),
    "GET /bi/metrics/roles": { counts: { points: 400, confirmed: 20, unconfirmed: 380 }, items: [] },
    "GET /bi/points/roles/orphans": { orphans: [] },
    "GET /bi/rating/sites": {
      items: [
        {
          site_id: "s1", site_name: "Aeon Tower", is_active: true, gross_floor_area_sqm: 18500,
          energy_tariff_per_kwh: 8.5, tariff_currency: "INR", occupancy: null, facts_updated_at: null,
          mirrored_at: null, points: 10, kwh_points: 1,
        },
      ],
    },
    "GET /sites/s1/infrastructure": { site_id: "s1", systems: [] },
    "GET /sites/s1/tariff-slabs": { items: [], total: 0 },
    "GET /sites/s1/emission-factors": { items: [], total: 0 },
  });
});

const item = (name: string) => screen.getByRole("listitem", { name });

describe("the checklist", () => {
  it("has one row per task, in gate order", async () => {
    renderWithProviders(<SetupChecklist />);
    const list = await screen.findByRole("list", { name: "Setup checklist" });

    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
      "Duplicates",
      "Units",
      "Buildings & devices",
      "Equipment",
      "Metric roles",
      "Building facts",
    ]);
  });

  it("opens the FIRST task that is not done, and only that one", async () => {
    renderWithProviders(<SetupChecklist />);
    const first = await screen.findByRole("listitem", { name: "Duplicates" });

    expect(first).toHaveAttribute("aria-current", "step");
    expect(within(first).getByText("which row is the live sensor?", { exact: false })).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: /Settle the duplicates/ })).toHaveAttribute(
      "href",
      "/bi/setup/duplicates",
    );
    // One step at a time: a second open card would be a second instruction.
    expect(screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current"))).toHaveLength(1);
  });

  it("keeps every other task to one line, with its state and its page", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByText("1 of 6 answered");

    const expected: [string, string, string][] = [
      ["Units", "partly", "/bi/setup/units"],
      ["Buildings & devices", "partly", "/bi/setup/placement"],
      ["Equipment", "not started", "/bi/setup/equipment"],
      ["Metric roles", "done", "/bi/setup/roles"],
      ["Building facts", "partly", "/bi/setup/facts"],
    ];
    for (const [name, state, href] of expected) {
      const li = item(name);
      expect(li, name).not.toHaveAttribute("aria-current");
      expect(within(li).getByText(state), name).toBeInTheDocument();
      expect(within(li).getByRole("link", { name: "Open →" }), name).toHaveAttribute("href", href);
    }
    expect(screen.getByText("1 of 6 answered")).toBeInTheDocument();
  });

  it("shows a measured task as how far along it is, not only what is left", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByText("1 of 6 answered");
    const units = screen.getByRole("listitem", { name: "Units" });

    // 190 of 283 confirmed. A count of what is LEFT never says how big the job was.
    expect(within(units).getByRole("img", { name: "190 of 283" })).toBeInTheDocument();
    expect(within(units).getByText("190 / 283")).toBeInTheDocument();
  });

  it("says what a green tick on Equipment does not mean", async () => {
    // Every slot on every REGISTERED machine is bound — and no chiller is
    // registered, so the two metrics that need one have nothing to grade.
    stub.set({
      "GET /sites/s1/infrastructure": {
        site_id: "s1",
        systems: [{
          system_id: "sys1", site_id: "s1", name: "Plant A", kind: "chw_plant", description: null,
          equipment: [{
            equipment_id: "e1", site_id: "s1", system_id: "sys1", tag: "AHU-1", name: null,
            equipment_class: "ahu", design: {}, design_units: {},
            slots: [{ slot: "sat", device_tag: "d", point_tag: "p", bound: true }],
            created_at: "t", updated_at: "t",
          }],
        }],
      },
    });
    renderWithProviders(<SetupChecklist />);

    expect(await screen.findByText(/no chiller is registered yet/)).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Equipment" })).getByText("done")).toBeInTheDocument();
  });

  it("prints a read that failed as unknown, never as a zero", async () => {
    stub.set({ "GET /bi/units/patterns": () => httpError(502, "down") });
    renderWithProviders(<SetupChecklist />);

    const units = await screen.findByRole("listitem", { name: "Units" });
    expect(await within(units).findByText("unknown")).toBeInTheDocument();
    expect(within(units).getByText("—")).toBeInTheDocument();
  });

  it("stops the walk on a gate it cannot read rather than implying it is fine", async () => {
    // Duplicates answers "none left"; Units is the one that failed. The walk
    // must open Units and say so — not skip to gate 3.
    stub.set({
      "GET /bi/points/ghosts": { total: 0, auto: 0, manual: 0, groups: [], resurrected: [] },
      "GET /bi/units/patterns": () => httpError(502, "down"),
    });
    renderWithProviders(<SetupChecklist />);
    await waitFor(() =>
      expect(screen.getByRole("listitem", { name: "Units" })).toHaveAttribute("aria-current", "step"),
    );

    const units = screen.getByRole("listitem", { name: "Units" });
    expect(within(units).getByText("cannot be read")).toBeInTheDocument();
    expect(within(units).getByText(/has not answered/)).toBeInTheDocument();
    // Neither the gate behind it nor the one after it is open — a step that is
    // done is not an instruction, and one further on is not reachable yet.
    expect(screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current"))).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: "Duplicates" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("listitem", { name: "Buildings & devices" })).not.toHaveAttribute("aria-current");
  });

  it("opens no step at all once every gate is answered", async () => {
    stub.set({
      "GET /bi/points/ghosts": { total: 0, auto: 0, manual: 0, groups: [], resurrected: [] },
      "GET /bi/units/patterns": { totals: { points: 283, already_confirmed: 283 }, patterns: [] },
      "GET /bi/devices": () => ({ total: 0, items: [] }),
      "GET /sites/s1/infrastructure": {
        site_id: "s1",
        systems: [{
          system_id: "sys1", site_id: "s1", name: "Plant A", kind: "chw_plant", description: null,
          equipment: [{
            equipment_id: "e1", site_id: "s1", system_id: "sys1", tag: "CH-01", name: null,
            equipment_class: "chiller",
            design: { design_dt_min: 4.5, design_dt_max: 6 }, design_units: {},
            slots: [{ slot: "chws", device_tag: "d", point_tag: "p", bound: true }],
            created_at: "t", updated_at: "t",
          }],
        }],
      },
      "GET /sites/s1/tariff-slabs": { items: [{}], total: 1 },
      "GET /sites/s1/emission-factors": { items: [{}], total: 1 },
    });
    renderWithProviders(<SetupChecklist />);

    expect(await screen.findByText(/Every gate is answered/)).toBeInTheDocument();
    expect(screen.getByText("6 of 6 answered")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem").filter((li) => li.getAttribute("aria-current"))).toEqual([]);
  });
});

describe("what it may ask", () => {
  it("asks nothing without bi.read", async () => {
    perms.granted = new Set(["sites.read"]);
    renderWithProviders(<SetupChecklist />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    expect(stub.calls).toHaveLength(0);
  });

  it("asks nothing without the analytics module", async () => {
    perms.modules = new Set();
    renderWithProviders(<SetupChecklist />);

    expect(await screen.findByText(/Needs/)).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });

  it("does not read the site record without sites.read, and says so as —", async () => {
    perms.granted = new Set(["bi.read"]);
    renderWithProviders(<SetupChecklist />);

    const facts = await screen.findByRole("listitem", { name: "Building facts" });
    expect(await within(facts).findByText("area ✓ · tariff ✓ · emission factor —")).toBeInTheDocument();
    expect(stub.matching("GET /sites/s1/emission-factors")).toHaveLength(0);
    expect(stub.matching("GET /sites/s1/tariff-slabs")).toHaveLength(0);
  });

  it("offers no control that writes — every action is a link", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByRole("listitem", { name: "Duplicates" });
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
