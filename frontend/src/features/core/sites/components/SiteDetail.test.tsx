/**
 * The Building tab is a BUILDING-INTELLIGENCE surface living on a site screen.
 *
 * Area, tariff, occupancy and emission factors exist to feed BI — nothing in
 * Sites, Floors, Zones or the VMS reads them — so a tenant without that module
 * was being asked to fill in a form whose only consumer they do not have. It is
 * gated on the same pair every BI surface uses (config/launcher.ts): the
 * `analytics` module plus `bi.read`.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SitePublic } from "@/lib/types";

import SiteDetail from "./SiteDetail";

const entitlement = { module: true, perm: true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "me" },
    can: () => entitlement.perm,
    hasModule: () => entitlement.module,
  }),
}));

// The tab bodies each fetch; this test is about which TABS exist.
vi.mock("./SiteInfoPanel", () => ({ default: () => <div>site info body</div> }));
vi.mock("./BuildingFactsPanel", () => ({ default: () => <div>building facts body</div> }));
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

function renderDetail(tab: "info" | "building" | "floors" | "zones" = "info") {
  return render(
    <SiteDetail
      site={SITE}
      tab={tab}
      onTabChange={() => {}}
      onClose={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onChangeThreat={() => {}}
    />,
  );
}

beforeEach(() => {
  entitlement.module = true;
  entitlement.perm = true;
});

describe("the Building tab", () => {
  it("is there for a tenant with Building Intelligence", () => {
    renderDetail();
    expect(screen.getByRole("tab", { name: "Building" })).toBeInTheDocument();
  });

  it("is gone without the analytics module", () => {
    entitlement.module = false;
    renderDetail();

    expect(screen.queryByRole("tab", { name: "Building" })).not.toBeInTheDocument();
    // The rest of the site screen is untouched.
    expect(screen.getByRole("tab", { name: "Floors" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Zones" })).toBeInTheDocument();
  });

  it("is gone without bi.read, module or not", () => {
    entitlement.perm = false;
    renderDetail();
    expect(screen.queryByRole("tab", { name: "Building" })).not.toBeInTheDocument();
  });

  it("falls back to Site info when the tab is selected but no longer allowed", () => {
    // A remembered tab, or an entitlement that arrives late: the body must not
    // render for a tab that is not in the bar.
    entitlement.module = false;
    renderDetail("building");

    expect(screen.getByText("site info body")).toBeInTheDocument();
    expect(screen.queryByText("building facts body")).not.toBeInTheDocument();
  });

  it("still shows the body when it IS allowed", () => {
    renderDetail("building");
    expect(screen.getByText("building facts body")).toBeInTheDocument();
  });
});
