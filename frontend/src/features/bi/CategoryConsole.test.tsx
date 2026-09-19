/**
 * The shared category console (Energy / HVAC / Water). Its expensive failures
 * are all the same shape — a screen that renders as "nothing is there" when
 * something IS there, or when the truth is unknown:
 *
 *   • a failed device load must read as a failure, not as an estate where no
 *     device in this category has ever reported;
 *   • selection is derived (`deviceId ?? filtered[0]`), so the first device is
 *     open on arrival and an explicit choice survives the 60s refetch;
 *   • a device with no points, and a point with no readings, are DIFFERENT
 *     facts and neither may render as a blank table or a blank chart.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import CategoryConsole from "./CategoryConsole";
import { bi } from "./api";

// The `?site=` scope is this console's second axis, so the search params are a
// fixture rather than a constant: every test below is either the ESTATE (no
// param) or ONE BUILDING (the param), and they are different screens.
const query = { site: "" };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.site ? { site: query.site } : {}),
}));

// The L2 gate strip rides above this console (see CategoryConsole.tsx). It reads
// the caller's permissions and four endpoints of its own; none of them is what
// this file is about, so they are answered as a clean, quiet estate and the strip
// collapses to its one line. Its own behaviour is covered by GateStrip.test.tsx.
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

beforeEach(() => {
  query.site = "";
  vi.spyOn(bi, "summary").mockResolvedValue({
    total_points: 4,
    total_registers: 4,
    total_points_reporting: 4,
    fresh_minutes: 15,
    sites: [{ site_id: "s1", score: 60, points: 4, categories: [] }],
    categories: [{ category: "hvac", devices: 2, points: 4, points_reporting: 4 }],
  });
  vi.spyOn(bi, "ghosts").mockResolvedValue({ groups: [], resurrected: [], fresh_minutes: 15 });
  vi.spyOn(bi, "unitPatterns").mockResolvedValue({
    patterns: [],
    totals: { points: 4, matched: 4, unmatched: 0, eligible: 0, already_confirmed: 4 },
  });
  vi.spyOn(bi, "roleOrphans").mockResolvedValue({ orphans: [], total: 0 });
  vi.spyOn(bi, "alerts").mockResolvedValue({ available: true, items: [] });
});

interface Device {
  device_id: string;
  device_tag: string;
  device_type: string;
  points: number;
  points_reporting: number;
  numeric_points: number;
  text_points: number;
  first_seen_at: string;
  last_seen_at: string;
}

const device = (over: Partial<Device> & { device_id: string; device_tag: string }): Device => ({
  device_type: "chiller",
  points: 2,
  points_reporting: 2,
  numeric_points: 2,
  text_points: 0,
  first_seen_at: "2026-01-01T00:00:00Z",
  last_seen_at: "2026-01-02T00:00:00Z",
  ...over,
});

const CH1 = device({ device_id: "d1", device_tag: "CH-1" });
const CH2 = device({ device_id: "d2", device_tag: "CH-2", device_type: "tfa" });

const point = (id: string, tag: string, latest: unknown) => ({
  point_id: id,
  point_tag: tag,
  type: "num",
  latest,
});

function devicesReturn(items: Device[]) {
  return vi.spyOn(bi, "devices").mockResolvedValue({ items, total: items.length });
}

function pointsReturn(items: unknown[]) {
  return vi
    .spyOn(bi, "points")
    .mockResolvedValue({ items, total: items.length, latest_lookback_minutes: 60 });
}

beforeEach(() => {
  pointsReturn([point("pt1", "KWH", { num: 42.5, quality: 0, ts: "2026-01-02T00:00:00Z" })]);
  vi.spyOn(bi, "series").mockResolvedValue({
    series: [{ buckets: [] }],
    resolution_reason: "1m rollup over 6 hours",
  });
  vi.spyOn(bi, "ratingSites").mockResolvedValue({ items: [] });
});

const render = () => {
  renderWithProviders(<CategoryConsole category="hvac" />);
  return userEvent.setup();
};

describe("a failed device load", () => {
  it("reports the failure instead of an estate where nothing has reported", async () => {
    vi.spyOn(bi, "devices").mockRejectedValue(new Error("reading store is unreachable"));

    render();

    expect(await screen.findByText(/reading store is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no device in this category has reported/i)).not.toBeInTheDocument();
  });

  it("still says nothing has reported when the category genuinely is empty", async () => {
    devicesReturn([]);

    render();

    expect(await screen.findByText(/no device in this category has reported/i)).toBeInTheDocument();
  });
});

describe("the derived device selection", () => {
  it("opens on the first device, so the detail pane is never blank on arrival", async () => {
    devicesReturn([CH1, CH2]);

    render();

    expect(await screen.findByRole("heading", { name: "CH-1" })).toBeInTheDocument();
    expect(screen.queryByText(/no device selected/i)).not.toBeInTheDocument();
  });

  it("keeps an explicit choice across a refetch rather than snapping back to the first", async () => {
    devicesReturn([CH1, CH2]);
    const { client } = renderWithProviders(<CategoryConsole category="hvac" />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("CH-2"));
    expect(await screen.findByRole("heading", { name: "CH-2" })).toBeInTheDocument();

    await client.invalidateQueries({ queryKey: ["bi-devices"] });

    await waitFor(() => expect(screen.getByRole("heading", { name: "CH-2" })).toBeInTheDocument());
  });

  it("says the search matched nothing without claiming the category is empty", async () => {
    devicesReturn([CH1]);
    const user = render();

    await user.type(await screen.findByPlaceholderText(/search devices/i), "zzz");

    expect(await screen.findByText(/no device in this category has reported/i)).toBeInTheDocument();
    expect(screen.queryByText("CH-1")).not.toBeInTheDocument();
  });
});

describe("a device with no points", () => {
  it("says so, rather than rendering a table with only a header", async () => {
    devicesReturn([device({ device_id: "d3", device_tag: "CH-3", points: 0, points_reporting: 0 })]);
    pointsReturn([]);

    render();

    expect(await screen.findByText(/this device has reported no points/i)).toBeInTheDocument();
  });

  it("is distinct from a point that reported nothing in the window", async () => {
    devicesReturn([CH1]);
    pointsReturn([point("pt1", "KWH", null)]);

    render();

    expect(await screen.findByText(/no sample in window/i)).toBeInTheDocument();
    expect(screen.queryByText(/this device has reported no points/i)).not.toBeInTheDocument();
  });
});

describe("a point with no readings", () => {
  it("prints an em dash for the value, never a stale number", async () => {
    devicesReturn([CH1]);
    pointsReturn([point("pt1", "KWH", null)]);

    render();

    await screen.findByText("KWH");
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("says the trend window is empty rather than drawing a blank chart", async () => {
    devicesReturn([CH1]);
    pointsReturn([point("pt1", "KWH", null)]);

    render();

    expect(await screen.findByText(/no samples in this window/i)).toBeInTheDocument();
  });
});

describe("what the console will not invent", () => {
  it("prints the rollup resolution the server reported instead of implying precision", async () => {
    devicesReturn([CH1]);

    render();

    expect(await screen.findByText(/1m rollup over 6 hours/i)).toBeInTheDocument();
  });

  it("shows a device's raw equipment kind when it is one nobody has a label for", async () => {
    devicesReturn([device({ device_id: "d9", device_tag: "BW-1", device_type: "borewell-pump" })]);

    render();

    expect(await screen.findAllByText("borewell-pump")).not.toHaveLength(0);
  });

  it("says the value was read raw, and over what lookback", async () => {
    devicesReturn([CH1]);

    render();

    expect(await screen.findByText(/current value read raw, last 60 min/i)).toBeInTheDocument();
  });
});

/**
 * L2 is the SAME pipeline, one scope down. The console gained the shared gate
 * strip, and the only thing that can go wrong with it here is scope: a strip
 * that read the estate's worklists under a domain heading would be answering a
 * question about the building with counts about everything.
 */
