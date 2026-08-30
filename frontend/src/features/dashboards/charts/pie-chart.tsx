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
// * **It refuses to draw a share of a non-additive aggregate.** Theirs pies
//   whatever the second column holds. A "share of the total" is only a fact when
//   the parts add up to the whole: that is true of a SUM and a COUNT and false
//   of an average, a min, a max or a last — eight points' average voltages do not
//   sum to anything, so a 23% slice on that ring is a number the data never
//   contained. This is the executor's own rule for incomparable series
//   (contract §4) applied one layer further out.
//
//   Getting that answer needed a deliberate ADDITION to the chart-data contract:
//   `ChartData.aggregates`, filled by `adapt.ts` from the widget's spec. The
//   generalised executor names a value column after its MEASURE, so `sum(value)`
//   and `avg(value)` arrive under the same column name and `{columns, rows}`
//   alone cannot tell them apart. The addition is optional and the refusal is
//   one-sided: when the aggregate is UNKNOWN the chart draws, because refusing
//   on a hunch is its own kind of dishonesty. See `types.ts`.
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

/** Aggregates whose parts genuinely sum to the whole.
 *
 *  `count` is the one quantity in this store that is meaningful without a unit
 *  and additive across groups, which is exactly why "events per camera" and
 *  "alarms per zone" are the queries this chart is for. `sum` joins it for a
 *  dataset that publishes an additive measure.
 *
 *  `count_distinct` is NOT here, and that is the case worth spelling out: the
 *  distinct badge-holders seen at four doors do not add up to the distinct
 *  badge-holders seen in the building, because a person who used two doors is
 *  counted twice. A ring of distinct counts sums to more than the whole. */
const ADDITIVE = new Set(["count", "sum"]);

export default function PieChart({ data, options, onEvents }: ChartProps) {
  const t = chartTheme();
  const rows = data?.rows || [];
  const decimals = options?.decimals;

  const valueIdx = numericColumns(data)[0];

  if (valueIdx === undefined) {
    return <ChartNotice>Nothing numeric to divide up.</ChartNotice>;
  }

  const label = String(data.columns[valueIdx] ?? "value");
  // `undefined` means the producer did not say — see the header. Only a KNOWN
  // non-additive aggregate refuses.
  const aggregate = data.aggregates?.[valueIdx] ?? null;

  if (aggregate && !ADDITIVE.has(aggregate.toLowerCase())) {
    return (
      <ChartNotice>
        A share of a total needs values whose parts add up to the whole, and
        “{aggregate}” of {label} does not — these are separate readings, not
        portions of one quantity, so a percentage of their sum would be a number
        the data never contained. Aggregate by Sum or Count, or use a bar chart
        to compare them.
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
        name: label,
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
