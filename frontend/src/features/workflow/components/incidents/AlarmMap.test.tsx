/**
 * THE MAP VIEW answers "which building", not "where in this building".
 *
 * It used to open straight onto a floor plan — one site, one level, a grid of
 * zones — which is the SECOND question, and on this estate it drew an empty grid
 * for a level nothing had been placed on. It is the estate now: the offline GIS
 * basemap, a pin per site, the open alarms there on the pin.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import AlarmMap, { alarmsBySite, mappableSites } from "./AlarmMap";

// The basemap is MapLibre over a self-hosted PMTiles archive, loaded through
// next/dynamic because it touches `window` at module scope. This suite is about
// WHICH sites it is handed and what the pins are told to carry.
const seen: Record<string, unknown>[] = [];
vi.mock("next/dynamic", () => ({
  default: () =>
    function StubBasemap(props: Record<string, unknown>) {
      seen.push(props);
      return <div data-testid="gis" />;
    },
}));

const site = (over: Record<string, unknown> = {}) => ({
  site_id: "s1",
  name: "Aeon Tower",
  coordinates: { latitude: 12.97, longitude: 77.59 },
  ...over,
});

const inc = (over: Record<string, unknown> = {}) => ({
  instance_id: `i-${Math.random().toString(36).slice(2)}`,
  status: "active",
  site_id: "s1",
  ...over,
});

describe("what can be drawn", () => {
  it("keeps only the sites that carry real coordinates", () => {
    const ok = site();
    const noCoords = site({ site_id: "s2", name: "Depot", coordinates: null });
    const junk = site({ site_id: "s3", coordinates: { latitude: "abc", longitude: 1 } });
    expect(mappableSites([ok, noCoords, junk] as never).map((s) => s.site_id)).toEqual(["s1"]);
  });

  it("counts OPEN alarms per site — a closed one is not a reason to click a pin", () => {
    const by = alarmsBySite([
      inc(),
      inc(),
      inc({ status: "resolved" }),
      inc({ site_id: null }),
    ] as never);
    expect(by.get("s1")?.alarms).toBe(2);
  });
});

describe("the map", () => {
  it("hands the basemap the estate's sites and their alarm counts", () => {
    seen.length = 0;
    render(<AlarmMap incidents={[inc(), inc()] as never} sites={[site()] as never} />);

    expect(screen.getByTestId("gis")).toBeInTheDocument();
    const props = seen[0] as { sites: unknown[]; ops: Map<string, { alarms: number }> };
    expect(props.sites).toHaveLength(1);
    expect(props.ops.get("s1")?.alarms).toBe(2);
  });

  it("says how many alarms it cannot place, instead of quietly dropping them", () => {
    // A map that omits half the queue without saying so is worse than no map.
    render(
      <AlarmMap
        incidents={[inc(), inc({ site_id: null }), inc({ site_id: "elsewhere" })] as never}
        sites={[site()] as never}
      />,
    );

    expect(screen.getByText(/2 open alarms cannot be placed/i)).toBeInTheDocument();
  });

  it("asks for coordinates rather than drawing an empty world", () => {
    render(<AlarmMap incidents={[inc()] as never} sites={[site({ coordinates: null })] as never} />);

    expect(screen.getByText(/no site on the map yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("gis")).toBeNull();
  });
});
