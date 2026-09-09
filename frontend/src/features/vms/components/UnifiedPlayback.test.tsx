/**
 * PLAYBACK — the workspace, and the five ways it used to lie about footage.
 *
 * Every case here was live on a real estate, and every one of them looks like
 * "there is nothing recorded" to an operator:
 *
 *   1. the picker opened on this platform's own camera rows, of which a
 *      single-ownership estate has NONE, so the page said "No cameras" one letter
 *      away from the tab holding all of them ("Recorded" vs "Recorder");
 *   2. a deep link from an alarm resolved only against those same rows, 404'd on a
 *      recorder-owned camera, and opened an empty workspace in silence;
 *   3. a coverage read that FAILED was skipped by the merge, so an unreachable
 *      recorder drew exactly the timeline of a camera that recorded nothing;
 *   4. the calendar's footage marks did the same thing a month at a time;
 *   5. recorder-owned cameras got no event markers at all, though this service
 *      already mirrors each recorder's event ledger.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import UnifiedPlayback from "./UnifiedPlayback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
// The tiles mint sessions and attach hls.js; this suite is about which SOURCES the
// workspace offers and what it says about them.
vi.mock("./PlaybackPlayer", () => ({
  default: ({ cameraName }: { cameraName?: string }) => <div>tile:{cameraName}</div>,
}));

const FED_CAM = {
  id: "fed-cam-1",
  name: "Channel 1",
  node_id: "n1",
  node_name: "recorder-a",
  site_name: null,
};

const LOCAL_CAM = { id: "cam-local-1", name: "Lobby", site_id: null, is_active: true };

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": { items: [FED_CAM], total: 1 },
    "GET /sites": { items: [], total: 0 },
    "GET /vms/events": { items: [], total: 0 },
    "GET /vms/federation/nodes/n1/cameras/fed-cam-1/timeline": { ranges: [] },
    ...over,
  });
  return stub;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/playback");
  stubAll();
});

describe("which picker opens", () => {
  it("opens on the recorders when that is where the cameras are", async () => {
    renderWithProviders(<UnifiedPlayback />);
    expect(await screen.findByText("Channel 1")).toBeInTheDocument();
  });

  it("opens on this platform's storage when the recorders own nothing", async () => {
    stubAll({
      "GET /vms/federation/cameras": { items: [], total: 0 },
      "GET /vms/cameras": { items: [LOCAL_CAM], total: 1 },
    });
    renderWithProviders(<UnifiedPlayback />);
    expect(await screen.findByText("Lobby")).toBeInTheDocument();
  });

  it("says where the footage IS when the open tab has none", async () => {
    // "No cameras." was the whole message, on a page whose other tab held three.
    stubAll({ "GET /vms/cameras": { items: [], total: 0 } });
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    await userEvent.click(screen.getByRole("button", { name: /VMS storage/i }));
    expect(await screen.findByText(/recorded by their own recorder/i)).toBeInTheDocument();
  });

  it("reports unreachable recorders instead of an empty channel list", async () => {
    stubAll({
      "GET /vms/federation/cameras": () => httpError(503, "recorder-a did not answer"),
    });
    renderWithProviders(<UnifiedPlayback />);
    expect(await screen.findByText(/did not answer/i)).toBeInTheDocument();
  });
});

describe("a deep link from an alarm", () => {
  it("opens a recorder-owned camera, which used to 404 and do nothing", async () => {
    window.history.replaceState({}, "", "/playback?camera=fed-cam-1&t=2026-09-09T06:30:00Z");
    renderWithProviders(<UnifiedPlayback />);

    expect(await screen.findByText("tile:Channel 1")).toBeInTheDocument();
    // Never asked the local-camera endpoint for an id it could not own.
    expect(stub.matching("GET /vms/cameras/fed-cam-1")).toHaveLength(0);
  });

  it("says so when the camera is in neither list, rather than looking unpicked", async () => {
    window.history.replaceState({}, "", "/playback?camera=ghost-cam");
    stubAll({ "GET /vms/cameras/*": () => httpError(404, "Camera not found") });
    renderWithProviders(<UnifiedPlayback />);

    expect(await screen.findByText(/not in this estate/i)).toBeInTheDocument();
    expect(screen.getByText(/ghost-cam/)).toBeInTheDocument();
  });

  it("still resolves a camera in this platform's own storage", async () => {
    window.history.replaceState({}, "", "/playback?camera=cam-local-1");
    stubAll({ "GET /vms/cameras": { items: [LOCAL_CAM], total: 1 } });
    renderWithProviders(<UnifiedPlayback />);

    expect(await screen.findByText("tile:Lobby")).toBeInTheDocument();
  });
});

describe("a coverage read that failed", () => {
  it("names the source instead of drawing an empty timeline", async () => {
    window.history.replaceState({}, "", "/playback?camera=fed-cam-1");
    stubAll({
      "GET /vms/federation/nodes/n1/cameras/fed-cam-1/timeline": () =>
        httpError(503, "recorder unreachable"),
    });
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("tile:Channel 1");

    expect(await screen.findByText(/Coverage could not be read for/i)).toBeInTheDocument();
    expect(screen.getByText(/not showing that it has no footage/i)).toBeInTheDocument();
  });
});

describe("event markers on recorder-owned footage", () => {
  it("asks this service's mirror of the recorder's ledger for the loaded window", async () => {
    // The federated timeline carries coverage but no markers, so the flags and the
    // legend that filters them were empty for every recorder-owned camera.
    window.history.replaceState({}, "", "/playback?camera=fed-cam-1");
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("tile:Channel 1");

    await waitFor(() =>
      expect(
        stub.matching("GET /vms/events").some((c) => c.search.get("camera_id") === "fed-cam-1"),
      ).toBe(true),
    );
  });
});
