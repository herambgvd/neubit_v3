"use client";

// Heatmap — time across, one row per series.
//
// PORTED from `frontend-next/src/components/charts/heatmap-chart.tsx`. Kept: the
// cartesian category/category grid, the `visualMap` colour ramp down the right
// edge, the `[xIndex, yIndex, value]` item encoding, and the emphasis shadow.
// The structure of an ECharts heatmap is fiddly and theirs had it right.
//
// Changed:
//
// * **The input shape.** Theirs reads a THREE-column SQL result — col0 = x
//   category, col1 = y category, col2 = value — which is what a free-SQL user
//   writes by hand. Our series result is WIDE: column 0 is the bucket timestamp
//   and every other column is one point's value in that bucket. So the grid is
//   built by transposing: x is the row (a time bucket), y is the column (a
//   point). No query change, no new result shape — this is the same `series`
//   payload the line chart draws, which is the point of the `{columns, rows}`
//   seam.
// * **This is the chart that made the port worth doing.** A line chart is
//   legible to about six series; past that it is spaghetti and the executor's
//   `limit` is doing the reader a favour by truncating. A heatmap reads thirty
//   rows at a glance, which is the shape of the question this platform actually
//   asks — which of these cameras was busy last night, which of these sensors
//   drifted over the week, when did the estate spike.
// * **A missing bucket is a HOLE, not a cold cell.** Theirs does
//   `Number(r[2]) || 0`, which paints "no reading" at the bottom of the colour
//   ramp — indistinguishable from a genuine low reading, and on an irregular
//   building feed that is most of the difference between two points. Null cells
//   are simply not emitted, so the widget's own background shows through.
//   `NaN`/`0 || 0` also silently swallows a real zero in theirs.
// * **The scale is per-series by default.** One shared colour scale across
//   several points is only meaningful if those points measure the same thing,
//   and nothing on the wire says they do — `points.unit` is NULL for all of them
//   (contract §4). A shared ramp would paint the 230-ish voltage row saturated
//   and the 0.94 power-factor row uniformly black, and a reader would take that
//   as "the second sensor is quiet". So each row is normalised to its OWN
//   min→max, the legend says "per row" instead of showing numbers that would not
//   apply to every row, and the tooltip always shows the real value.
//   `options.sharedScale` opts into one absolute scale for the case where the
//   author knows the rows are comparable; the legend then shows real numbers.
// * **Theme.** Their ramp is emerald/lime (`#10312a → #a3e635`); this one is the
//   navy `HEATMAP_RAMP` from `chart-theme.ts`. Their `splitArea` chequerboard is
//   dropped — it fights a dark ground.
// * **`animation`** respects `prefers-reduced-motion`.
// * The formatter is the widget's own (`number-format.ts`): a unit appears only when the author asserted one, attributed on the tile.

import { CHART_FONT, HEATMAP_RAMP, chartTheme } from "../chart-theme";
import { formatterFor } from "../number-format";
import { ECHARTS_PROPS, SafeECharts, motionOptions } from "./echarts";
import ChartNotice from "./notice";
import type { Cell, ChartProps, EChartsClickParams } from "./types";
import { numericColumns } from "./types";

/** Bucket labels for the x axis. The line chart gets a real `type: "time"` axis;
 *  a heatmap's x axis has to be categorical (one column per cell), so the label
 *  column is formatted here.
 *
 *  It takes a `Cell`, not a number, because the contract says a cell is
 *  `number | string | null` and the label column has legitimately been both: an
 *  epoch millisecond and an ISO-8601 timestamp, depending on which producer
 *  filled the table. A timestamp in either spelling is formatted as a time; a
 *  label that is not a timestamp at all (a category name, once a non-time
 *  dataset publishes) is passed through untouched rather than turned into
 *  "Invalid Date".
 *
 *  Which time format depends on the span, because "14:05" repeated across thirty
 *  days is not a label. */
