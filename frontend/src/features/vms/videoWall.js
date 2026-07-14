// Video-wall layout math — ported from neubit_v2's streaming page (`LAYOUTS` +
// `gridStyle`) and gvd_nvr's `lib/videoWall.js` (`tourPages`). Kept data-only so
// it's importable anywhere. The wall assigns cameras to tiles; a "tour" cycles
// PAGES of cameras through the current layout on an interval.
//
// P2-D redesign: layouts now carry an `icon` (for the visual LayoutPicker) and
// an optional `areas` map for ASYMMETRIC / SPOTLIGHT grids (1+5, 1+7) where one
// hero tile spans several cells. Symmetric grids leave `areas` undefined and use
// plain repeat() columns/rows.

// Supported grids. `capacity = cols * rows` for symmetric layouts. Asymmetric
// layouts (spotlight) define `capacity` explicitly + a `cells` template.
export const LAYOUTS = [
  { key: "1x1", label: "1×1", cols: 1, rows: 1, capacity: 1, icon: "single" },
  { key: "2x2", label: "2×2", cols: 2, rows: 2, capacity: 4, icon: "grid-2" },
  { key: "2x3", label: "2×3", cols: 3, rows: 2, capacity: 6, icon: "grid-2x3" },
  { key: "3x3", label: "3×3", cols: 3, rows: 3, capacity: 9, icon: "grid-3" },
  { key: "3x4", label: "3×4", cols: 4, rows: 3, capacity: 12, icon: "grid-3x4" },
  { key: "4x4", label: "4×4", cols: 4, rows: 4, capacity: 16, icon: "grid-4" },
  { key: "5x5", label: "5×5", cols: 5, rows: 5, capacity: 25, icon: "grid-5" },
  // ── Spotlight (asymmetric): one hero tile + a strip of small tiles. ──────
  // 1+5: hero spans a 3×3 region top-left, 5 small tiles wrap the right/bottom.
  {
    key: "1+5",
    label: "1 + 5",
    cols: 4,
    rows: 3,
    capacity: 6,
    icon: "spotlight-5",
    // Grid-area template (rows of column tokens). Tile index → area name t0..tN.
    template: [
      "t0 t0 t0 t1",
      "t0 t0 t0 t2",
      "t3 t4 t5 t5",
    ],
  },
  // 1+7: hero spans a 3×3, 7 small tiles wrap right + bottom.
  {
    key: "1+7",
    label: "1 + 7",
    cols: 4,
    rows: 4,
    capacity: 8,
    icon: "spotlight-7",
    template: [
      "t0 t0 t0 t1",
      "t0 t0 t0 t2",
      "t0 t0 t0 t3",
      "t4 t5 t6 t7",
    ],
  },
];

export const DEFAULT_LAYOUT_KEY = "2x2";

export function getLayout(key) {
  return LAYOUTS.find((l) => l.key === key) || LAYOUTS[1];
}

export function isSpotlightLayout(layout) {
  return Array.isArray(layout?.template);
}

// CSS grid-template for a layout. Symmetric → repeat(); spotlight → named areas.
export function gridStyle(layout) {
  if (isSpotlightLayout(layout)) {
    return {
      gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
      gridTemplateAreas: layout.template.map((row) => `"${row}"`).join(" "),
    };
  }
  return {
    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
  };
}

// Per-tile inline style. For spotlight layouts, maps tile index → its named
// grid-area; for symmetric layouts, returns undefined (natural flow).
export function tileStyle(layout, index) {
  if (isSpotlightLayout(layout)) return { gridArea: `t${index}` };
  return undefined;
}

// Which tile index is the "hero" (largest) cell of a spotlight layout, or -1.
export function heroIndex(layout) {
  return isSpotlightLayout(layout) ? 0 : -1;
}

