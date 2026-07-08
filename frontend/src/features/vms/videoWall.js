// Video-wall layout math — ported from neubit_v2's streaming page (`LAYOUTS` +
// `gridStyle`) and gvd_nvr's `lib/videoWall.js` (`tourPages`). Kept data-only so
// it's importable anywhere. The wall assigns cameras to tiles; a "tour" cycles
// PAGES of cameras through the current layout on an interval.

// Supported grids. `capacity = cols * rows`. The task calls for 1/4/9/16/25;
// 6/12 are kept from v2 as handy asymmetric options.
export const LAYOUTS = [
  { key: "1x1", label: "1×1", cols: 1, rows: 1, capacity: 1 },
  { key: "2x2", label: "2×2", cols: 2, rows: 2, capacity: 4 },
  { key: "2x3", label: "2×3", cols: 3, rows: 2, capacity: 6 },
  { key: "3x3", label: "3×3", cols: 3, rows: 3, capacity: 9 },
  { key: "3x4", label: "3×4", cols: 4, rows: 3, capacity: 12 },
  { key: "4x4", label: "4×4", cols: 4, rows: 4, capacity: 16 },
  { key: "5x5", label: "5×5", cols: 5, rows: 5, capacity: 25 },
];

export const DEFAULT_LAYOUT_KEY = "2x2";

export function getLayout(key) {
  return LAYOUTS.find((l) => l.key === key) || LAYOUTS[1];
}

// CSS grid-template for a layout (v2 `gridStyle`).
export function gridStyle(layout) {
  return {
    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
  };
}

// Smallest layout that fits `count` cameras (caps at the largest grid).
export function fitLayoutFor(count) {
  const sorted = [...LAYOUTS].sort((a, b) => a.capacity - b.capacity);
  return sorted.find((l) => l.capacity >= count) || sorted[sorted.length - 1];
}

// Split a flat camera-id list into PAGES sized to the layout capacity — the
// unit a tour rotates through (gvd_nvr `tourPages`). Empty list → no pages.
export function tourPages(cameraIds = [], capacity = 4) {
  const ids = (cameraIds || []).filter(Boolean);
  if (ids.length === 0 || capacity < 1) return [];
  const pages = [];
  for (let i = 0; i < ids.length; i += capacity) {
    pages.push(ids.slice(i, i + capacity));
  }
  return pages;
}

// Pick the profile for a tile given the grid size: full quality for a solo
// tile, low-bandwidth sub-stream once several tiles share the link (v2
// `preferredProfile` heuristic).
export function tileProfile(capacity) {
  return capacity <= 1 ? "main" : "sub";
}
