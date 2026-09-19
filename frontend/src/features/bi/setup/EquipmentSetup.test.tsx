/**
 * BI → Setup → Equipment: pick a building, and its plant is drawn with every
 * machine the platform recognised already on it (PlantCanvas has what the
 * drawing may send). This file is the SCREEN around it: which building is read,
 * and the deep links BI builds — `infraDesignerHref` and `infraImportHref`.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import EquipmentSetup from "./EquipmentSetup";
import { infraDesignerHref, infraImportHref } from "./routes";

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
const plantEquipment = (id: string, tag: string) => ({
  equipment_id: id, tag, name: null, equipment_class: "chiller", system_id: `sys-${id}`, fed_by_id: null,
  design: {}, design_units: {}, readiness: "reporting", readiness_counts: {}, metrics: {},
  slots: [{ slot: "chwr", binding: { device_tag: tag, point_tag: "IWT" }, latest: { t: T, value: 12, text: null } }],
});
const plant = (siteId: string, id: string, tag: string) => ({
  site_id: siteId, systems: [{ equipment: [plantEquipment(id, tag)] }], unassigned_equipment: [],
});
const tree = (siteId: string, tag: string, equipmentId: string) => ({
  site_id: siteId,
  systems: [
    {
      system_id: `sys-${equipmentId}`, site_id: siteId, name: `Plant ${siteId}`, kind: "chw_plant",
      description: null, created_at: T, updated_at: T,
      equipment: [
        {
          equipment_id: equipmentId, site_id: siteId, system_id: `sys-${equipmentId}`, tag, name: null,
          equipment_class: "chiller", design: {}, design_units: {}, slots: [], created_at: T, updated_at: T,
        },
      ],
    },
  ],
});
const NOTHING = { devices: [], totals: { devices: 0, machines: 0, unknown: 0, fragments: 0, registered: 0 } };

const VOCAB = {
  system_kinds: [{ key: "chw_plant", label: "Chilled-water plant", description: "" }],
  equipment_classes: [{ key: "chiller", label: "Chiller", system_kinds: ["chw_plant"], slots: ["chwr"], facts: [] }],
  slots: [{ key: "chwr", dimension: "temperature", label: "CHW return", role: "inlet_water_temp" }],
  design_facts: [],
};

let stub: ApiStub;

beforeEach(() => {
  nav.params = new URLSearchParams();
  perms.granted = new Set(["bi.read", "bi.manage"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/rating/sites": { items: [site("s1", "Aeon Tower"), site("s2", "Nashik Depot")] },
    "GET /site-infrastructure/vocabulary": VOCAB,
    "GET /sites/s1/infrastructure": tree("s1", "CH-01", "e1"),
    "GET /sites/s2/infrastructure": tree("s2", "CH-09", "e9"),
    "GET /bi/sites/s1/plant": plant("s1", "e1", "CH-01"),
    "GET /bi/sites/s2/plant": plant("s2", "e9", "CH-09"),
    "GET /bi/sites/s1/equipment/suggestions": NOTHING,
    "GET /bi/sites/s2/equipment/suggestions": NOTHING,
  });
});

describe("picking a building", () => {
  it("opens the first building, and another one when it is picked", async () => {
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByRole("button", { name: "CH-01" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Nashik Depot/ }));

    expect(await screen.findByRole("button", { name: "CH-09" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "CH-01" })).not.toBeInTheDocument();
  });
});

describe("the deep link", () => {
  it("opens the named building on the named equipment", async () => {
    // Building Intelligence sends an operator here when a chiller has no design
    // band on file. Landing on the FIRST building would lose the errand.
    nav.params = new URLSearchParams(infraDesignerHref("s2", "e9").split("?")[1]);

    renderWithProviders(<EquipmentSetup />);

    // The equipment's own box is open, not merely drawn.
    expect(await screen.findByRole("dialog", { name: "CH-09" })).toBeInTheDocument();
    await waitFor(() => expect(stub.matching("GET /bi/sites/s1/plant")).toHaveLength(0));
  });
});

describe("the import link", () => {
  it("opens the I/O schedule import on the named building", async () => {
    // L3 Plant's "Import I/O schedule" lands here.
    nav.params = new URLSearchParams(infraImportHref("s2").split("?")[1]);
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByLabelText(/Schedule file/)).toBeInTheDocument();
    expect(stub.matching("GET /sites/s1/infrastructure")).toHaveLength(0);
  });

  it("opens nothing that writes for a caller without bi.manage", async () => {
    perms.granted = new Set(["bi.read"]);
    nav.params = new URLSearchParams(infraImportHref("s2").split("?")[1]);
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByRole("button", { name: "CH-09" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Schedule file/)).not.toBeInTheDocument();
  });

  it("does not open the import on a link that did not ask for it", async () => {
    // The equipment deep link names the same building and is not an import.
    nav.params = new URLSearchParams(infraDesignerHref("s2", "e9").split("?")[1]);
    renderWithProviders(<EquipmentSetup />);

    expect(await screen.findByRole("button", { name: "CH-09" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Schedule file/)).not.toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "CH-01" })).toBeInTheDocument();
    for (const name of ["Import I/O schedule", "Restate this building's plant to analytics"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
