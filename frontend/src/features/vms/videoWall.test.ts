/**
 * The streaming wall's layout registry. Two vocabularies meet here — the wall's
 * own layout keys (which include the asymmetric spotlight grids) and the
 * backend's camera-group `GridLayout` enum — and the property that matters is
 * that crossing between them never LOSES a camera: the group a wall is saved
 * into must be at least as large as the wall it came from.
 */
import { describe, expect, it } from "vitest";

import {
  GROUP_LAYOUTS,
  LAYOUTS,
  buildPreset,
  fitLayoutFor,
  getGroupLayout,
  getLayout,
  gridStyle,
  heroIndex,
  isSpotlightLayout,
  presetTilesForCapacity,
  tileProfile,
  tileStyle,
  tourPages,
  wallLayoutToGroup,
} from "./videoWall";

describe("wall → camera-group layout mapping", () => {
  it("keeps the key unchanged when both registries already agree on it", () => {
    for (const key of ["1x1", "2x2", "3x3", "4x4"]) {
      expect(wallLayoutToGroup(key)).toBe(key);
    }
  });

  it("never maps a wall onto a group too small to hold every one of its tiles", () => {
    expect(LAYOUTS.length).toBeGreaterThan(0); // an empty list would assert nothing
    for (const wall of LAYOUTS) {
      const group = getGroupLayout(wallLayoutToGroup(wall.key));
      expect(group.capacity).toBeGreaterThanOrEqual(wall.capacity);
    }
  });

  it("picks the SMALLEST group that fits, rather than the largest available", () => {
    // 2x3 (6 cameras) fits in 3x3 (9), not 4x3 (12) and not 8x8.
    expect(wallLayoutToGroup("2x3")).toBe("3x3");
    // 1+7 (8 cameras) also fits in 3x3.
    expect(wallLayoutToGroup("1+7")).toBe("3x3");
    // 5x5 (25) is bigger than 4x4/6x4 — the next one up is 6x5.
    expect(wallLayoutToGroup("5x5")).toBe("6x5");
  });

  it("still returns a real group key for a layout key it has never heard of", () => {
    // An unknown key resolves to the default wall layout (capacity 4) → 2x2.
    expect(wallLayoutToGroup("not-a-layout")).toBe("2x2");
    expect(GROUP_LAYOUTS.some((l) => l.key === wallLayoutToGroup("not-a-layout"))).toBe(true);
  });
});

describe("layout lookup", () => {
  it("declares a capacity equal to its area for every symmetric grid", () => {
    const grids = LAYOUTS.filter((x) => !isSpotlightLayout(x));
    expect(grids.length).toBeGreaterThan(0); // and a filter that matched nothing
    for (const l of grids) {
      expect(l.capacity).toBe(l.cols * l.rows);
    }
  });

  it("resolves an unknown layout key to a usable grid instead of undefined", () => {
    expect(getLayout("nope").capacity).toBeGreaterThan(0);
    expect(getLayout(null).capacity).toBeGreaterThan(0);
  });

  it("names one grid area per tile of a spotlight layout so no tile is unplaced", () => {
    const spotlight = getLayout("1+5");
    expect(isSpotlightLayout(spotlight)).toBe(true);
    const areas = String(gridStyle(spotlight).gridTemplateAreas);
    for (let i = 0; i < spotlight.capacity; i += 1) {
      expect(areas).toContain(`t${i}`);
      expect(tileStyle(spotlight, i)).toEqual({ gridArea: `t${i}` });
    }
    expect(heroIndex(spotlight)).toBe(0);
  });

  it("leaves symmetric tiles to natural flow and reports no hero", () => {
    const grid = getLayout("2x2");
    expect(tileStyle(grid, 0)).toBeUndefined();
    expect(heroIndex(grid)).toBe(-1);
  });

  it("chooses the smallest symmetric grid that holds the camera count", () => {
    expect(fitLayoutFor(1).capacity).toBe(1);
    expect(fitLayoutFor(5).capacity).toBe(6);
    expect(fitLayoutFor(10).capacity).toBe(12);
    // Beyond the biggest grid it caps rather than returning undefined.
    expect(fitLayoutFor(10_000).capacity).toBe(64);
  });
});

describe("tour paging and preset tiles", () => {
  it("pages a camera list into full pages plus a short final one, losing none", () => {
    const pages = tourPages(["a", "b", "c", "d", "e"], 2);
    expect(pages).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(pages.flat()).toHaveLength(5);
  });

  it("yields no pages at all for an empty list or a nonsensical capacity", () => {
    expect(tourPages([], 4)).toEqual([]);
    expect(tourPages(["a"], 0)).toEqual([]);
  });

  it("normalises a preset to exactly the grid's capacity, padding and truncating", () => {
    expect(presetTilesForCapacity(["a"], 4)).toEqual(["a", null, null, null]);
    expect(presetTilesForCapacity(["a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(presetTilesForCapacity(null, 2)).toEqual([null, null]);
  });

  it("serialises an empty wall cell as null rather than dropping the tile", () => {
    expect(buildPreset("2x2", [{ cameraId: "a" }, { cameraId: null }])).toEqual({
      layout: "2x2",
      tiles: ["a", null],
    });
  });

  it("spends full bitrate only on a solo tile or the spotlight hero", () => {
    expect(tileProfile(1)).toBe("main");
    expect(tileProfile(16, true)).toBe("main");
    expect(tileProfile(4)).toBe("sub");
  });
});
