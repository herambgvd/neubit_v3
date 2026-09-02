"use client";

// `viz` → the component that draws it.
//
// This map used to be a literal inside `ChartWidget.tsx`. It moved here when the
// chart set grew from four types to seven, for one reason: `widget-types.ts` is
// the registry the palette reads, and a type listed there but missing here is a
// widget that offers itself in the palette and then renders "this version cannot
// draw that". Keeping the two lists in one directory is what makes the mismatch
// findable; `assertRegistered` below makes it fail out loud in development.
//
// Every entry is `next/dynamic` with `ssr: false`. That is load-bearing twice
// over: ECharts touches `window` at module scope and would throw during SSR, and
// a dashboard made only of stat tiles and tables must not download the chart
// library at all. The three types added by the chart-set port therefore cost
// nothing on a dashboard that does not use them.

import dynamic from "next/dynamic";

import { WIDGET_TYPES } from "../widget-types";

const chartLoading = () => (
  <div className="flex h-full items-center justify-center text-[11px] text-nb-faint">
    Loading chart…
  </div>
);

const dyn = (loader: () => Promise<{ default: React.ComponentType<any> }>) =>
  dynamic(loader, { ssr: false, loading: chartLoading });

export const CHART_COMPONENTS: Record<string, React.ComponentType<any>> = {
  line: dyn(() => import("./line-chart")),
  heatmap: dyn(() => import("./heatmap-chart")),
  bar: dyn(() => import("./bar-chart")),
  pie: dyn(() => import("./pie-chart")),
  gauge: dyn(() => import("./gauge-chart")),
  stat: dyn(() => import("./kpi-card")),
  table: dyn(() => import("./data-table")),
};

// A palette entry with no renderer is a dead button. The check is dev-only so it
// costs nothing in production, where `ChartWidget`'s "this version cannot draw a
// …" panel is the correct, non-fatal fallback for a dashboard saved by a newer
// build.
if (process.env.NODE_ENV !== "production") {
  const missing = WIDGET_TYPES.filter((w) => !CHART_COMPONENTS[w.type]).map((w) => w.type);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[dashboards] widget types in the palette with no renderer: ${missing.join(", ")}`,
    );
  }
}
