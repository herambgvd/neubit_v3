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

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

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