describe("the L2 gate strip", () => {
  it("reads the worklists scoped to its own category", async () => {
    devicesReturn([CH1]);
    vi.spyOn(bi, "points").mockResolvedValue({ items: [] });

    renderWithProviders(<CategoryConsole category="hvac" />);

    await waitFor(() => expect(bi.ghosts).toHaveBeenCalledWith({ category: "hvac" }));
    expect(bi.unitPatterns).toHaveBeenCalledWith({ category: "hvac" });
  });

  it("recedes to one line when this domain's gates are all open", async () => {
    devicesReturn([CH1]);
    vi.spyOn(bi, "points").mockResolvedValue({ items: [] });

    renderWithProviders(<CategoryConsole category="hvac" />);

    expect(await screen.findByText(/six gates, all open/)).toBeInTheDocument();
    expect(screen.queryByText(/^Gate \d/)).toBeNull();
  });
});

/**
 * ONE ROUTE, TWO SCOPES — the whole reason this file grew a search-param fixture.
 *
 *   /bi/hvac              the WHOLE ESTATE: every building's HVAC, plus the
 *                         points no building owns
 *   /bi/hvac?site=<uuid>  ONE BUILDING's HVAC
 *
 * The three domain tiles were once removed on the argument that Building's
 * Domains lane already reached "the same room". It does not, and 93 of this
 * fixture's 176 HVAC points prove it: they belong to no building, so the
 * unscoped console is the only place they exist. These cover the two failures
 * that would bring that confusion back — an estate view that does not announce
 * itself as one, and a building view that shows the estate's figures.
 */
