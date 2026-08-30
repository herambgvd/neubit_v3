"use client";

// Bar chart over an aggregate.
//
// PORTED from `frontend-next/src/components/charts/bar-chart.tsx`. Kept: the
// option skeleton, the palette, the axis-trigger tooltip, the conditional legend,
// `barMaxWidth`, and the rounded `itemStyle.borderRadius` that makes their bars
// read as part of a designed interface rather than an ECharts default.
//
// Changed:
// * **Theme**, as everywhere — navy tokens and the console's 10px type.
// * **Horizontal bars.** Theirs is vertical, which is right for a handful of
//   short category names. The labels here are point tags like `KW_L1` and device
//   tags like `4F-5F Light DB`, and twelve of those on an x axis are unreadable
//   at any widget width. Swapping the axes makes the label the row, which is what
//   a long name needs.
// * **Numeric series only** (`numericColumns`) — our aggregate table carries a
//   device-name column theirs never had. See `types.ts`.
// * **`animation`** respects `prefers-reduced-motion`.
// * The value formatter is the widget's own (`number-format.ts`): a unit appears only when the author asserted one, attributed on the tile.

import { CHART_FONT, CHART_PALETTE, chartTheme } from "../chart-theme";
import { formatterFor } from "../number-format";
import { ECHARTS_PROPS, ReactEChartsCore, motionOptions } from "./echarts";
import type { ChartProps } from "./types";
import { numericColumns } from "./types";

export default function BarChart({ data, options, onEvents }: ChartProps) {
  const t = chartTheme();
  const rows = data?.rows || [];
  // ONE formatter per widget, built from its options, so the axis, the tooltip
  // and any value label cannot spell the same number differently. It appends the
  // author's stated unit when there is one — and the widget footer attributes it
  // (`number-format.unitNote`), because a unit here is a person's claim, never
  // something read from the data (contract §4).
  const fmt = formatterFor(options);

  // Only the FIRST numeric column is drawn. The aggregate table also carries the
  // sample count, and plotting a value against its own sample count on one pair
  // of bars compares two quantities with nothing in common.
  const seriesIdx = numericColumns(data).slice(0, 1);

  // Categories run bottom-to-top on a value/category flip, so reverse them to
  // read top-down in the order the executor returned.
  const categories = rows.map((r) => String(r[data.labelIndex] ?? "")).reverse();
  const values = rows.map((r) => r[seriesIdx[0]] ?? null).reverse();

  const option = {
    backgroundColor: "transparent",
    ...motionOptions(),
    color: CHART_PALETTE,
    grid: { left: 6, right: 14, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(150,180,245,.07)" } },
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      textStyle: { color: t.tooltipText, ...CHART_FONT },
      valueFormatter: (v: any) => fmt(typeof v === "number" ? v : null),
    },
    xAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: t.splitLine } },
      axisLabel: { color: t.text, ...CHART_FONT, formatter: (v: number) => fmt(v) },
    },
    yAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: t.axis } },
      axisTick: { show: false },
      axisLabel: {
        color: t.text,
        ...CHART_FONT,
        // A long tag is truncated in the axis and shown whole in the tooltip,
        // rather than eating the plot area.
        width: 96,
        overflow: "truncate",
      },
    },
    series: [
      {
        name: seriesIdx.length ? data.columns[seriesIdx[0]] : "value",
        type: "bar",
        barMaxWidth: 18,
        itemStyle: { borderRadius: [0, 3, 3, 0], color: CHART_PALETTE[0] },
        data: values,
      },
    ],
  };

  return <ReactEChartsCore {...ECHARTS_PROPS} option={option} onEvents={onEvents} />;
}
