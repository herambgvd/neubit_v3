/**
 * REPORTS — a zero that nobody measured is not a measurement.
 *
 * Uptime, recording coverage and storage are computed from THIS service's own
 * tables: camera-health samples, pooled recordings, storage pools. On a
 * single-ownership estate all three are empty — the recorder owns the cameras,
 * writes the footage and owns the disks — and the API answered, honestly enough,
 * `rows: [], totals: { cameras: 0, avg_uptime_pct: 0.0 }`.
 *
 * The page then printed "Avg uptime 0%" in red for an estate whose cameras were
 * all online. That is the failure: not the empty result, the confident zero drawn
 * from it.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import Reports from "./Reports";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

const EMPTY_UPTIME = {
  kind: "camera-uptime",
  rows: [],
  totals: { cameras: 0, avg_uptime_pct: 0.0 },
};

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": {
      items: [{ id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a" }],
      total: 1,
    },
    "GET /vms/report-schedules": { items: [], total: 0 },
    "GET /vms/reports/*": EMPTY_UPTIME,
    ...over,
  });
  return stub;
}

beforeEach(() => stubAll());

describe("a report with nothing behind it", () => {
  it("says which store it read instead of printing 0% uptime", async () => {
    renderWithProviders(<Reports />);

    expect(await screen.findByText(/nothing to report in this window/i)).toBeInTheDocument();
    expect(screen.getByText(/camera-health samples/i)).toBeInTheDocument();
    // The number that used to be on screen, in red, about an online estate.
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("points at the console that does know — the recorders' own health", async () => {
    renderWithProviders(<Reports />);

    const link = await screen.findByRole("link", { name: /open pulse/i });
    expect(link).toHaveAttribute("href", "/pulse");
  });

  it("still renders a report that HAS rows", async () => {
    stubAll({
      "GET /vms/reports/*": {
        kind: "camera-uptime",
        rows: [{ camera_id: "c1", camera_name: "Lobby", uptime_pct: 99.2, samples: 100, online_samples: 99 }],
        totals: { cameras: 1, avg_uptime_pct: 99.2 },
      },
    });
    renderWithProviders(<Reports />);

    expect(await screen.findByText("Lobby")).toBeInTheDocument();
    expect(screen.queryByText(/nothing to report/i)).toBeNull();
  });
});

describe("the camera narrowing", () => {
  it("offers the recorder-owned cameras, which are the ones with events", async () => {
    // It read `/vms/cameras` alone, so on this estate the dropdown was empty and
    // the one report kind that DOES have data here could not be narrowed at all.
    renderWithProviders(<Reports />);
    // The kit's Select is a button + portalled panel, so the options exist once
    // it is opened — which is also the only way an operator sees them.
    await userEvent.click(await screen.findByRole("button", { name: /all cameras/i }));

    expect(await screen.findByRole("option", { name: "Channel 1" })).toBeInTheDocument();
  });
});
