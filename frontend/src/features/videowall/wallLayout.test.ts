/**
 * The wall's two independent grids, as arithmetic rather than pixels:
 *
 *   1. a monitor's `layout` IS its cell count, and the grid it makes is square
 *   2. cell keys on the wire are STRINGS — reading cell 0 with a number must work
 *   3. an unknown / missing layout degrades to the single-cell grid, never to a
 *      zero-capacity one (a monitor that can hold nothing renders nothing)
 *
 * Nothing here touches React, so a break shows up as bad numbers, not bad markup.
 */
import { describe, expect, it } from "vitest";

import {
  MONITOR_LAYOUTS,
  cameraAt,
  filledCount,
  monitorGrid,
  monitorGridStyle,
  sortedMonitors,
  wallGridStyle,
  type WallMonitor,
} from "./wallLayout";

function monitor(id: string, position: number): WallMonitor {
  return {
    id,
    wall_id: "w1",
    name: id,
    position,
    kind: "browser",
    layout: 4,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("a monitor's cell grid", () => {
  it("gives every offered layout a square grid whose area is its cell count", () => {
    expect(MONITOR_LAYOUTS.length).toBeGreaterThan(0); // an empty list proves nothing
    for (const option of MONITOR_LAYOUTS) {
      const grid = monitorGrid(option.value);
      expect(grid.rows).toBe(grid.cols);
      expect(grid.cols * grid.rows).toBe(option.value);
      expect(grid.capacity).toBe(option.value);
    }
  });

  it("reads the layout off the wire whether it arrives as a number or a string", () => {
    expect(monitorGrid("9")).toMatchObject({ cols: 3, rows: 3, capacity: 9 });
    expect(monitorGrid(9)).toMatchObject({ cols: 3, rows: 3, capacity: 9 });
  });

  it("falls back to a single usable cell for an unknown or missing layout", () => {
    for (const bad of [null, undefined, 0, 7, "banana"]) {
      expect(monitorGrid(bad).capacity).toBe(1);
    }
  });

  it("emits a grid template with as many tracks as the layout has rows and columns", () => {
    expect(monitorGridStyle(16)).toEqual({
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gridTemplateRows: "repeat(4, minmax(0, 1fr))",
    });
  });
});

describe("the wall's monitor grid", () => {
  it("never collapses to zero tracks when a wall reports no rows or columns", () => {
    expect(wallGridStyle(0, 0)).toEqual({
      gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
      gridTemplateRows: "repeat(1, minmax(0, 1fr))",
    });
  });

  it("fills monitors in position order regardless of the order they arrived in", () => {
    const ordered = sortedMonitors([monitor("c", 2), monitor("a", 0), monitor("b", 1)]);
    expect(ordered.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("does not reorder the caller's own array while sorting", () => {
    const input = [monitor("c", 2), monitor("a", 0)];
    sortedMonitors(input);
    expect(input.map((m) => m.id)).toEqual(["c", "a"]);
  });
});

describe("reading the shared state blob", () => {
  const state = { m1: { "0": "cam-a", "3": "cam-b" }, m2: {} };

  it("finds a camera at a numeric cell index even though the keys are strings", () => {
    expect(cameraAt(state, "m1", 0)).toBe("cam-a");
    expect(cameraAt(state, "m1", 3)).toBe("cam-b");
  });

  it("reports an empty cell, an unknown monitor and an absent state as no camera", () => {
    expect(cameraAt(state, "m1", 1)).toBeNull();
    expect(cameraAt(state, "nope", 0)).toBeNull();
    expect(cameraAt(null, "m1", 0)).toBeNull();
  });

  it("counts filled cells across every monitor, ignoring cleared ones", () => {
    expect(filledCount({ m1: { "0": "a", "1": "" }, m2: { "0": "b" } })).toBe(2);
    expect(filledCount(null)).toBe(0);
  });
});
