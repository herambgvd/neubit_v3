/**
 * The estate map page — everything above the canvas.
 *
 * The canvas itself is MapLibre (WebGL, no jsdom), so it is stubbed. What is
 * testable here is what decides WHAT the canvas is given: the site query's
 * ceiling, the needs-attention filter, and the honesty of the header — a site
 * with no coordinates and a feed that failed are both facts an operator must be
 * told, because neither can be seen on the map.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import SitesMapPage from "./SitesMap";

interface CanvasProps {
  sites: { site_id: string }[];
  ops?: Map<string, unknown>;
  showLabels?: boolean;
  selected?: { site_id: string } | null;
  focus?: { siteId: string; seq: number } | null;
}

/** The props the canvas was last rendered with — the page's real output. */
const drawn: CanvasProps = {
  sites: [],
};

vi.mock("next/dynamic", () => ({
  default: () =>
    function StubCanvas(props: CanvasProps) {
      drawn.sites = props.sites;
      drawn.ops = props.ops;
      drawn.showLabels = props.showLabels;
      drawn.selected = props.selected;
      drawn.focus = props.focus;
      return <div data-testid="canvas">{props.sites.map((s) => s.site_id).join(",")}</div>;
    },
}));

const site = (id: string, over: Record<string, unknown> = {}) => ({
  site_id: id,
  name: id,
  threat_level: "normal",
  coordinates: { latitude: 12.9, longitude: 77.6 },
  ...over,
});

const SITES = {
  items: [site("quiet"), site("noisy"), site("dark"), site("nowhere", { coordinates: null })],
  total: 4,
};

const PLACEMENTS = {
  items: [
    { device_id: "cam-q", device_type: "camera", site_id: "quiet", floor_id: "f1" },
    { device_id: "cam-n", device_type: "camera", site_id: "noisy", floor_id: "f1" },
    { device_id: "cam-d", device_type: "camera", site_id: "dark", floor_id: "f1" },
  ],
  count: 3,
};

const CAMERAS = {
  items: [
    { id: "cam-q", status: "online" },
    { id: "cam-n", status: "online" },
    { id: "cam-d", status: "offline" },
  ],
};

const EVENTS = { items: [{ id: "e1", camera_id: "cam-n", acknowledged: false }] };

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /settings/maps": { enabled: false, api_key: "", tiles_url: "", default_zoom: 5 },
    "GET /sites": SITES,
    "GET /device-placements/index": PLACEMENTS,
    "GET /vms/cameras": CAMERAS,
    "GET /vms/events": EVENTS,
    ...over,
  });
  return stub;
}

beforeEach(() => {
  drawn.sites = [];
  drawn.selected = null;
  drawn.focus = null;
  stubAll();
});

describe("what the canvas is given", () => {
  it("draws only sites that have coordinates, and says how many it could not", async () => {
    renderWithProviders(<SitesMapPage />);
    await waitFor(() => expect(drawn.sites.map((s) => s.site_id)).toEqual(["quiet", "noisy", "dark"]));
    // Silently dropping it would read as a site that does not exist.
    expect(screen.getByText(/1 without coordinates/i)).toBeInTheDocument();
  });

  it("asks for more than a hundred sites", async () => {
    // The old ceiling was 100 and truncated a larger estate without a word.
    renderWithProviders(<SitesMapPage />);
    await waitFor(() => expect(stub.matching("GET /sites")).not.toHaveLength(0));
    expect(Number(stub.matching("GET /sites")[0].search.get("limit"))).toBeGreaterThan(100);
  });

  it("hands the canvas the per-site rollup", async () => {
    renderWithProviders(<SitesMapPage />);
    await waitFor(() => expect(drawn.ops?.get("noisy")).toMatchObject({ alarms: 1, cameras: 1 }));
    expect(drawn.ops?.get("dark")).toMatchObject({ offline: 1, alarms: 0 });
    expect(drawn.ops?.get("quiet")).toMatchObject({ offline: 0, alarms: 0 });
  });
});

describe("the estate bar", () => {
  it("counts the sites needing attention", async () => {
    renderWithProviders(<SitesMapPage />);
    // noisy (alarm) + dark (offline camera); quiet is not one of them.
    expect(await screen.findByText(/2 need attention/i)).toBeInTheDocument();
  });

  it("filters to those sites without moving the camera", async () => {
    renderWithProviders(<SitesMapPage />);
    await waitFor(() => expect(drawn.sites).toHaveLength(3));

    await userEvent.click(screen.getByRole("button", { name: /needs attention/i }));
    await waitFor(() => expect(drawn.sites.map((s) => s.site_id)).toEqual(["noisy", "dark"]));
  });

  it("toggles the labels the canvas draws", async () => {
    renderWithProviders(<SitesMapPage />);
    await waitFor(() => expect(drawn.showLabels).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /labels/i }));
    await waitFor(() => expect(drawn.showLabels).toBe(false));
  });

  it("says a feed is unavailable rather than showing its counts as zero", async () => {
    // Zeros would read as "this site has no alarms", which is a different claim
    // from "we could not ask".
    stubAll({ "GET /vms/events": () => httpError(503, "vision down") });
    renderWithProviders(<SitesMapPage />);

    expect(await screen.findByText(/events unavailable/i)).toBeInTheDocument();
    // The map still draws — one missing count is not a reason to show nothing.
    await waitFor(() => expect(drawn.sites).toHaveLength(3));
  });

  it("reports an all-clear estate as all clear", async () => {
    stubAll({ "GET /vms/events": { items: [] }, "GET /vms/cameras": { items: [{ id: "cam-d", status: "online" }] } });
    renderWithProviders(<SitesMapPage />);
    expect(await screen.findByText(/all clear/i)).toBeInTheDocument();
  });
});

describe("the counts open what they count (SCRUM-311)", () => {
  it("lists the sites needing attention, and one click shows it on the map", async () => {
    renderWithProviders(<SitesMapPage />);
    await userEvent.click(await screen.findByRole("button", { name: /2 need attention/i }));

    // Why each is there, not just its name.
    expect(screen.getByText("1 alarm")).toBeInTheDocument();
    expect(screen.getByText("1 offline")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /dark/i }));
    await waitFor(() => expect(drawn.focus?.siteId).toBe("dark"));
    expect(drawn.selected?.site_id).toBe("dark");
    // The list closes once it has done its job.
    expect(screen.queryByText("1 alarm")).not.toBeInTheDocument();
  });

  it("names the site with no coordinates and links to where its location is set", async () => {
    renderWithProviders(<SitesMapPage />);
    await userEvent.click(await screen.findByRole("button", { name: /1 without coordinates/i }));

    const link = screen.getByRole("link", { name: /nowhere/i });
    expect(link).toHaveAttribute("href", "/sites?site=nowhere");
  });

  it("shows a site the attention filter would hide by turning the filter off", async () => {
    renderWithProviders(<SitesMapPage />);
    await userEvent.click(await screen.findByRole("button", { name: /needs attention/i }));
    await waitFor(() => expect(drawn.sites.map((x) => x.site_id)).toEqual(["noisy", "dark"]));

    await userEvent.click(screen.getByRole("button", { name: /2 need attention/i }));
    await userEvent.click(screen.getByRole("button", { name: /noisy/i }));
    // noisy is in the filtered set, so the filter stays on.
    expect(drawn.sites.map((x) => x.site_id)).toEqual(["noisy", "dark"]);
    expect(drawn.focus?.siteId).toBe("noisy");
  });
});
