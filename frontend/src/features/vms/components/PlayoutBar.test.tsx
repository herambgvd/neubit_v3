/**
 * THE WALL'S PLAYBACK DOCK (SCRUM-337).
 *
 * It drew the FOCUSED camera alone, with no events, no zoom but a ladder, no
 * frame step or reverse, no range to export, and no keys — a second, weaker copy
 * of what the Playback page already did properly. It is now that page's timeline
 * and transport over the wall the operator built: a lane per recorder camera
 * under "All cameras", and the wall's own live ⇄ playback and SYNC above them.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const api = vi.hoisted(() => ({
  timeline: vi.fn(async (..._a: unknown[]) => ({ ranges: [] as unknown[] })),
  events: vi.fn(async (..._a: unknown[]) => ({ items: [] as unknown[] })),
  bookmarks: vi.fn(async (..._a: unknown[]) => ({ items: [] as unknown[] })),
}));
vi.mock("../api", () => ({
  vms: {
    federation: { timeline: api.timeline, bookmarks: { list: api.bookmarks }, actions: {} },
    events: { list: api.events },
  },
}));

import { INSTANT_REPLAY_MS } from "../playback/playbackModel";
import { useWallPlayback, type WallPlayback } from "../hooks/useWallPlayback";
import type { EstateCamera } from "../types";
import PlayoutBar, { MAX_LANES, targetText } from "./PlayoutBar";

function cam(n: number, over: Partial<EstateCamera> = {}): EstateCamera {
  return {
    id: `fed:node-1:cam-${n}`,
    real_id: `cam-${n}`,
    name: `Camera ${n}`,
    status: "online",
    federated: true,
    node_id: "node-1",
    node_name: "Recorder A",
    ...over,
  } as EstateCamera;
}

let pb: WallPlayback;
const onExport = vi.fn();
const onFocusCamera = vi.fn();

/** The dock over a real wall DVR, handing that DVR out so a test can drive it. */
function Dock({
  cameras,
  focus,
  onPb,
}: Readonly<{ cameras: EstateCamera[]; focus: string | null; onPb: (p: WallPlayback) => void }>) {
  const pb = useWallPlayback({ filledTiles: cameras.length });
  onPb(pb);
  return (
    <PlayoutBar cameras={cameras} focusCameraId={focus} onFocusCamera={onFocusCamera} pb={pb} onExport={onExport} />
  );
}

const show = (cameras: EstateCamera[], focus: string | null = cameras[0]?.id ?? null) =>
  renderWithProviders(
    <Dock
      cameras={cameras}
      focus={focus}
      onPb={(p) => {
        pb = p;
      }}
    />,
  );

/** The lane-label buttons the timeline draws, one per lane. */
const laneButtons = () =>
  screen.getAllByRole("button").filter((b) => /^Camera \d+$/.test(b.getAttribute("title") ?? ""));

beforeEach(() => {
  onExport.mockReset();
  onFocusCamera.mockReset();
  api.timeline.mockClear();
});
afterEach(cleanup);

describe("the lanes", () => {
  it("draws every recorder camera on the wall, in tile order, under All cameras", () => {
    show([cam(1), cam(2), cam(3), cam(9, { federated: false, node_id: undefined, real_id: undefined })]);

    expect(screen.getByText("All cameras")).toBeInTheDocument();
    expect(laneButtons().map((b) => b.title)).toEqual(["Camera 1", "Camera 2", "Camera 3"]);
  });

  it("reads each camera's coverage from the recorder that owns it", async () => {
    show([cam(1), cam(2)]);

    await waitFor(() => expect(api.timeline).toHaveBeenCalledTimes(2));
    expect(api.timeline.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ["node-1", "cam-1"],
      ["node-1", "cam-2"],
    ]);
  });

  it(`past ${MAX_LANES} cameras, draws the focused one so the video keeps the screen`, () => {
    const many = Array.from({ length: MAX_LANES + 1 }, (_, i) => cam(i + 1));
    show(many, many[4].id);

    expect(laneButtons().map((b) => b.title)).toEqual(["Camera 5"]);
  });

  it("picking a lane focuses that camera's tile", async () => {
    show([cam(1), cam(2)]);

    await userEvent.click(within(laneButtons()[1]).getByText("Camera 2"));

    expect(onFocusCamera).toHaveBeenCalledWith("fed:node-1:cam-2");
  });

  it("with no recorder camera on the wall, says where playback comes from", () => {
    show([cam(9, { federated: false, node_id: undefined, real_id: undefined })]);

    expect(screen.getByText(/Playback is from the recorders/)).toBeInTheDocument();
    expect(screen.queryByText("All cameras")).toBeNull();
  });
});

describe("the transport, on the wall", () => {
  it("Play on a live wall is instant playback of the last 30 s", async () => {
    show([cam(1)]);
    expect(screen.getByText("LIVE", { selector: "span" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Play" }));

    expect(pb.isPlayback).toBe(true);
    expect(Date.now() - (pb.clock.get() ?? 0)).toBeGreaterThanOrEqual(INSTANT_REPLAY_MS - 1_000);
    expect(screen.getByText("PLAYBACK")).toBeInTheDocument();
  });

  it("SYNC means something only in playback", async () => {
    show([cam(1), cam(2)]);

    expect(screen.getByRole("button", { name: /SYNC/ })).toBeDisabled();
    act(() => pb.playAt(Date.now() - 600_000));
    expect(screen.getByRole("button", { name: /SYNC/ })).toBeEnabled();
  });

  it("its LIVE button takes every tile back to live", async () => {
    show([cam(1)]);
    act(() => pb.playAt(Date.now() - 600_000));

    await userEvent.click(screen.getByTitle(/Back to live/));

    expect(pb.isPlayback).toBe(false);
  });

  it("names what it drives: the focused camera, or the whole wall with Sync", () => {
    expect(targetText({ isPlayback: false, sync: false }, "Camera 1")).toBe("live");
    expect(targetText({ isPlayback: true, sync: false }, "Camera 1")).toBe("Camera 1");
    expect(targetText({ isPlayback: true, sync: true }, "Camera 1")).toBe("whole wall");
  });
});

describe("IN / OUT", () => {
  it("exports the focused camera's marked range, from its recorder", async () => {
    show([cam(1), cam(2)], cam(2).id);
    const from = Date.now() - 600_000;
    const to = from + 60_000;
    act(() => pb.select(from, to));

    await userEvent.click(screen.getByRole("button", { name: /Export the marked range/ }));

    expect(onExport).toHaveBeenCalledWith({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      nodeId: "node-1",
      cameraId: "cam-2",
      cameraName: "Camera 2",
    });
  });
});

describe("the keys", () => {
  it("Space plays, as on the Playback page", () => {
    show([cam(1)]);

    fireEvent.keyDown(window, { key: " " });

    expect(pb.isPlayback).toBe(true);
  });

  it("are the field's while the operator is typing in one", () => {
    show([cam(1)]);

    fireEvent.keyDown(screen.getByLabelText("Day"), { key: " " });

    expect(pb.isPlayback).toBe(false);
  });

  it("Escape clears a range, and is left to the wall when there is none", () => {
    show([cam(1)]);
    act(() => pb.select(Date.now() - 600_000, Date.now() - 500_000));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(pb.hasSel).toBe(false);

    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
