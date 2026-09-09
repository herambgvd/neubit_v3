/**
 * Sites is about the SITE: its address, its floors, its zones.
 *
 * It used to carry a "Building" tab as well — gross floor area, tariff,
 * occupancy, emission factors. Every one of those is a Building Intelligence
 * input (the EPI's denominator, the price of a kWh) and nothing in Sites, Floors,
 * Zones or the VMS reads one. An operator recording an address was being asked
 * for a tariff whose only consumer is a screen in another console, while THAT
 * console showed the same numbers read-only with a link back here. Two surfaces
 * for one fact.
 *
 * So the form moved to Building Intelligence → Ratings → BUILDING, and this
 * guards the half of that move that lives here: Sites offers the tab no more,
 * and a remembered `?tab=building` renders Site info rather than a blank pane.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SitePublic } from "@/lib/types";

import SiteDetail from "./SiteDetail";

// The tab bodies each fetch; this test is about which TABS exist.
vi.mock("./SiteInfoPanel", () => ({ default: () => <div>site info body</div> }));
vi.mock("./FloorsPanel", () => ({ default: () => <div>floors body</div> }));
vi.mock("./ZonesPanel", () => ({ default: () => <div>zones body</div> }));

const SITE = {
  site_id: "s1",
  name: "Aeon Tower",
  location_code: "AEON",
  site_type: "building",
  threat_level: "normal",
  is_active: true,
} as unknown as SitePublic;

function renderDetail(tab = "info") {
  return render(
    <SiteDetail
      site={SITE}
      // The cast is the point of the last test: a stored tab string can name a
      // tab this pane no longer has.
      tab={tab as never}
      onTabChange={() => {}}
      onClose={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onChangeThreat={() => {}}
    />,
  );
}

describe("the tabs a site has", () => {
  it("are the site's own: info, floors, zones", () => {
    renderDetail();

    expect(screen.getByRole("tab", { name: "Site info" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Floors" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Zones" })).toBeInTheDocument();
  });

  it("no longer include Building — those facts are recorded in Building Intelligence", () => {
    renderDetail();
    expect(screen.queryByRole("tab", { name: "Building" })).not.toBeInTheDocument();
  });

  it("fall back to Site info when a remembered tab no longer exists", () => {
    // A bookmark or a restored view can still say "building". Rendering nothing
    // would read as a site whose detail failed to load.
    renderDetail("building");
    expect(screen.getByText("site info body")).toBeInTheDocument();
  });
});
