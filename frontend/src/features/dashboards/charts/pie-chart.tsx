"use client";

// Share-of-total, as a donut.
//
// PORTED from `frontend-next/src/components/charts/pie-chart.tsx`. Kept: the
// donut geometry (`radius: ["40%","68%"]`), the ring border in the tooltip
// colour that separates adjacent slices, `avoidLabelOverlap`, and the
// `{name, value}` mapping off column 0 and the value column. That is a small
// component and most of it was right.
//
// Changed, and the first change is the whole reason this file is longer than
// theirs:
//
// * **It refuses to draw a share of a non-additive metric.** Theirs pies
//   whatever the second column holds. Ours knows the column NAME is the metric
//   (`adapt.fromAggregate` names it `avg` / `min` / `max` / `first` / `last`, or
//   `samples` for a count), and a "share of the total" is only a fact when the
//   parts add up to the whole. Eight points' AVERAGES do not sum to anything —
//   a 23% slice on a pie of average voltages is a number the data never
//   contained. This is the same rule the executor already enforces for grouped
//   value metrics (contract §4), applied one layer further out.
// * **Nulls are dropped, not zeroed.** A point with no reading in the window is
//   absent from the ring; it is not a slice of size zero, and it is not counted
//   into the denominator. `ChartWidget` prints the sample count alongside.
// * **Negatives refuse too.** A share of a total is undefined once a part is
//   negative — ECharts will happily draw it and the percentages will not sum
//   to 100.
// * **Theme**: navy tokens and the console's 10px type, not their zinc defaults.
// * **`animation`** respects `prefers-reduced-motion`.
// * The value formatter is `fmtValue`, which never appends a unit — there is
//   none on the wire (pipeline contract §11/§12).

import { CHART_FONT, CHART_PALETTE, chartTheme } from "../chart-theme";
import { fmtValue } from "../spec";
import { ECHARTS_PROPS, ReactEChartsCore, motionOptions } from "./echarts";
import ChartNotice from "./notice";
import type { ChartProps, EChartsClickParams } from "./types";
import { numericColumns } from "./types";

/** Metrics whose parts genuinely sum to the whole. `samples` is the sample
 *  COUNT — the one quantity in this store that is meaningful without a unit and
 *  additive across points, which is exactly why "events per camera" and "alarms
 *  per zone" are the queries this chart is for. `count` and `sum` are listed
 *  ahead of a dataset that publishes them; they cost nothing to allow now and
 *  save a silent refusal later. */
const ADDITIVE = new Set(["samples", "count", "sum", "total"]);

export default function PieChart({ data, options, onEvents }: ChartProps) {
  const t = chartTheme();
  const rows = data?.rows || [];
  const decimals = options?.decimals;

  // The first numeric column is the metric; the last is always the sample count.
  const valueIdx = numericColumns(data)[0];
  const metric = valueIdx === undefined ? "" : String(data.columns[valueIdx] ?? "");

  if (valueIdx === undefined) {
    return <ChartNotice>Nothing numeric to divide up.</ChartNotice>;
  }

  if (!ADDITIVE.has(metric.toLowerCase())) {
    return (
      <ChartNotice>
        A share of a total needs a metric whose parts add up to the whole.
        “{metric}” does not: these values are separate readings, not portions of
        one quantity. Switch the metric to Samples, or use a bar chart to compare
        them.
      </ChartNotice>
    );
  }

  // null is absent, not zero — it stays out of both the ring and the denominator.
  const slices = rows
    .map((r) => ({ name: String(r[data.labelIndex] ?? ""), value: r[valueIdx] }))
    .filter((s): s is { name: string; value: number } => typeof s.value === "number");

  if (!slices.length) {
    return <ChartNotice>No readings in this window.</ChartNotice>;
  }

  if (slices.some((s) => s.value < 0)) {
    return (
      <ChartNotice>
        One of these values is negative, and a share of a total is undefined once
        a part is. Use a bar chart.
      </ChartNotice>
    );
  }

  const total = slices.reduce((a, s) => a + s.value, 0);

  const option = {
    backgroundColor: "transparent",
    ...motionOptions(),
    color: CHART_PALETTE,
    tooltip: {
      trigger: "item",
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      textStyle: { color: t.tooltipText, ...CHART_FONT },
      // Theirs uses ECharts' `{d}%`, which rounds to one decimal and drops the
      // absolute number. Both are wanted: the share is the point of the chart
      // and the count is what makes it checkable.
      formatter: (p: EChartsClickParams) =>
        `${p.name}<br/>${fmtValue(Number(p.value), decimals)} · ${
          total > 0 ? ((Number(p.value) / total) * 100).toFixed(1) : "0.0"
        }%`,
    },
    legend: {
      bottom: 0,
      type: "scroll",
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 3,
      textStyle: { color: t.text, ...CHART_FONT },
    },
    series: [
      {
        name: metric,
        type: "pie",
        radius: ["42%", "68%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        // The ring border is the widget's own ground, so adjacent slices read as
        // separated rather than as one blended arc.
        itemStyle: { borderColor: t.tooltipBg, borderWidth: 2 },
        // Slice labels are off: at widget size they collide with the legend and
        // with each other, and every one of them is already in the legend and
        // the tooltip. Theirs draws them.
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scaleSize: 4 },
        data: slices,
      },
    ],
  };

  return <ReactEChartsCore {...ECHARTS_PROPS} option={option} onEvents={onEvents} />;
}
