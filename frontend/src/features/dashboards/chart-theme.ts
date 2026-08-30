// ECharts colour tokens for the dashboard builder.
//
// PORTED from the standalone dashboard product
// (`frontend-next/src/lib/dashboard/chart-theme.ts`, 49 lines) and REWRITTEN
// rather than copied: the shape of the module — a `ChartThemeTokens` interface
// and one `chartTheme()` accessor that every chart calls — is theirs and is a
// good design, because it is the single seam through which ECharts (which paints
// to a canvas and cannot read a CSS custom property) learns what the interface
// looks like. Without it, hex values scatter across every option object; their
// own chart layer has roughly 67 of them across ten files, which is exactly what
// this file exists to stop happening here.
//
// What changed, and why:
//
// * **The light branch is gone.** Theirs returns a light palette when `<html>`
//   lacks `.dark`. In this console `.dark` is permanent and navy is the only
//   theme (`docs/design-tokens.md` §9), so a light branch would be unreachable
//   code that quietly invited a white chart onto a navy surface. `isLightTheme()`
//   does not come across either.
// * **Every value is a NeuBit navy token** from `docs/design-tokens.md` §2, not
//   their zinc/slate scale. This is the part the hand-off warned was real work:
//   an ECharts chart dropped in unstyled reads as a different product sitting
//   inside this console.
// * **The palette is the console's accents** rather than their emerald/amber set,
//   ordered so the first four — the common case — are maximally distinct.
//
// The tokens are literals on purpose. `getComputedStyle` at chart-build time
// would be a layout read per widget per render, and canvas cannot take a
// `var(--…)` anyway.

export interface ChartThemeTokens {
  /** Axis labels, legend text. */
  text: string;
  /** The axis line itself. */
  axis: string;
  /** Horizontal grid lines behind the plot. */
  splitLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  /** The min→max envelope behind a single series. */
  band: string;
}

export function chartTheme(): ChartThemeTokens {
  return {
    text: "#9a92c8", // nb-faint
    axis: "rgba(160,150,245,.28)", // a shade above nb-line
    splitLine: "rgba(160,150,245,.12)",
    tooltipBg: "rgba(11,18,40,.96)", // nb-field, near-opaque
    tooltipBorder: "#24325c", // --field-border
    tooltipText: "#f2f6ff", // nb-ink
    band: "rgba(103,232,249,.13)",
  };
}

/** Shared categorical palette used by every chart. NeuBit console accents
 *  (`docs/design-tokens.md` §2), ordered for maximum separation across the first
 *  four series — which is what most widgets draw. */
export const CHART_PALETTE = [
  "#67e8f9", // nb-tealb
  "#c4b5fd", // nb-violetb
  "#93c5fd", // nb-blueb
  "#fbbf24", // nb-warn
  "#34d399", // nb-good
  "#f87171", // nb-crit
  "#22d3ee", // nb-teal
  "#a78bfa", // nb-violet
];

/** Type scale for chart text. 10px matches the console's smallest label size;
 *  ECharts defaults to 12px sans, which reads a size too large next to the
 *  14px-root UI around it. */
export const CHART_FONT = {
  fontSize: 10,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};
