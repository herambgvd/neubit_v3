/** @vitest-environment jsdom */
/**
 * The Playback workspace's state (SCRUM-304..306): which controller drives what.
 *
 * A grid plays against ONE master time and a tile can break away (Milestone's
 * independent playback). The transport always acts on the ACTIVE tile's controller,
 * so the same buttons mean "the grid" or "this tile" — these pin that meaning.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SYNC_ID, usePlaybackWorkspace, type PlaybackCam } from "./usePlaybackWorkspace";

const cam = (n: number): PlaybackCam => ({
  key: `fed:node:${n}`,
  nodeId: "node",
  realId: `cam-${n}`,
  name: `Camera ${n}`,
  recorder: "Recorder A",
});

function setup() {
  return renderHook(() => usePlaybackWorkspace());
}

describe("usePlaybackWorkspace", () => {
  it("anchors the grid when the first camera is added and grows the layout as cameras arrive", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    expect(result.current.sync.anchorMs).not.toBeNull();
    expect(result.current.activeKey).toBe(cam(1).key);
    for (let i = 2; i <= 5; i += 1) {
      act(() => {
        result.current.addCam(cam(i));
      });
    }
    expect(result.current.cams).toHaveLength(5);
    expect(result.current.layout).toBe(9);
  });

  it("refuses a seventeenth camera", () => {
    const { result } = setup();
    for (let i = 1; i <= 16; i += 1) {
      act(() => {
        result.current.addCam(cam(i));
      });
    }
    let ok = true;
    act(() => {
      ok = result.current.addCam(cam(17));
    });
    expect(ok).toBe(false);
    expect(result.current.cams).toHaveLength(16);
  });

  it("drives the grid from a synced tile and one tile from an independent one", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    act(() => {
      result.current.addCam(cam(2));
    });
    expect(result.current.cams).toHaveLength(2);
    expect(result.current.active.id).toBe(SYNC_ID);

    act(() => result.current.toggleIndependent(cam(2).key));
    expect(result.current.active.id).toBe(cam(2).key);
    const gridAnchor = result.current.sync.anchorSeq;

    // A seek on the independent tile leaves the grid where it is.
    act(() => result.current.playAt(Date.now() - 3_600_000));
    expect(result.current.indep[cam(2).key].anchorSeq).toBeGreaterThan(1);
    expect(result.current.sync.anchorSeq).toBe(gridAnchor);

    // Bringing it back re-syncs the grid at the grid's own time.
    act(() => result.current.toggleIndependent(cam(2).key));
    expect(result.current.indep[cam(2).key]).toBeUndefined();
    expect(result.current.sync.anchorSeq).toBe(gridAnchor + 1);
  });

  it("never seeks past the recorder's live edge", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    act(() => result.current.playAt(Date.now() + 60_000));
    expect(result.current.sync.anchorMs!).toBeLessThan(Date.now());
  });

  it("marks IN before OUT, and drops an OUT that is not after IN", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    const t0 = Date.now() - 600_000;
    act(() => result.current.sync.clock.set(t0));
    act(() => result.current.markIn());
    act(() => result.current.sync.clock.set(t0 + 30_000));
    act(() => result.current.markOut());
    expect(result.current.sel).toEqual({ inMs: t0, outMs: t0 + 30_000 });
    expect(result.current.hasSel).toBe(true);

    act(() => result.current.sync.clock.set(t0 - 5_000));
    act(() => result.current.markOut());
    expect(result.current.sel.outMs).toBeNull();
    expect(result.current.hasSel).toBe(false);
  });

  it("slows a grid that grew past its speed, and refuses reverse on a big grid", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    act(() => result.current.setSpeed(16));
    expect(result.current.sync.speed).toBe(16);
    for (let i = 2; i <= 5; i += 1) {
      act(() => {
        result.current.addCam(cam(i));
      });
    }
    expect(result.current.sync.speed).toBe(4);
    expect(result.current.canReverse).toBe(false);
    act(() => result.current.setSpeed(-1));
    expect(result.current.sync.speed).toBe(1);
  });

  it("a frame step pauses and moves the playhead by one frame", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    const t0 = Date.now() - 600_000;
    act(() => result.current.sync.clock.set(t0));
    act(() => result.current.stepFrame(1));
    expect(result.current.sync.playing).toBe(false);
    expect(result.current.sync.scrubMs).toBe(t0 + 40);
    expect(result.current.sync.clock.get()).toBe(t0 + 40);
  });

  it("removing the active camera hands the focus to another tile", () => {
    const { result } = setup();
    act(() => {
      result.current.addCam(cam(1));
    });
    act(() => {
      result.current.addCam(cam(2));
    });
    expect(result.current.cams).toHaveLength(2);
    act(() => result.current.removeCam(cam(2).key));
    expect(result.current.activeKey).toBe(cam(1).key);
    act(() => result.current.clearAll());
    expect(result.current.cams).toHaveLength(0);
  });
});
