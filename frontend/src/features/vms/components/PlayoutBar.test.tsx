/**
 * THE WALL'S PLAYBACK DOCK (SCRUM-337).
 *
 * It drew the FOCUSED camera alone, with no events, no zoom but a ladder, no
 * frame step or reverse, no range to export, and no keys — a second, weaker copy
 * of what the Playback page already did properly. It is now that page's timeline
 * and transport over the wall the operator built, drawn as Milestone's live view
 * draws it — the focused camera's track over a thin "All cameras" track, two
 * however big the wall — and the wall's own live ⇄ playback and SYNC above them.
 * SYNC plays 24 cameras at most, as the recorder console does.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
import PlayoutBar, { drivenCams, playbackCamOf, targetText } from "./PlayoutBar";

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

/** The camera-track label buttons the timeline draws. */
const laneButtons = () =>
  screen.getAllByRole("button").filter((b) => /^Camera \d+$/.test(b.getAttribute("title") ?? ""));

beforeEach(() => {
  onExport.mockReset();
  onFocusCamera.mockReset();
  api.timeline.mockClear();
});
afterEach(cleanup);

describe("the two tracks", () => {
  it("draw the focused camera on top and All cameras under it", () => {
    show([cam(1), cam(2), cam(3)], cam(2).id);

    expect(laneButtons().map((b) => b.title)).toEqual(["Camera 2"]);
    const all = screen.getByText("All cameras");
    expect(laneButtons()[0].compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stay two however many cameras the wall holds", () => {
    const many = Array.from({ length: 64 }, (_, i) => cam(i + 1));
    show(many, many[40].id);

    expect(laneButtons().map((b) => b.title)).toEqual(["Camera 41"]);
  });

  it("read every wall camera's coverage, for All cameras, from the recorder that owns it", async () => {
    show([cam(1), cam(2)]);

    await waitFor(() => expect(api.timeline).toHaveBeenCalledTimes(2));
    expect(api.timeline.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ["node-1", "cam-1"],
      ["node-1", "cam-2"],
    ]);
  });

  it("with a focused tile no recorder holds, draw All cameras alone", () => {
    const local = cam(9, { federated: false, node_id: undefined, real_id: undefined });
    show([cam(1), local], local.id);

    expect(laneButtons()).toHaveLength(0);
    expect(screen.getByText("All cameras")).toBeInTheDocument();
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

  it("names what it drives: the focused camera, or the wall with Sync", () => {
    expect(targetText({ isPlayback: false, sync: false }, "Camera 1", 4)).toBe("live");
    expect(targetText({ isPlayback: true, sync: false }, "Camera 1", 4)).toBe("Camera 1");
    expect(targetText({ isPlayback: true, sync: true }, "Camera 1", 4)).toBe("whole wall");
    expect(targetText({ isPlayback: true, sync: true }, "Camera 1", 64)).toBe("24 cameras");
  });
});

describe("what the jumps run over", () => {
  const cams = Array.from({ length: 30 }, (_, i) => playbackCamOf(cam(i + 1))!);

  it("without Sync, the focused camera alone", () => {
    expect(drivenCams(cams, cams[5], false)).toEqual([cams[5]]);
  });

  it("with Sync, the 24 cameras playing: the focused one, then the wall in order", () => {
    const driven = drivenCams(cams, cams[25], true);

    expect(driven).toHaveLength(24);
    expect(driven[0]).toBe(cams[25]);
    expect(driven.slice(1)).toEqual(cams.slice(0, 23));
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
