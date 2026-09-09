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

describe("the rail's order", () => {
  it("puts the channels above the calendar", async () => {
    // The operator's order: pick the channels, THEN the day. The calendar's
    // footage marks are read for the FIRST CHECKED channel, so with the calendar
    // on top an operator paged a month that was marked for nothing yet, chose a
    // day, and only then found the channels — at which point the marks changed
    // under the choice they had already made.
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    const rail = screen.getByText("Channels").closest("aside")!;
    const monthHeading = [...rail.querySelectorAll("*")].find((el) =>
      /^[A-Z][a-z]+ \d{4}$/.test(el.textContent?.trim() || ""),
    )!;
    expect(monthHeading).toBeTruthy();

    // DOCUMENT_POSITION_FOLLOWING: the calendar comes AFTER the channel picker.
    const channels = screen.getByText("Channels");
    expect(channels.compareDocumentPosition(monthHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the channel rail", () => {
  it("groups channels under the recorder that owns them", async () => {
    renderWithProviders(<UnifiedPlayback />);

    expect(await screen.findByText("recorder-a")).toBeInTheDocument();
    expect(screen.getByText("Channel 1")).toBeInTheDocument();
  });

  it("offers no VMS-storage tab — that store can never hold footage here", async () => {
    // Single ownership: the recorder owns every camera and writes every frame, so
    // a tab pointing at this platform's own pooled storage was a choice between
    // the cameras and an empty list.
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    expect(screen.queryByRole("button", { name: /VMS storage/i })).toBeNull();
  });

  it("never asks this platform for footage, whatever it has rows for", async () => {
    // The recording, retention and storage data-plane was taken OUT of this
    // service on purpose: the recorder writes every frame and answers every
    // question about it. A picker offering a second store would put that back in
    // the operator's head, and a timeline stitched from two stores would be a
    // claim this platform cannot support.
    stubAll({ "GET /vms/cameras": { items: [LOCAL_CAM], total: 1 } });
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    expect(screen.queryByText("VMS storage")).toBeNull();
    expect(screen.queryByText("Lobby")).toBeNull();
    expect(stub.matching("GET /vms/cameras")).toHaveLength(0);
  });

  it("searches across channels and recorders, and says how many matched", async () => {
    // A recorder holds many channels and the rail is a quarter of the screen;
    // scrolling to find one is the failure this replaces.
    stubAll({
      "GET /vms/federation/cameras": {
        items: [
          FED_CAM,
          { ...FED_CAM, id: "fed-cam-2", name: "Loading bay" },
          { ...FED_CAM, id: "fed-cam-3", name: "Back gate" },
        ],
        total: 3,
      },
    });
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    await userEvent.type(screen.getByLabelText(/search channels/i), "gate");

    expect(await screen.findByText(/1 of 3 channels match/i)).toBeInTheDocument();
    expect(screen.getByText("Back gate")).toBeInTheDocument();
    expect(screen.queryByText("Loading bay")).toBeNull();
  });

  it("finds every channel on a recorder by the recorder's name", async () => {
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    await userEvent.type(screen.getByLabelText(/search channels/i), "recorder-a");
    expect(await screen.findByText("Channel 1")).toBeInTheDocument();
  });

  it("says a search matched nothing rather than looking like an empty estate", async () => {
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    await userEvent.type(screen.getByLabelText(/search channels/i), "zzz");
    expect(await screen.findByText(/no channel matches/i)).toBeInTheDocument();
  });

  it("collapses a recorder so a big estate stays scannable", async () => {
    renderWithProviders(<UnifiedPlayback />);
    await screen.findByText("Channel 1");

    await userEvent.click(screen.getByRole("button", { name: /recorder-a/i }));
    expect(screen.queryByText("Channel 1")).toBeNull();
  });

  it("reports unreachable recorders instead of an empty channel list", async () => {
    stubAll({
      "GET /vms/federation/cameras": () => httpError(503, "recorder-a did not answer"),
    });
    renderWithProviders(<UnifiedPlayback />);
    expect(await screen.findByText(/did not answer/i)).toBeInTheDocument();
  });

  it("says where cameras come from when there are none at all", async () => {
    stubAll({ "GET /vms/federation/cameras": { items: [], total: 0 } });
    renderWithProviders(<UnifiedPlayback />);

    expect(await screen.findByText(/cameras are owned by recorders/i)).toBeInTheDocument();
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

  it("resolves by the node-side id the alarm carries, without a by-id fetch", async () => {
    window.history.replaceState({}, "", "/playback?camera=fed-cam-1");
    renderWithProviders(<UnifiedPlayback />);

    expect(await screen.findByText("tile:Channel 1")).toBeInTheDocument();
    // No fallback lookup against a store that holds nothing.
    expect(stub.matching("GET /vms/cameras/fed-cam-1")).toHaveLength(0);
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
