/**
 * BI → Setup → Equipment: pick a building, describe its plant. It used to be a
 * tab on Configurations → Sites → a site; it now picks the building itself,
 * from BI's own copy of the sites list, and honours the deep link BI builds
 * with `infraDesignerHref`.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import EquipmentSetup from "./EquipmentSetup";
import { infraDesignerHref } from "./routes";

const nav = { params: new URLSearchParams() };
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));

const perms = { granted: new Set<string>(), modules: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

const T = "2026-09-01T00:00:00Z";
const site = (id: string, name: string) => ({
  site_id: id, site_name: name, is_active: true, gross_floor_area_sqm: null, energy_tariff_per_kwh: null,
  tariff_currency: null, occupancy: null, facts_updated_at: null, mirrored_at: null, points: 0, kwh_points: 0,
});
const tree = (siteId: string, tag: string, equipmentId: string) => ({
  site_id: siteId,
  systems: [
    {
      system_id: `sys-${siteId}`, site_id: siteId, name: `Plant ${siteId}`, kind: "chw_plant", description: null,
      created_at: T, updated_at: T,
      equipment: [
        {
          equipment_id: equipmentId, site_id: siteId, system_id: `sys-${siteId}`, tag, name: null,
          equipment_class: "chiller", design: {}, design_units: {}, slots: [], created_at: T, updated_at: T,
        },
      ],
    },
  ],
});

let stub: ApiStub;

beforeEach(() => {
  nav.params = new URLSearchParams();
  perms.granted = new Set(["bi.read", "bi.manage"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/rating/sites": { items: [site("s1", "Aeon Tower"), site("s2", "Nashik Depot")] },
    "GET /site-infrastructure/vocabulary": { system_kinds: [], equipment_classes: [], slots: [], design_facts: [] },
    "GET /sites/s1/infrastructure": tree("s1", "CH-01", "e1"),
    "GET /sites/s2/infrastructure": tree("s2", "CH-09", "e9"),
  });
});

describe("picking a building", () => {
  it("opens the first building, and another one when it is picked", async () => {
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByRole("heading", { name: "Aeon Tower" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^CH-01/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Nashik Depot/ }));

    expect(await screen.findByRole("button", { name: /^CH-09/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nashik Depot" })).toBeInTheDocument();
  });
});

describe("the deep link", () => {
  it("opens the named building on the named equipment", async () => {
    // Building Intelligence sends an operator here when a chiller has no design
    // band on file. Landing on the FIRST building would lose the errand.
    nav.params = new URLSearchParams(infraDesignerHref("s2", "e9").split("?")[1]);

    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByRole("heading", { name: "CH-09" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nashik Depot" })).toBeInTheDocument();
    expect(stub.matching("GET /sites/s1/infrastructure")).toHaveLength(0);
  });
});

describe("the gate", () => {
  it("is BI's: sites.read + sites.update without bi.read reads nothing", async () => {
    perms.granted = new Set(["sites.read", "sites.update"]);
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });

  it("shows a viewer without bi.manage the plant, and no control that writes", async () => {
    perms.granted = new Set(["bi.read"]);
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByRole("button", { name: /^CH-01/ })).toBeInTheDocument();
    for (const name of ["New system", "Import I/O schedule"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