function bucketLabels(cells: Cell[]): string[] {
  const stamps = cells.map((c) => {
    if (typeof c === "number") return c;
    if (typeof c === "string") {
      const t = Date.parse(c);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  });
  const known = stamps.filter((t): t is number => t !== null);
  const span = known.length > 1 ? known[known.length - 1] - known[0] : 0;
  const overADay = span > 36 * 3600 * 1000;
  return stamps.map((t, i) => {
    if (t === null) return String(cells[i] ?? "");
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (!overADay) return hm;
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
  });
}

export default function HeatmapChart({ data, options, onEvents }: ChartProps) {
  const t = chartTheme();
  const rows = data?.rows || [];
  // ONE formatter per widget, built from its options, so the axis, the tooltip
  // and any value label cannot spell the same number differently. It appends the
  // author's stated unit when there is one — and the widget footer attributes it
  // (`number-format.unitNote`), because a unit here is a person's claim, never
  // something read from the data (contract §4).
  const fmt = formatterFor(options);
  const seriesIdx = numericColumns(data);

  if (!rows.length || !seriesIdx.length) {
    return <ChartNotice>No readings in this window.</ChartNotice>;
  }

  const xs = bucketLabels(rows.map((r) => r[data.labelIndex]));
  // Top-down in the order the executor returned, which is how the legend and the
  // line chart order them. A category axis counts up from the bottom, so reverse.
  const yIdx = [...seriesIdx].reverse();
  const ys = yIdx.map((i) => String(data.columns[i]));

  // Per-row min/max, computed once. Also gives the absolute range for free.
  const bounds = yIdx.map((ci) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      const v = r[ci];
      if (typeof v !== "number") continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return Number.isFinite(lo) ? { lo, hi } : null;
  });

  const shared = options?.sharedScale === true || yIdx.length === 1;

  let absLo = Number.POSITIVE_INFINITY;
  let absHi = Number.NEGATIVE_INFINITY;
  for (const b of bounds) {
    if (!b) continue;
    if (b.lo < absLo) absLo = b.lo;
    if (b.hi > absHi) absHi = b.hi;
  }

  // Items are `[x, y, realValue, normalised]`. `visualMap.dimension` picks which
  // one drives the colour, so the tooltip can always show the real number even
  // when the ramp is relative.
  const points: (number | string)[][] = [];
  yIdx.forEach((ci, yi) => {
    const b = bounds[yi];
    const span = b && b.hi > b.lo ? b.hi - b.lo : 0;
    rows.forEach((r, xi) => {
      const v = r[ci];
      // Absent, not zero — the cell is simply not drawn.
      if (typeof v !== "number") return;
      // A flat row — every bucket in it identical, which this building feed
      // produces whenever a sensor's last value is simply re-reported — has no
      // spread to normalise against. It sits at the MIDDLE of its own ramp, not
      // the top: a row with no variation has no high points, and painting it
      // saturated would assert one.
      const norm = b ? (span > 0 ? (v - b.lo) / span : 0.5) : 0.5;
      points.push([xi, yi, v, norm]);
    });
  });

  if (!points.length) {
    return <ChartNotice>No readings in this window.</ChartNotice>;
  }

  const option = {
    backgroundColor: "transparent",
    ...motionOptions(),
    grid: { left: 6, right: 58, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      // `trigger: "item"` — an axis trigger on a heatmap fires for the whole
      // column, which is not what a reader pointing at one cell asked for.
      trigger: "item",
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      textStyle: { color: t.tooltipText, ...CHART_FONT },
      formatter: (p: EChartsClickParams) => {
        const [xi, yi, v] = p.data as number[];
        return `${ys[yi]}<br/>${xs[xi]} · ${fmt(v)}`;
      },
    },
    xAxis: {
      type: "category",
      data: xs,
      axisLine: { lineStyle: { color: t.axis } },
      axisTick: { show: false },
      splitArea: { show: false },
      axisLabel: { color: t.text, ...CHART_FONT, hideOverlap: true },
    },
    yAxis: {
      type: "category",
      data: ys,
      axisLine: { lineStyle: { color: t.axis } },
      axisTick: { show: false },
      splitArea: { show: false },
      axisLabel: { color: t.text, ...CHART_FONT, width: 90, overflow: "truncate" },
    },
    visualMap: {
      // Dimension 3 is the per-row normalised value; dimension 2 is the real one.
      dimension: shared ? 2 : 3,
      min: shared ? (Number.isFinite(absLo) ? absLo : 0) : 0,
      max: shared ? (Number.isFinite(absHi) && absHi > absLo ? absHi : 1) : 1,
      calculable: shared,
      orient: "vertical",
      right: 2,
      top: "middle",
      itemWidth: 8,
      itemHeight: 72,
      textStyle: { color: t.text, ...CHART_FONT },
      // Relative scale: say so rather than printing 0 and 1, which are not
      // values anything measured.
      text: shared ? undefined : ["high\nper row", "low"],
      ...(shared ? { formatter: (v: number) => fmt(v) } : { showLabel: false }),
      inRange: { color: HEATMAP_RAMP },
    },
    series: [
      {
        type: "heatmap",
        // A wide window is thousands of cells; drawing them in chunks keeps the
        // widget from blocking the main thread on first paint.
        progressive: 2000,
        itemStyle: { borderWidth: 0 },
        emphasis: { itemStyle: { borderColor: t.tooltipText, borderWidth: 1 } },
        data: points,
      },
    ],
  };

  return <SafeECharts {...ECHARTS_PROPS} option={option} onEvents={onEvents} />;
}
