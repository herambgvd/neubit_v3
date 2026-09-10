/**
 * THE WALL'S MAP asks "which building" before "where in this building".
 *
 * It opened straight onto a floor plan with a site dropdown — the same fault the
 * alarm map had. The fix is the same: the estate first, then the plan, then a
 * camera onto the wall.
 *
 * With one caveat this suite pins hardest: ONE SITE IS NOT AN ESTATE. Making a
 * single-site deployment click through a map of one pin is a tax, so the plan
 * opens directly there and the estate map is offered only when there is somewhere
 * else to go.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import EstateMapView, { cameraOps, mappable } from "./EstateMapView";

const seen: Record<string, unknown>[] = [];
vi.mock("next/dynamic", () => ({
  default: () =>
    function StubBasemap(props: Record<string, unknown>) {
      seen.push(props);
      const actions = props.siteActions as ((s: unknown) => React.ReactNode) | undefined;
      return <div data-testid="gis">{actions?.({ site_id: "s1", name: "Aeon Tower" })}</div>;
    },
}));

// The floor plan is its own component with its own pickers; this suite is about
// which of the two screens is showing.
vi.mock("./MapView", () => ({
  default: () => <div data-testid="floorplan" />,
}));

beforeEach(() => {
  // The drill-down writes ?site= so the plan knows which one to open; jsdom keeps
  // the URL between tests, and a stale one would open the plan on the next mount.
  window.history.replaceState(null, "", "/streaming");
});

const site = (over: Record<string, unknown> = {}) => ({
  site_id: "s1",
  name: "Aeon Tower",
  coordinates: { latitude: 12.97, longitude: 77.59 },
  ...over,
});

const cam = (over: Record<string, unknown> = {}) => ({
  id: "fed:n1:c1",
  real_id: "c1",
  name: "Channel 1",
  node_id: "n1",
  status: "online",
  ...over,
});

let stub: ReturnType<typeof stubApi>;

function stubAll(sites: unknown[], placements: unknown[] = []) {
  stub = stubApi({
    "GET /sites": { items: sites, total: sites.length },
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": { items: [], total: 0 },
    "GET /device-placements/index": { items: placements, count: placements.length },
  });
  return stub;
}

/** The estate step is decided by how many sites there ARE, so nothing about it
 *  can be asserted until the site list has landed. Before it does, `pins` is
 *  empty and the plan shows for a different reason entirely. */
async function sitesLoaded() {
  await vi.waitFor(() => expect(stub.matching("GET /sites")).not.toHaveLength(0));
}

describe("what a pin can say", () => {
  it("counts the cameras there and how many are dark", () => {
    const at = () => [cam(), cam({ id: "b", status: "offline" })] as never[];
    const ops = cameraOps(at, "s1");
    expect(ops.cameras).toBe(2);
    expect(ops.offline).toBe(1);
    // Alarms are another console's business; this one says nothing about them.
    expect(ops.alarms).toBe(0);
  });

  it("keeps only sites with real coordinates", () => {
    expect(
      mappable([site(), site({ site_id: "s2", coordinates: null })] as never).map((s) => s.site_id),
    ).toEqual(["s1"]);
  });
});

describe("which screen opens", () => {
  it("goes straight to the plan when the estate is one site", async () => {
    stubAll([site()]);
    renderWithProviders(<EstateMapView />);
    await sitesLoaded();

    expect(await screen.findByTestId("floorplan")).toBeInTheDocument();
    expect(screen.queryByTestId("gis")).toBeNull();
    // And no way "up" is offered, because there is nowhere to go.
    expect(screen.queryByRole("button", { name: /estate map/i })).toBeNull();
  });

  it("opens the estate when there is more than one site", async () => {
    stubAll([site(), site({ site_id: "s2", name: "Depot" })]);
    renderWithProviders(<EstateMapView />);

    expect(await screen.findByTestId("gis")).toBeInTheDocument();
    expect(screen.queryByTestId("floorplan")).toBeNull();
  });

  it("drills into a site's plan, and offers the way back", async () => {
    stubAll([site(), site({ site_id: "s2", name: "Depot" })]);
    renderWithProviders(<EstateMapView />);

    await userEvent.click(await screen.findByRole("button", { name: /floor plan/i }));
    expect(screen.getByTestId("floorplan")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /estate map/i }));
    expect(screen.getByTestId("gis")).toBeInTheDocument();
  });

  it("does not claim an alarm count it cannot know", async () => {
    seen.length = 0;
    stubAll([site(), site({ site_id: "s2", name: "Depot" })]);
    renderWithProviders(<EstateMapView />);
    await screen.findByTestId("gis");

    expect(seen[0].showAlarms).toBe(false);
  });
});
