/**
 * The EPI's inputs are recorded WHERE THEY ARE USED.
 *
 * Gross floor area, tariff and occupancy used to be a "Building" tab on
 * Configurations → Sites: a form beside the address, in a console that reads
 * none of those numbers, while this screen — their only reader — showed them
 * read-only and linked back there. An operator who came here because a site said
 * "cannot rate" was sent two consoles away to fix it.
 *
 * So the form is on this screen now, and these are the two things that have to
 * hold: the tab exists and edits the SITE RECORD (not the rating projection,
 * which does not carry the tariff slabs or the emission factors and cannot be
 * written back), and the "cannot rate" message leads to it rather than to Sites.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import Ratings from "./Ratings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

// The units surface and the fact form each fetch on their own; this test is
// about WHICH surface is reachable from here, not what they render.
vi.mock("./components/UnitsPanel", () => ({ default: () => <div>units body</div> }));
vi.mock("./components/building/BuildingFactsPanel", () => ({
  default: ({ site }: { site: { site_id: string } }) => (
    <div>building form for {site.site_id}</div>
  ),
}));

const SITE = {
  site_id: "s1",
  site_name: "Aeon Tower",
  gross_floor_area_sqm: null,
  energy_tariff_per_kwh: null,
  occupancy: null,
  points: 12,
  kwh_points: 3,
};

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /bi/rating/sites": { items: [SITE] },
    "GET /bi/units": { items: [] },
    // `meters` is always present on the wire — the response carries each meter's
    // own subtraction so the total can be checked by hand.
    "GET /bi/rating": {
      blocked: ["no gross floor area recorded"],
      meters: [],
      benchmark: { available: false, reason: "no standard loaded" },
    },
    "GET /sites/s1": { site_id: "s1", name: "Aeon Tower" },
  });
});

describe("recording what a rating needs", () => {
  it("offers the BUILDING tab beside UNITS", async () => {
    renderWithProviders(<Ratings />);

    expect(await screen.findByRole("button", { name: "BUILDING" })).toBeInTheDocument();
    // "UNITS" also names a column header button in the rating body; the tab is
    // the one in the header's Segmented.
    expect(screen.getAllByRole("button", { name: "UNITS" })).not.toHaveLength(0);
  });

  it("edits the site RECORD, not the rating projection", async () => {
    // The rating list is a read-model: no tariff slabs, no emission factors, and
    // nothing to write back to. The form needs the row it is editing.
    renderWithProviders(<Ratings />);
    await userEvent.click(await screen.findByRole("button", { name: "BUILDING" }));

    await waitFor(() => expect(stub.matching("GET /sites/s1")).toHaveLength(1));
    expect(await screen.findByText("building form for s1")).toBeInTheDocument();
  });

  it("does not fetch that record until the tab is opened", async () => {
    renderWithProviders(<Ratings />);
    await screen.findByRole("button", { name: "BUILDING" });

    expect(stub.matching("GET /sites/s1")).toHaveLength(0);
  });

  it("sends an unratable site to the form instead of to another console", async () => {
    renderWithProviders(<Ratings />);

    const fix = await screen.findByRole("button", { name: /record the area/i });
    // Not a link: a link would leave Building Intelligence, which is what this
    // change exists to stop.
    expect(fix.tagName).toBe("BUTTON");
    await userEvent.click(fix);

    expect(await screen.findByText("building form for s1")).toBeInTheDocument();
  });
});
