/**
 * RATINGS DISPLAYS WHAT IT DIVIDES BY; SETUP RECORDS IT.
 *
 * Every piece of Building Intelligence configuration lives in BI → Setup. The
 * area, tariff and occupancy the EPI needs used to be a BUILDING tab here, and
 * the units a UNITS tab; both forms moved to Setup. What has to hold here:
 *
 *   • the inputs are still SHOWN beside the rating — a missing one as "not
 *     recorded", never 0 — with the door to Setup → Building facts;
 *   • nothing on this screen edits them, and the site record the form needed
 *     is never fetched;
 *   • "cannot rate" leads to the Setup page that fixes it, for THAT building.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import Ratings from "./Ratings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

const SITE = {
  site_id: "s1",
  site_name: "Aeon Tower",
  gross_floor_area_sqm: null,
  energy_tariff_per_kwh: 8.5,
  tariff_currency: "INR",
  occupancy: null,
  points: 12,
  kwh_points: 3,
};

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /bi/rating/sites": { items: [SITE] },
    "GET /bi/units": { items: [] },
    "GET /bi/rating": {
      blocked: ["no gross floor area recorded"],
      meters: [],
      benchmark: { available: false, reason: "no standard loaded" },
    },
    "GET /sites/s1": { site_id: "s1", name: "Aeon Tower" },
  });
});

describe("the inputs a rating divides by", () => {
  it("are displayed — a recorded one as itself, a missing one as not recorded", async () => {
    renderWithProviders(<Ratings />);

    expect(await screen.findByText("8.5 INR/kWh")).toBeInTheDocument();
    const area = screen.getByText("Gross floor area").parentElement!;
    expect(area).toHaveTextContent("not recorded");
    expect(area).not.toHaveTextContent(/\b0\b/);
  });

  it("link to Setup → Building facts for this building", async () => {
    renderWithProviders(<Ratings />);

    expect(await screen.findByRole("link", { name: /Building facts/ })).toHaveAttribute(
      "href",
      "/bi/setup/facts?site=s1",
    );
  });

  it("are not edited here: no form, no tab, and the site record is never read", async () => {
    renderWithProviders(<Ratings />);
    await screen.findByText("8.5 INR/kWh");

    expect(screen.queryByRole("button", { name: "BUILDING" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "UNITS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save building facts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(stub.matching("GET /sites/s1")).toHaveLength(0);
  });
});

describe("a site that cannot be rated", () => {
  it("is sent to the Setup page that records the area", async () => {
    renderWithProviders(<Ratings />);

    const fix = await screen.findByRole("link", { name: /record the area/i });
    expect(fix).toHaveAttribute("href", "/bi/setup/facts?site=s1");
  });

  it("with no confirmed kWh register is sent to Setup → Units", async () => {
    renderWithProviders(<Ratings />);

    expect(await screen.findByRole("link", { name: /confirm units in setup/i })).toHaveAttribute(
      "href",
      "/bi/setup/units",
    );
  });
});
