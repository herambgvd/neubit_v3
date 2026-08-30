"use client";

// Time-series line chart.
//
// PORTED from `frontend-next/src/components/charts/line-chart.tsx`. The option
// object's structure — palette, grid insets, axis-trigger tooltip, a legend only
// when there is more than one series, one ECharts series per non-x column — is
// theirs and is kept. What changed:
//
// * **Theme.** Every colour now comes from `chart-theme.ts` (navy tokens), and
//   the type scale is the console's 10px rather than ECharts' 12px default.
// * **`xAxis.type: "time"`, not `"category"`.** Theirs plots whatever strings the
//   SQL returned, evenly spaced. Ours plots real timestamps, so a five-minute
//   gap in a sensor feed shows as a five-minute gap instead of being closed up —
//   which on an irregular building feed is the difference between an honest chart
//   and a flattering one.
// * **Numeric series only** (`numericColumns`), because our aggregate table
//   carries a string column theirs never had. See `types.ts`.
// * **`smooth: false`.** Theirs smooths. A spline through sampled readings draws
//   values between the samples that nobody measured; on a metering chart that is
//   not a stylistic choice.
// * **`connectNulls` left off**, so a bucket with no sample is a gap.
// * **The min→max band**, which theirs has no notion of — carried over from this
//   console's existing BI trend chart, because a 1-hour average otherwise hides a
//   spike completely.
// * **`animation`** respects `prefers-reduced-motion`.
// * No `valueFormatter` from their `@/lib/format`; ours is `fmtValue`, which
//   never appends a unit — there is none on the wire (pipeline contract §11/§12).

import { CHART_FONT, CHART_PALETTE, chartTheme } from "../chart-theme";
import { fmtValue } from "../spec";
import { ECHARTS_PROPS, ReactEChartsCore, motionOptions } from "./echarts";
import type { ChartProps } from "./types";
import { numericColumns } from "./types";

export interface LineChartProps extends ChartProps {
  /** `[lo, hi]` per row, from `adapt.seriesBand`. Drawn behind a single series. */
  band?: [number | null, number | null][] | null;
}

export default function LineChart({ data, options, onEvents, band }: LineChartProps) {
  const t = chartTheme();
  const rows = data?.rows || [];
  const seriesIdx = numericColumns(data);
  const decimals = options?.decimals;

  const series: any[] = seriesIdx.map((i) => ({
    name: data.columns[i],
    type: "line",
    // Straight segments, not a spline — see the header.
    smooth: false,
    showSymbol: rows.length <= 60,
    symbolSize: 4,
    lineStyle: { width: 1.6 },
    data: rows.map((r) => [r[data.labelIndex], r[i]]),
  }));

  // The envelope, as a transparent lower bound plus a filled `stack` band on top.
  // Drawn first so it sits behind the line, and given no legend entry.
  if (band && seriesIdx.length === 1) {
    series.unshift(
      {
        name: "__band_lo",
        type: "line",
        stack: "band",
        symbol: "none",
        lineStyle: { opacity: 0 },
        silent: true,
        data: rows.map((r, k) => [r[data.labelIndex], band[k]?.[0] ?? null]),
      },
      {
        name: "__band_hi",
        type: "line",
        stack: "band",
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: t.band },
        silent: true,
        // Stacked, so the second series carries the DIFFERENCE, not the top.
        data: rows.map((r, k) => {
          const lo = band[k]?.[0];
          const hi = band[k]?.[1];
          return [r[data.labelIndex], lo === null || hi === null || lo === undefined || hi === undefined ? null : hi - lo];
        }),
      },
    );
  }

  const option = {
    backgroundColor: "transparent",
    ...motionOptions(),
    color: CHART_PALETTE,
    grid: { left: 8, right: 12, top: seriesIdx.length > 1 ? 26 : 10, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      textStyle: { color: t.tooltipText, ...CHART_FONT },
      axisPointer: { lineStyle: { color: t.axis } },
      valueFormatter: (v: any) => fmtValue(typeof v === "number" ? v : null, decimals),
    },
    legend:
      seriesIdx.length > 1
        ? {
            top: 0,
            type: "scroll",
            icon: "roundRect",
            itemWidth: 10,
            itemHeight: 3,
            textStyle: { color: t.text, ...CHART_FONT },
            // The band's helper series must never appear in the legend.
            data: seriesIdx.map((i) => data.columns[i]),
          }
        : undefined,
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: t.axis } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: t.text, ...CHART_FONT, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      // Not forced through zero: a voltage that lives between 228 and 232 is
      // unreadable on an axis that starts at 0.
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: t.splitLine } },
      // No unit is ever appended — there is none on the wire.
      axisLabel: {
        color: t.text,
        ...CHART_FONT,
        formatter: (v: number) => fmtValue(v, decimals),
      },
    },
    series,
  };

  return <ReactEChartsCore {...ECHARTS_PROPS} option={option} onEvents={onEvents} />;
}
