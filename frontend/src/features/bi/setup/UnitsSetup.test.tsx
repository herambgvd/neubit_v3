/**
 * BI → Setup → Units: the units worklist that used to be Ratings' UNITS tab.
 * A viewer without `bi.manage` sees what is and is not confirmed, and no
 * control that would record a unit.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import UnitsSetup from "./UnitsSetup";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const perms = { granted: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => perms.granted.has(p), hasModule: () => true }),
}));

beforeEach(() => {
  perms.granted = new Set(["bi.read", "bi.manage"]);
  stubApi({
    "GET /bi/units": {
      counts: { points: 1, confirmed: 0, unconfirmed: 1 },
      items: [
        {
          point_id: "p1", device_tag: "1F-DB", point_tag: "KWH", type: "num", unit: null,
          suggestion: { unit: "kWh", basis: "the tag ends in `kwh`" },
        },
      ],
    },
    "GET /bi/units/patterns": { totals: { points: 1, matched: 1, unmatched: 0, eligible: 1, already_confirmed: 0 }, patterns: [] },
  });
});

describe("Setup → Units", () => {
  it("offers a manager the bulk path over the rows it would change", async () => {
    renderWithProviders(<UnitsSetup />);
    expect(await screen.findByRole("button", { name: /Select 1 where/ })).toBeInTheDocument();
  });

  it("offers a viewer without bi.manage no control that records a unit", async () => {
    perms.granted = new Set(["bi.read"]);
    renderWithProviders(<UnitsSetup />);

    expect(await screen.findByText("KWH")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select 1 where/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm as/ })).not.toBeInTheDocument();
  });

  it("wears the Setup crumb and its gate", async () => {
    renderWithProviders(<UnitsSetup />);
    expect(screen.getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/bi/setup");
    expect(screen.getByText("gate 2")).toBeInTheDocument();
  });
});
