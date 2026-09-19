/**
 * BI → Setup → Building facts is where area, tariff, occupancy and emission
 * factors are RECORDED (Ratings only displays them). The facts are stored on
 * the site, so the keys are the endpoints': `sites.read` to read the record,
 * `sites.update` to write it.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import FactsSetup from "./FactsSetup";

const nav = { params: new URLSearchParams() };
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const perms = { granted: new Set<string>(), modules: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

const mirror = (id: string, name: string, area: number | null) => ({
  site_id: id, site_name: name, is_active: true, gross_floor_area_sqm: area, energy_tariff_per_kwh: null,
  tariff_currency: null, occupancy: null, facts_updated_at: null, mirrored_at: null, points: 0, kwh_points: 0,
});
const record = (id: string, name: string) => ({
  site_id: id, name, gross_floor_area_sqm: null, energy_tariff_per_kwh: null, tariff_currency: null,
  occupancy: null, building_facts_updated_at: null,
});

let stub: ApiStub;

beforeEach(() => {
  nav.params = new URLSearchParams();
  perms.granted = new Set(["bi.read", "sites.read", "sites.update"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/rating/sites": { items: [mirror("s1", "Aeon Tower", 18500), mirror("s2", "Nashik Depot", null)] },
    "GET /sites/s1": record("s1", "Aeon Tower"),
    "GET /sites/s2": record("s2", "Nashik Depot"),
    "GET /sites/s1/tariff-slabs": { items: [], total: 0 },
    "GET /sites/s2/tariff-slabs": { items: [], total: 0 },
    "GET /sites/s1/emission-factors": { items: [], total: 0 },
    "GET /sites/s2/emission-factors": { items: [], total: 0 },
    "PUT /sites/*": record("s2", "Nashik Depot"),
  });
});

describe("recording a building's facts", () => {
  it("writes the area to the building that was picked", async () => {
    nav.params = new URLSearchParams("site=s2");
    renderWithProviders(<FactsSetup />);

    const area = await screen.findByPlaceholderText("e.g. 18500");
    await userEvent.type(area, "9200");
    await userEvent.click(screen.getByRole("button", { name: "Save building facts" }));

    await waitFor(() => expect(stub.matching("PUT /sites/s2/building-facts")).toHaveLength(1));
    expect(stub.body("PUT /sites/s2/building-facts")).toMatchObject({ gross_floor_area_sqm: 9200 });
  });

  it("marks each building's area on the list, missing as ✗", async () => {
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByRole("button", { name: /Aeon Tower.*area ✓/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nashik Depot.*area ✗/ })).toBeInTheDocument();
  });
});

describe("a viewer", () => {
  it("without sites.update — or bi.manage — is offered no control that writes", async () => {
    perms.granted = new Set(["bi.read", "sites.read"]);
    renderWithProviders(<FactsSetup />);

    await screen.findByPlaceholderText("e.g. 18500");
    expect(await screen.findAllByText(/read-only/)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add/i })).not.toBeInTheDocument();
  });

  it("without sites.read sees what BI's mirror holds, read-only, and the record is never read", async () => {
    perms.granted = new Set(["bi.read"]);
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByText("18,500 m²")).toBeInTheDocument();
    expect(screen.getByText(/the full record needs/)).toBeInTheDocument();
    expect(stub.matching("GET /sites/s1")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("without bi.read reads nothing at all", async () => {
    perms.granted = new Set(["sites.read", "sites.update"]);
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    expect(stub.calls).toHaveLength(0);
  });
});
