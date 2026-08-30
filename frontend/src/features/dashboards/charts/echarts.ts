"use client";

// The ECharts instance every chart in this module renders through.
//
// NOT ported — this file has no counterpart in the standalone product, and it is
// the one place this port deliberately diverges from it.
//
// Their charts do `import ReactECharts from "echarts-for-react"`, which pulls the
// FULL echarts build: every chart type, every component, ~1 MB of JavaScript
// before gzip. That is a defensible trade in a product whose whole purpose is
// charting and which offers eleven chart types including 3D and a world map. It
// is not defensible here: this module ships four widget types, two of which draw
// no chart at all, inside a console that also carries video, floor plans and
// access control.
//
// So the charts import `echarts/core` and register exactly what they use. The
// registration list below IS the constraint — a chart type that is not in it
// renders nothing, which is the correct failure: it is loud at development time
// rather than a silent megabyte at load time. Adding a chart type means adding
// its module here, on purpose.
//
// `CanvasRenderer` and not `SVGRenderer`: a dashboard is many charts on one page,
// and canvas keeps the node count constant no matter how many points a series
// holds. That was the reason for choosing an ECharts-based layer in the first
// place.

import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";

import { BarChart, GaugeChart, HeatmapChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  BarChart,
  // Added with the chart-set port. Each of these three is one ECharts chart
  // module, not a second library: pie and gauge are self-contained, and heatmap
  // reuses the `GridComponent` the line and bar charts already pull in. The
  // three 3-D types the reference also ships were left out precisely because
  // they would have meant adding `echarts-gl` here.
  PieChart,
  GaugeChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  // Only the heatmap needs it — it is what turns a value into a colour, and
  // ECharts will silently paint every cell the same shade without it.
  VisualMapComponent,
  CanvasRenderer,
]);

export { echarts, ReactEChartsCore };

/** Options every chart passes to `<ReactEChartsCore>`.
 *
 *  `notMerge` + `lazyUpdate` are carried over from the source components and are
 *  load-bearing: without `notMerge`, switching a widget from three series to one
 *  leaves the third series drawn, because ECharts merges option objects by index.
 */
export const ECHARTS_PROPS = {
  echarts,
  notMerge: true,
  lazyUpdate: true,
  style: { height: "100%", width: "100%" },
};

/** Animation policy.
 *
 *  ECharts animates by default. `prefers-reduced-motion` is a stated requirement
 *  for this module, and ECharts has no built-in respect for it, so it is read
 *  once here and every chart spreads the result into its option object. Read at
 *  call time rather than module scope so a user changing the OS setting gets it
 *  on the next render instead of on the next full reload. */
export function motionOptions(): { animation: boolean } {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { animation: !reduced };
}
