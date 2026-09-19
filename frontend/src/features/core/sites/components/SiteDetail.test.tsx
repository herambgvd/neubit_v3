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
 * So the form moved to Building Intelligence → Setup → Building facts, and the
 * equipment designer followed it to Setup → Equipment. This guards the half of
 * those moves that lives here: Sites offers neither tab, and a remembered tab
 * renders Site info rather than a blank pane.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SitePublic } from "@/lib/types";

import SiteDetail from "./SiteDetail";

// Every write in this header is gated on core's own key for it, so the pane
// needs a caller. `perms` is what each test says that caller may do.
const perms = { can: (_p: string) => true };
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => perms.can(p) }) }));

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

function renderDetail(tab = "info", site = SITE) {
  return render(
    <SiteDetail
      site={site}
      // The cast is the point of the last test: a stored tab string can name a
      // tab this pane no longer has.
      tab={tab as never}
      onTabChange={() => {}}
      onClose={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onRestore={() => {}}
      onChangeThreat={() => {}}
    />,
  );
}

describe("a deactivated site", () => {
  it("offers Restore instead of a second Delete", () => {
    // `DELETE /sites/{id}` sets is_active=false and cascades it to the floors and
    // zones; nothing is destroyed and `restore` puts it all back. Offering Delete
    // on an already-deactivated site says otherwise.
    renderDetail("info", { ...SITE, is_active: false } as never);

    expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deactivate site/i })).not.toBeInTheDocument();
  });

  it("offers Deactivate while it is active", () => {
    renderDetail();

    expect(screen.getByRole("button", { name: /deactivate site/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();
  });
});

describe("the tabs a site has", () => {
  it("are the site's own: info, floors, zones — and nothing else", () => {
    renderDetail();

    expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual([
      "Site info",
      "Floors",
      "Zones",
    ]);
  });

  it("no longer include Equipment — the plant designer is BI → Setup", () => {
    // A VMS-only customer configuring a site must never meet a chiller.
    renderDetail();
    expect(screen.queryByRole("tab", { name: "Equipment" })).not.toBeInTheDocument();
  });

  it("no longer include Building — those facts are recorded in Building Intelligence", () => {
    renderDetail();
    expect(screen.queryByRole("tab", { name: "Building" })).not.toBeInTheDocument();
  });

  it("fall back to Site info when a remembered tab no longer exists", () => {
    // A bookmark or a restored view can still say "building" or "equipment".
    // Rendering nothing would read as a site whose detail failed to load.
    renderDetail("building");
    expect(screen.getByText("site info body")).toBeInTheDocument();
  });

  it("fall back to Site info for a remembered Equipment tab too", () => {
    renderDetail("equipment");
    expect(screen.getByText("site info body")).toBeInTheDocument();
  });
});


describe("a caller who may not change this building", () => {
  // None of this is a security boundary — core refuses each write on its own key
  // whatever the header shows. It is a promise the product cannot keep: a press
  // that can only ever end in a 403.
  it("is offered no edit, no deactivate and no threat picker", () => {
    perms.can = () => false;
    renderDetail();

    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Deactivate site")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Set threat level")).not.toBeInTheDocument();
    // The level is still STATED. Hiding the fact along with the control would
    // tell a reader less than the screen knows.
    expect(screen.getByText("Normal")).toBeInTheDocument();
    perms.can = () => true;
  });

  it("is offered no Restore on a deactivated one either", () => {
    perms.can = (p: string) => p !== "sites.update";
    renderDetail("info", { ...SITE, is_active: false } as never);

    expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
    perms.can = () => true;
  });

  it("keeps Deactivate for a caller who holds sites.delete and not sites.update", () => {
    // The two keys are separate on the server, so they are separate here.
    perms.can = (p: string) => p === "sites.delete";
    renderDetail();

    expect(screen.getByTitle("Deactivate site")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    perms.can = () => true;
  });
});