const twoScopeSummary = {
  total_points: 176,
  total_registers: 176,
  total_points_reporting: 176,
  fresh_minutes: 15,
  categories: [{ category: "hvac", devices: 12, points: 176, points_reporting: 176 }],
  sites: [
    {
      site_id: "aeon-1",
      site_name: "Aeon Tower",
      score: 61,
      points: 83,
      categories: [{ category: "hvac", devices: 7, points: 83 }],
    },
    // The unplaced pseudo-row. It is a real state, it is the biggest fact on the
    // estate screen, and it is reachable from nowhere else.
    { site_id: null, site_name: null, score: null, points: 93, categories: [{ category: "hvac", devices: 5, points: 93 }] },
  ],
};

describe("the whole estate — the unscoped console", () => {
  beforeEach(() => {
    vi.spyOn(bi, "summary").mockResolvedValue(twoScopeSummary);
    devicesReturn([CH1]);
    pointsReturn([]);
  });

  it("announces that it is the estate, not one building", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);
    expect(await screen.findByText(/THE WHOLE ESTATE/)).toBeInTheDocument();
    expect(screen.getByTitle(/every building combined, plus the points no building owns/)).toBeInTheDocument();
  });

  it("rolls up where the domain lives, building by building", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);

    const aeon = await screen.findByRole("link", { name: /Aeon Tower/ });
    // Every row is a door into the OTHER scope.
    expect(aeon).toHaveAttribute("href", "/bi/hvac?site=aeon-1");
    expect(aeon).toHaveTextContent("83");
    expect(aeon).toHaveTextContent("7");
  });

  it("states the unplaced remainder as its own row, with the console that settles it", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);

    const remainder = await screen.findByRole("link", { name: /No building/ });
    expect(remainder).toHaveTextContent("93");
    // Every count ships with the action that changes it, and placement is owned
    // by Sites — this console has no placement worklist and must not grow one.
    expect(remainder).toHaveTextContent("Assign them to a building");
    expect(remainder).toHaveAttribute("href", "/bi/placement?category=hvac");
  });

  it("does not imply a portfolio that is not there", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);
    // ONE building and a large remainder, counted from the API — never "the
    // estate" in the plural on a deployment with one site.
    expect(
      await screen.findByText(/1 building has HVAC & Assets pinned to it, and 93 points belong to no building at all/),
    ).toBeInTheDocument();
  });

  it("shows no figure at all when the summary has not answered", async () => {
    vi.spyOn(bi, "summary").mockRejectedValue(new Error("nope"));
    renderWithProviders(<CategoryConsole category="hvac" />);
    expect(
      await screen.findByText(/estate summary has not answered, so this rollup cannot say where the domain lives/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /No building/ })).not.toBeInTheDocument();
  });

  it("carries the estate's unplaced remainder on gate 3", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);
    expect(await screen.findByText(/93 of 176 points belong to no site/)).toBeInTheDocument();
  });
});

describe("one building — the ?site= scoped console", () => {
  beforeEach(() => {
    query.site = "aeon-1";
    // The breadcrumb resolves the building's NAME from the `site_facts` mirror
    // — the same read Ratings makes — so the crumb says "Aeon Tower" and not a
    // uuid nobody can recognise.
    vi.spyOn(bi, "ratingSites").mockResolvedValue({
      items: [{ site_id: "aeon-1", site_name: "Aeon Tower" }],
    });
    vi.spyOn(bi, "summary").mockResolvedValue(twoScopeSummary);
    devicesReturn([CH1]);
    pointsReturn([]);
  });

  it("announces the building it is scoped to, and offers the way back out", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);

    expect(await screen.findByText("Aeon Tower")).toBeInTheDocument();
    expect(screen.getByText(/ONE BUILDING — HVAC & Assets at this site only/)).toBeInTheDocument();
    // The middle crumb is the escape hatch: the same domain, unscoped.
    expect(screen.getByRole("link", { name: "HVAC & Assets" })).toHaveAttribute("href", "/bi/hvac");
  });

  it("asks the store for this building's devices and nobody else's", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);
    await waitFor(() =>
      expect(bi.devices).toHaveBeenCalledWith(expect.objectContaining({ site_id: "aeon-1" })),
    );
  });

  it("does not roll up the estate inside one building", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);
    await screen.findByText("Aeon Tower");
    // A per-building breakdown inside one building is a list of one, and it
    // would put the OTHER buildings' rows on a screen that excludes them.
    expect(screen.queryByText(/across the estate/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /No building/ })).not.toBeInTheDocument();
  });

  it("does not let the estate's gate counts follow it in", async () => {
    renderWithProviders(<CategoryConsole category="hvac" />);
    // The building's worklists are clean, so its strip recedes — and the 93
    // unplaced points, the estate's fact, appear nowhere on it.
    expect(await screen.findByText("· six gates, all open")).toBeInTheDocument();
    expect(screen.queryByText(/belong to no site/)).not.toBeInTheDocument();
  });
});
