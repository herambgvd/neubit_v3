// Video-wall layout math (VW-D). Two independent grids:
//
//   • The WALL grid — rows × cols of MONITORS (physical screens). Driven by the
//     wall's `rows`/`cols`. Monitors fill it in `position` order (0-based,
//     row-major). A wall is a grid of monitors.
//   • A MONITOR grid — each monitor is itself a mini-grid of CELLS, one camera
//     each. The monitor's `layout` is the cell count (1|4|9|16) → a square grid
//     (1×1, 2×2, 3×3, 4×4). Cells fill left-to-right, top-to-bottom by index.
//
// Kept data-only so it's importable by the console, the kiosk, and management.

// Monitor cell layouts: count → { cols, rows, label }. Square grids only.
export const MONITOR_LAYOUTS = [
  { value: 1, cols: 1, rows: 1, label: "Single (1)" },
  { value: 4, cols: 2, rows: 2, label: "Quad (2×2)" },
  { value: 9, cols: 3, rows: 3, label: "3×3 (9)" },
  { value: 16, cols: 4, rows: 4, label: "4×4 (16)" },
];

export function monitorGrid(layout) {
  const l = MONITOR_LAYOUTS.find((x) => x.value === Number(layout)) || MONITOR_LAYOUTS[0];
  return { cols: l.cols, rows: l.rows, capacity: l.value, label: l.label };
}

// CSS grid-template for a monitor's cell grid.
export function monitorGridStyle(layout) {
  const { cols, rows } = monitorGrid(layout);
  return {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };
}

// CSS grid-template for the WALL's monitor grid (rows × cols of monitors).
export function wallGridStyle(rows = 1, cols = 1) {
  return {
    gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${Math.max(1, rows)}, minmax(0, 1fr))`,
  };
}

// Read the camera assigned to (monitor, cell) from a wall state blob. State is
// { monitor_id: { cell_index_str: camera_id } } — cell keys are STRINGS.
export function cameraAt(state, monitorId, cellIndex) {
  const mon = state?.[monitorId];
  if (!mon) return null;
  return mon[String(cellIndex)] || null;
}

// Count of filled cells across the whole wall (for the console header).
export function filledCount(state) {
  if (!state) return 0;
  return Object.values(state).reduce(
    (n, mon) => n + Object.values(mon || {}).filter(Boolean).length,
    0,
  );
}

// Sort monitors by position (row-major fill of the wall grid).
export function sortedMonitors(monitors = []) {
  return [...monitors].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export const DECODER_BRANDS = [
  { value: "hikvision", label: "Hikvision" },
  { value: "dahua_cpplus", label: "Dahua / CP-Plus" },
];
