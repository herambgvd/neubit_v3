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
      "Buildings & devices",
      "Equipment",
      "Metric roles",
      "Building facts",
    ]);
  });

  it("opens the FIRST task that is not done, and only that one", async () => {
    renderWithProviders(<SetupChecklist />);
    const first = await screen.findByRole("listitem", { name: "Buildings & devices" });

    expect(first).toHaveAttribute("aria-current", "step");
    expect(within(first).getByText("which building is this device in?", { exact: false })).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: /Place the devices/ })).toHaveAttribute(
      "href",
      "/bi/setup/placement",
    );
    // One step at a time: a second open card would be a second instruction.
    expect(screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current"))).toHaveLength(1);
  });

  it("keeps every other task to one line, with its state and its page", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByText("1 of 4 answered");

    const expected: [string, string, string][] = [
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
    expect(screen.getByText("1 of 4 answered")).toBeInTheDocument();
  });

  it("shows a measured task as how far along it is, not only what is left", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByText("1 of 4 answered");
    const place = screen.getByRole("listitem", { name: "Buildings & devices" });

    // 12 of 52 placed. A count of what is LEFT never says how big the job was.
    expect(within(place).getByRole("img", { name: "12 of 52" })).toBeInTheDocument();
    expect(within(place).getByText("12 / 52")).toBeInTheDocument();
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
    // A quiet row, not the open one: the open step spells its own state out
    // ("cannot be read"), and what is under test here is the one-line form.
    stub.set({ "GET /bi/metrics/roles": () => httpError(502, "down") });
    renderWithProviders(<SetupChecklist />);

    const roles = await screen.findByRole("listitem", { name: "Metric roles" });
    expect(await within(roles).findByText("unknown")).toBeInTheDocument();
    // The figure it could not read prints as a dash, never as 0 bound.
    expect(within(roles).getByText(/— bound/)).toBeInTheDocument();
  });

  it("stops the walk on a gate it cannot read rather than implying it is fine", async () => {
    // Buildings & devices is the one that failed. The walk must open it and
    // say so — not skip past to Equipment.
    stub.set({ "GET /bi/devices": () => httpError(502, "down") });
    renderWithProviders(<SetupChecklist />);
    await waitFor(() =>
      expect(screen.getByRole("listitem", { name: "Buildings & devices" })).toHaveAttribute("aria-current", "step"),
    );

    const place = screen.getByRole("listitem", { name: "Buildings & devices" });
    expect(within(place).getByText("cannot be read")).toBeInTheDocument();
    expect(within(place).getByText(/has not answered/)).toBeInTheDocument();
    // The gate after it is not open — one further on is not reachable yet.
    expect(screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current"))).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: "Equipment" })).not.toHaveAttribute("aria-current");
  });

  it("opens no step at all once every gate is answered", async () => {
    stub.set({
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
    expect(screen.getByText("4 of 4 answered")).toBeInTheDocument();
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
    await screen.findByRole("listitem", { name: "Buildings & devices" });
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
