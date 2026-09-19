/**
 * BI → Setup → Metric roles. Its worklist — roles stranded on a point that
 * stopped reporting — is one press away, and the press carries the count.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import RolesSetup from "./RolesSetup";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const perms = { granted: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => perms.granted.has(p), hasModule: () => true }),
}));

beforeEach(() => {
  perms.granted = new Set(["bi.read", "bi.manage"]);
  stubApi({
    "GET /bi/metrics/roles": {
      counts: { points: 1, confirmed: 0, unconfirmed: 1 },
      items: [
        {
          point_id: "p1", device_tag: "CH1", point_tag: "IWT", type: "num", role: null,
          suggestion: { role: "inlet_water_temp", basis: "the tag is `IWT`" },
        },
      ],
      vocabulary: [],
    },
    "GET /bi/intake": { items: [], total: 0, counts: {} },
    "GET /bi/points/roles/orphans": { orphans: [{ role: "a" }, { role: "b" }] },
  });
});

describe("Setup → Metric roles", () => {
  it("carries the stranded count on the link to the worklist that settles it", async () => {
    renderWithProviders(<RolesSetup />);
    const link = await screen.findByRole("link", { name: /2 stranded/ });
    expect(link).toHaveAttribute("href", "/bi/setup/stranded");
  });

  it("offers a viewer without bi.manage no control that binds a role", async () => {
    perms.granted = new Set(["bi.read"]);
    renderWithProviders(<RolesSetup />);

    expect(await screen.findByText("IWT")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select 1 where/ })).not.toBeInTheDocument();
  });

  it("offers a manager the bulk path", async () => {
    renderWithProviders(<RolesSetup />);
    expect(await screen.findByRole("button", { name: /Select 1 where/ })).toBeInTheDocument();
  });
});
