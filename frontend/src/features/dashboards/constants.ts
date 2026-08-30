// Presentation constants for the dashboard builder.
//
// Every colour here is a NeuBit navy token (`docs/design-tokens.md` §2), copied
// as a literal because the chart canvas cannot read a CSS custom property — uPlot
// paints to a bitmap and needs a concrete value. That is the ONLY reason these
// are duplicated from the token file; nothing here invents a colour.

/** Series palette, in draw order. Chosen from the console accents so a chart
 *  reads as part of the same interface, and ordered so the first four (the common
 *  case) are maximally distinguishable from each other. */
export const SERIES_COLORS = [
  "#67e8f9", // nb-tealb
  "#c4b5fd", // nb-violetb
  "#93c5fd", // nb-blueb
  "#fbbf24", // nb-warn
  "#34d399", // nb-good
  "#f87171", // nb-crit
  "#22d3ee", // nb-teal
  "#a78bfa", // nb-violet
];

/** Chart chrome. `band` is the min→max envelope behind a single series. */
export const CHART_THEME = {
  axis: "#9a92c8", // nb-faint — labels and the axis line
  grid: "rgba(160,150,245,.14)", // a touch lighter than nb-line
  band: "rgba(103,232,249,.14)",
  font: "10px ui-sans-serif, system-ui, sans-serif",
};

/** Permission keys the backend gates on.
 *  - dashboards.* is the DASHBOARDS service (definitions).
 *  - bi.read is the READING-WRITER (the widget executor).
 *  Both are registered in core's catalog so a role can grant them. */
export const PERM_READ = "dashboards.read";
export const PERM_MANAGE = "dashboards.manage";
export const PERM_DATA = "bi.read";

/** Module the routes are gated by — "Dashboards & Reports". Same entitlement the
 *  rest of Building Intelligence rides; this is analytics over the same store. */
export const MODULE = "analytics";

/** Canvas defaults. 12 columns is the convention; the row height is what makes a
 *  4-row widget about the height of a chart worth looking at. */
export const GRID_COLS = 12;
export const ROW_HEIGHT = 56;
export const GRID_MARGIN: [number, number] = [10, 10];

/** Default footprint per chart type, in grid cells. A stat is small and a line
 *  chart needs room — starting a new widget at the wrong size is the fastest way
 *  to make a builder feel unfinished. */
export const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  line: { w: 6, h: 5 },
  bar: { w: 4, h: 5 },
  stat: { w: 3, h: 3 },
  table: { w: 6, h: 5 },
};

/** Category presentation, kept in step with `features/bi/constants.ts`. The
 *  vocabulary is the GATEWAY's — this only supplies a label and an icon for the
 *  values that actually arrive, and an unknown key renders as sent. */
export const CATEGORY_LABELS: Record<string, string> = {
  energy: "Energy & Metering",
  hvac: "HVAC & Assets",
  water: "Water",
  fire: "Fire & Safety",
};

export const categoryLabel = (key: string | null | undefined): string =>
  key === null || key === undefined
    ? "Unclassified"
    : key === ""
      ? "Unclassified"
      : CATEGORY_LABELS[key] || key;