// Smallest layout that fits `count` cameras (caps at the largest grid). Only
// considers symmetric grids so results are predictable.
export function fitLayoutFor(count) {
  const sorted = LAYOUTS.filter((l) => !isSpotlightLayout(l)).sort(
    (a, b) => a.capacity - b.capacity,
  );
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

// Pick the profile for a tile given the grid size: full quality for a solo tile
// (or the spotlight hero), low-bandwidth sub-stream once several tiles share the
// link (v2 `preferredProfile` heuristic).
export function tileProfile(capacity, isHero = false) {
  if (isHero) return "main";
  return capacity <= 1 ? "main" : "sub";
}

// ── Pattern-ready hook ─────────────────────────────────────────────────────
// A "wall preset" is the ENTIRE wall state that a saved pattern restores in one
// call: { layout: <layoutKey>, tiles: [cameraId | null, ...] }. `buildPreset`
// serialises the current wall to that shape; the Streaming shell owns the
// matching `applyWallPreset(preset)` that hydrates it. Saved-pattern CRUD (name,
// persistence, sharing) plugs in on top of this shape later — see the TODO in
// Streaming.jsx. Keeping the shape here means patterns never need to know about
// cells/profiles internals.
export function buildPreset(layoutKey, cells) {
  return {
    layout: layoutKey,
    tiles: (cells || []).map((c) => c?.cameraId || null),
  };
}

// Normalise a preset's tile list to a given capacity (pads/truncates).
export function presetTilesForCapacity(tiles = [], capacity = 4) {
  const out = Array.from({ length: capacity }, () => null);
  (tiles || []).slice(0, capacity).forEach((id, i) => {
    out[i] = id || null;
  });
  return out;
}

// ── Camera-group layouts (config side) ──────────────────────────────────────
// Camera groups are authored in the Patterns config with the backend's grid enum
// ("1x1|2x2|3x3|4x3|4x4|6x4|6x5|6x6|8x8"). That vocabulary is INDEPENDENT of the
// wall's own layout keys (which include spotlight grids the config doesn't offer),
// so we keep an explicit list + a mapping into wall layout keys used at rotation.
export const GROUP_LAYOUTS = [
  { key: "1x1", label: "1×1", cols: 1, rows: 1, capacity: 1 },
  { key: "2x2", label: "2×2", cols: 2, rows: 2, capacity: 4 },
  { key: "3x3", label: "3×3", cols: 3, rows: 3, capacity: 9 },
  { key: "4x3", label: "4×3", cols: 4, rows: 3, capacity: 12 },
  { key: "4x4", label: "4×4", cols: 4, rows: 4, capacity: 16 },
  { key: "6x4", label: "6×4", cols: 6, rows: 4, capacity: 24 },
  { key: "6x5", label: "6×5", cols: 6, rows: 5, capacity: 30 },
  { key: "6x6", label: "6×6", cols: 6, rows: 6, capacity: 36 },
  { key: "8x8", label: "8×8", cols: 8, rows: 8, capacity: 64 },
];

export const DEFAULT_GROUP_LAYOUT = "2x2";

export function getGroupLayout(key) {
  return GROUP_LAYOUTS.find((l) => l.key === key) || GROUP_LAYOUTS[1];
}

// Map a WALL layoutKey → a valid GROUP layout key (for "save wall as group"). The
// two registries overlap on 1x1/2x2/3x3/4x4 (identity); for wall-only grids
// (2x3/3x4/5x5/1+5/1+7) pick the smallest group layout that fits the wall's
// capacity so every camera on the wall lands in the group. Falls back to largest.
export function wallLayoutToGroup(wallKey) {
  if (GROUP_LAYOUTS.some((l) => l.key === wallKey)) return wallKey;
  const cap = getLayout(wallKey)?.capacity || 4;
  const fit = [...GROUP_LAYOUTS]
    .sort((a, b) => a.capacity - b.capacity)
    .find((l) => l.capacity >= cap);
  return (fit || GROUP_LAYOUTS[GROUP_LAYOUTS.length - 1]).key;
}

// CSS grid-template for a group builder/preview cell of `cols × rows`.
export function groupGridStyle(layout) {
  const l = getGroupLayout(layout?.key || layout);
  return {
    gridTemplateColumns: `repeat(${l.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${l.rows}, minmax(0, 1fr))`,
  };
}

// Map a group layout enum → the wall's own layoutKey so `applyWallPreset` can
// render it. The wall already supports 1x1/2x2/3x3/4x4; the wider group grids
// (4x3/6x4/6x5/6x6/8x8) don't have a dedicated wall grid, so they're injected
// into LAYOUTS on demand via `ensureWallLayout` below. This function returns the
// layoutKey the wall should use for a given group (identical key — same cols×rows
// semantics), after ensuring the wall knows about it.
export function mapGroupLayout(groupLayoutKey) {
  const g = getGroupLayout(groupLayoutKey);
  ensureWallLayout(g);
  return g.key;
}

// Register a symmetric wall layout for a group grid the wall doesn't ship out of
// the box (e.g. 4x3, 6x4). Idempotent — skips keys already in LAYOUTS. Keeps the
// wall's math (gridStyle/capacity/tourPages) working for pattern rotation without
// duplicating the layout registry.
export function ensureWallLayout(groupLayout) {
  const g = typeof groupLayout === "string" ? getGroupLayout(groupLayout) : groupLayout;
  if (!g) return;
  if (LAYOUTS.some((l) => l.key === g.key)) return;
  LAYOUTS.push({
    key: g.key,
    label: g.label,
    cols: g.cols,
    rows: g.rows,
    capacity: g.capacity,
    icon: "grid",
  });
}
