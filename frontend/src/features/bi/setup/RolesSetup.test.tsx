/**
 * BI → Setup → what each reading means. The screen itself is the device walk
 * (roles/RoleAsksScreen.test.tsx); this file is its wiring: the estate's 494
 * readings are never listed, the stranded worklist is one press away, and the
 * gate is BI's.
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import RolesSetup from "./RolesSetup";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const perms = { granted: new Set<string>(), modules: new Set(["analytics"]) };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

let stub: ApiStub;

beforeEach(() => {
  perms.granted = new Set(["bi.read", "bi.manage"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/points/roles/asks": {
      lookback_hours: 48,
      roles_read: [{ role: "inlet_water_temp", label: "Entering water temperature", needed_by: ["chiller_delta_t"] }],
      devices: [
        {
          device_id: "d1", device_tag: "CH1", site_id: "s1", site_name: "Aeon Tower",
          asks: [
            {
              point_id: "p1", point_tag: "IWT", answered: false, role: "inlet_water_temp",
              role_label: "Entering water temperature", basis: "the tag is `IWT`",
              needed_by: ["chiller_delta_t"], value: 28.4, at: null, unit: "degC", reporting: true,
              same_role_answered: [], same_role_others: [],
            },
          ],
          answered: [],
        },
      ],
      totals: { points: 494, devices: 1, asks: 1, answered: 0 },
    },
    "GET /bi/points/roles/orphans": { orphans: [{ role: "a" }, { role: "b" }] },
  });
});

describe("Setup → what each reading means", () => {
  it("asks about the one reading something reads, not the 494 the estate stores", async () => {
    renderWithProviders(<RolesSetup />);

    expect(await screen.findByRole("heading", { name: "CH1" })).toBeInTheDocument();
    expect(screen.getByText("IWT")).toBeInTheDocument();
    expect(stub.matching("GET /bi/metrics/roles")).toHaveLength(0);
  });

  it("carries the stranded count on the link to the worklist that settles it", async () => {
    renderWithProviders(<RolesSetup />);
    const link = await screen.findByRole("link", { name: /2 answers point at a dead reading/ });
    expect(link).toHaveAttribute("href", "/bi/setup/stranded");
  });

  it("offers a viewer without bi.manage no control that stores a meaning", async () => {
    perms.granted = new Set(["bi.read"]);
    renderWithProviders(<RolesSetup />);

    expect(await screen.findByText("IWT")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
  });

  it("reads nothing without bi.read", async () => {
    perms.granted = new Set(["sites.read"]);
    renderWithProviders(<RolesSetup />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });

  it("reads nothing without the analytics module", async () => {
    perms.modules = new Set();
    renderWithProviders(<RolesSetup />);

    expect(await screen.findByText(/Needs/)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });
});
