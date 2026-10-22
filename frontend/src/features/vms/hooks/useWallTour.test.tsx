// SCRUM-339: the wall tour pages cameras like a VMS auto-switch, and gives the wall back.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WallCell } from "../videoWall";
import { DEFAULT_TOUR_DWELL, repagedIndex, tourBlocked, tourDwell, useWallTour } from "./useWallTour";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `cam-${i + 1}`);
const OWN_WALL: WallCell[] = [{ cameraId: "mine-1" }, { cameraId: null }, { cameraId: "mine-2" }, { cameraId: null }];

function setup(held = false, seconds = 10) {
  const load = vi.fn();
  const restore = vi.fn();
  const hook = renderHook((p: { held: boolean; seconds: number }) =>
    useWallTour({ load, restore, snapshot: () => OWN_WALL, held: p.held, seconds: p.seconds }),
  { initialProps: { held, seconds } });
  return { load, restore, hook };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("when a tour may start", () => {
  it("needs more cameras than tiles, and says so", () => {
    expect(tourBlocked(8, 9)).toBe("All 8 cameras fit on this wall — a tour needs more cameras than tiles.");
    expect(tourBlocked(0, 9)).toBe("No cameras to tour.");
    expect(tourBlocked(10, 9)).toBeNull();
  });

  it("does not start on one page", () => {
    const { load, hook } = setup();

    let started = true;
    act(() => {
      started = hook.result.current.start(ids(8), 9);
    });

    expect(started).toBe(false);
    expect(hook.result.current.active).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("a running tour", () => {
  it("shows page one, then the next page every dwell, round and round", () => {
    const { load, hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));
    expect(load).toHaveBeenLastCalledWith(["cam-1", "cam-2", "cam-3", "cam-4"]);
    expect(hook.result.current.total).toBe(3);

    act(() => vi.advanceTimersByTime(10_000));
    expect(load).toHaveBeenLastCalledWith(["cam-5", "cam-6", "cam-7", "cam-8"]);
    act(() => vi.advanceTimersByTime(10_000));
    act(() => vi.advanceTimersByTime(10_000));
    expect(hook.result.current.index).toBe(0);
  });

  it("holds its page while paused or while the operator works a tile", () => {
    const { load, hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));

    act(() => hook.result.current.togglePause());
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.result.current.index).toBe(0);

    act(() => hook.result.current.togglePause());
    hook.rerender({ held: true, seconds: 10 });
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.result.current.index).toBe(0);
    expect(hook.result.current.held).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("steps back and forth, and a step restarts the dwell", () => {
    const { hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));

    act(() => hook.result.current.step(-1));
    expect(hook.result.current.index).toBe(2);
    act(() => vi.advanceTimersByTime(9_000));
    act(() => hook.result.current.step(1));
    act(() => vi.advanceTimersByTime(9_000));
    expect(hook.result.current.index).toBe(0);
  });

  it("takes a new dwell at once", () => {
    const { hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));

    hook.rerender({ held: false, seconds: 5 });
    act(() => vi.advanceTimersByTime(5_000));

    expect(hook.result.current.index).toBe(1);
  });
});

describe("a smooth page change", () => {
  it("loads the next page behind the wall before the dwell ends, then swaps to it", () => {
    const { load, hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));
    expect(hook.result.current.preload).toBeNull();

    act(() => vi.advanceTimersByTime(6_000));
    expect(hook.result.current.preload).toEqual(["cam-5", "cam-6", "cam-7", "cam-8"]);
    expect(hook.result.current.slot).toBe(0);

    act(() => vi.advanceTimersByTime(4_000));
    expect(hook.result.current.slot).toBe(1);
    expect(hook.result.current.preload).toBeNull();
    expect(load).toHaveBeenLastCalledWith(["cam-5", "cam-6", "cam-7", "cam-8"]);
  });

  it("preloads half the dwell ahead on a short dwell", () => {
    const { hook } = setup(false, 5);
    act(() => void hook.result.current.start(ids(10), 4));

    act(() => vi.advanceTimersByTime(2_400));
    expect(hook.result.current.preload).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(hook.result.current.preload).not.toBeNull();
  });

  it("preloads nothing while paused or held", () => {
    const { hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));
    act(() => vi.advanceTimersByTime(7_000));

    act(() => hook.result.current.togglePause());
    expect(hook.result.current.preload).toBeNull();
    act(() => hook.result.current.togglePause());
    act(() => vi.advanceTimersByTime(5_000));
    expect(hook.result.current.preload).toBeNull();

    hook.rerender({ held: true, seconds: 10 });
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.result.current.preload).toBeNull();
  });

  it("a step to a page that was not preloaded keeps the layer", () => {
    const { hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));
    act(() => vi.advanceTimersByTime(7_000));

    act(() => hook.result.current.step(-1));

    expect(hook.result.current.slot).toBe(0);
    expect(hook.result.current.preload).toBeNull();
  });
});

describe("ending a tour", () => {
  it("Stop puts the operator's own wall back", () => {
    const { restore, hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));

    act(() => hook.result.current.stop());

    expect(restore).toHaveBeenCalledWith(OWN_WALL);
    expect(hook.result.current.active).toBe(false);
  });

  it("a manual edit ends it without putting anything back", () => {
    const { restore, hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));

    act(() => hook.result.current.end());
    act(() => hook.result.current.stop());

    expect(restore).not.toHaveBeenCalled();
  });
});

describe("a new layout mid-tour", () => {
  it("re-pages and keeps the page's first camera on screen", () => {
    const { load, hook } = setup();
    act(() => void hook.result.current.start(ids(20), 4));
    act(() => hook.result.current.step(1));
    act(() => hook.result.current.step(1)); // page 3: cam-9…

    act(() => hook.result.current.relayout(9));

    expect(load).toHaveBeenLastCalledWith(ids(9));
    expect(load.mock.lastCall?.[0]).toContain("cam-9");
    expect(repagedIndex(2, 4, 9)).toBe(0);
    expect(hook.result.current.total).toBe(3);
  });

  it("shows everything and ends once every camera fits", () => {
    const { load, hook } = setup();
    act(() => void hook.result.current.start(ids(10), 4));

    act(() => hook.result.current.relayout(16));

    expect(load).toHaveBeenLastCalledWith(ids(10));
    expect(hook.result.current.active).toBe(false);
  });
});

describe("the remembered dwell", () => {
  it("is one of the choices, else the default", () => {
    expect(tourDwell(15)).toBe(15);
    expect(tourDwell(7)).toBe(DEFAULT_TOUR_DWELL);
    expect(tourDwell("x")).toBe(DEFAULT_TOUR_DWELL);
  });
});
