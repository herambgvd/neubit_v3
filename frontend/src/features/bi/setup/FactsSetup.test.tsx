/**
 * BI → Setup → about the building. The record itself is facts/FactsRecord.tsx
 * (and its test); this file is the wiring: which building is read, the deep link
 * Ratings sends here, and the keys — `bi.read` + analytics to read the record,
 * core's `sites.update` to write a fact, because the facts live on the site.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import FactsSetup from "./FactsSetup";
import { buildingFactsHref } from "./routes";

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

const mirror = (id: string, name: string) => ({
  site_id: id, site_name: name, is_active: true, gross_floor_area_sqm: null, energy_tariff_per_kwh: null,
  tariff_currency: null, occupancy: null, facts_updated_at: null, mirrored_at: null, points: 0, kwh_points: 0,
});

const record = (id: string, name: string, area: number | null) => ({
  site_id: id,
  site_name: name,
  known: true,
  carried: { occupancy: null, tariff_currency: null },
  on_file: area == null
    ? []
    : [{
        key: "area", label: "Floor area", value: area, unit: "m²", source: null,
        recorded_at: "2026-08-31T19:26:00Z", reads: ["intensity_score"],
        why: "Every per-square-metre figure divides by it.",
      }],
  missing: area == null
    ? [{
        key: "area", label: "Floor area", value: null, unit: "m²", source: null, recorded_at: null,
        reads: ["intensity_score"], why: "Every per-square-metre figure divides by it.",
      }]
    : [],
  totals: { on_file: area == null ? 0 : 1, missing: area == null ? 1 : 0 },
});

let stub: ApiStub;

beforeEach(() => {
  nav.params = new URLSearchParams();
  perms.granted = new Set(["bi.read", "sites.read", "sites.update"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/rating/sites": { items: [mirror("s1", "Aeon Tower"), mirror("s2", "Nashik Depot")] },
    "GET /bi/sites/s1/facts": record("s1", "Aeon Tower", 40000),
    "GET /bi/sites/s2/facts": record("s2", "Nashik Depot", null),
    "GET /sites/s1": { site_id: "s1", site_name: "Aeon Tower", is_active: true },
    "GET /sites/s2": { site_id: "s2", site_name: "Nashik Depot", is_active: true },
    "GET /sites/*": { items: [], total: 0 },
    "PUT /sites/s2/building-facts": { site_id: "s2" },
  });
});

describe("picking a building", () => {
  it("opens the first building's record, and another one when it is picked", async () => {
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByText("40,000 m²")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Nashik Depot/ }));

    expect(await screen.findByRole("heading", { name: "Nashik Depot" })).toBeInTheDocument();
    expect(screen.getByText(/the building's energy per square metre stays off/)).toBeInTheDocument();
  });

  it("opens the building the deep link names", async () => {
    // Ratings sends an operator here when it has no area to divide by.
    nav.params = new URLSearchParams(buildingFactsHref("s2").split("?")[1]);
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByRole("heading", { name: "Nashik Depot" })).toBeInTheDocument();
    await waitFor(() => expect(stub.matching("GET /bi/sites/s1/facts")).toHaveLength(0));
  });
});

describe("recording a fact", () => {
  it("writes it to the building that was picked", async () => {
    nav.params = new URLSearchParams(buildingFactsHref("s2").split("?")[1]);
    renderWithProviders(<FactsSetup />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Record it" }));
    await user.type(screen.getByLabelText("Floor area"), "18500");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s2/building-facts")).toMatchObject({ gross_floor_area_sqm: 18500 }),
    );
  });
});

describe("the gate", () => {
  it("offers no control that writes without core's sites.update", async () => {
    perms.granted = new Set(["bi.read", "sites.read"]);
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByText("40,000 m²")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });

  it("reads nothing without bi.read", async () => {
    perms.granted = new Set(["sites.read", "sites.update"]);
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });

  it("reads nothing without the analytics module", async () => {
    perms.modules = new Set();
    renderWithProviders(<FactsSetup />);

    expect(await screen.findByText(/Needs/)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });
});
