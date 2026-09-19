/**
 * BI → Setup opens on a checklist: one row per task, in gate order, each with
 * its state, its one-line count and "Open →" to the page that changes it.
 */
import { screen, within } from "@testing-library/react";
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

  it("gives each row its state, its count and the page that changes it", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByText("190 confirmed · 93 unconfirmed");

    const expected: [string, string, string, string][] = [
      ["Duplicates", "to do", "2 no choice needed · 1 need your choice", "/bi/setup/duplicates"],
      ["Units", "partly", "190 confirmed · 93 unconfirmed", "/bi/setup/units"],
      ["Buildings & devices", "partly", "12 placed · 40 unplaced devices", "/bi/setup/placement"],
      ["Equipment", "not started", "0 chillers · 0 equipment", "/bi/setup/equipment"],
      ["Metric roles", "done", "20 bound · 0 stranded", "/bi/setup/roles"],
      ["Building facts", "partly", "area ✓ · tariff ✓ · emission factor ✗", "/bi/setup/facts"],
    ];
    for (const [name, state, count, href] of expected) {
      const li = item(name);
      expect(within(li).getByText(count), name).toBeInTheDocument();
      expect(within(li).getByText(state), name).toBeInTheDocument();
      expect(within(li).getByRole("link", { name: "Open →" }), name).toHaveAttribute("href", href);
    }
    expect(screen.getByText("1 of 6 done")).toBeInTheDocument();
  });

  it("prints a read that failed as unknown, never as a zero", async () => {
    stub.set({ "GET /bi/units/patterns": () => httpError(502, "down") });
    renderWithProviders(<SetupChecklist />);

    const units = await screen.findByRole("listitem", { name: "Units" });
    expect(await within(units).findByText("unknown")).toBeInTheDocument();
    expect(within(units).getByText("—")).toBeInTheDocument();
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

  it("offers no control that writes — every row's action is a link", async () => {
    renderWithProviders(<SetupChecklist />);
    await screen.findByText("190 confirmed · 93 unconfirmed");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
