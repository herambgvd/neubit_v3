"use client";

// Gauge — one value read against a range.
//
// PORTED from `frontend-next/src/components/charts/gauge-chart.tsx`. Kept: the
// whole shape of the option object — a single `type: "gauge"` series with a
// `progress` arc over a flat track, an anchored pointer, and the value printed
// large in `detail` under the dial. That is a good gauge and it did not need
// redesigning.
//
// Changed, and the first one is why this chart is here at all rather than in the
// skipped list:
//
// * **It never invents the range.** Theirs hard-codes `min: 0, max: 100`, so a
//   230 V reading pins the needle off the end and a power factor of 0.94 sits
//   invisibly against the pin. On this store — where `points.unit` is NULL for
//   every point and nothing declares a nominal, a target or a limit — a 0–100
//   dial is a scale the data never carried. So this one takes its range from one
//   of exactly two honest sources, and refuses if it has neither:
//     1. `options.min` / `options.max`, which the widget's author stated;
//     2. failing that, the lowest and highest value across the OTHER rows the
//        same query returned — "how does this point sit against the rest of its
//        scope". The dial then says so under the number, because a range the
//        reader cannot see the origin of is not much better than an invented one.
//   With one row and no stated range there is nothing to read the value against,
//   and it says that instead of drawing a dial.
// * **A null value is a refusal, not a zero.** Theirs does
//   `raw != null && !Number.isNaN(...) ? Number(raw) : 0` — a point with no
//   sample in the window renders as a needle resting on zero, which is a reading.
// * **Which cell it reads.** Theirs takes `rows[0][0]`, the first cell of the
//   first row, because a free-SQL gauge query returns one number. Our aggregate
//   row starts with the point NAME, so it reads the first NUMERIC column and
//   uses column 0 as the dial's label — the same fix `kpi-card` needed.
// * **Theme.** Theirs carries nine hard-coded hexes (`#10b981`, `#232a35`,
//   `#52525b`, `#71717a`, `#e4e4e7`, `#a1a1aa`); every one is now a navy token.
// * **`animation`** respects `prefers-reduced-motion` — including
//   `detail.valueAnimation`, which is a separate switch and is the one that
//   counts the number up.
// * The formatter is the widget's own (`number-format.ts`): a unit appears only when the author asserted one, attributed on the tile.

import { CHART_FONT, CHART_PALETTE, chartTheme } from "../chart-theme";
import { formatterFor } from "../number-format";
import { ECHARTS_PROPS, ReactEChartsCore, motionOptions } from "./echarts";
import ChartNotice from "./notice";
import type { ChartProps } from "./types";
import { numericColumns } from "./types";

export default function GaugeChart({ data, options, onEvents }: ChartProps) {
  const t = chartTheme();
  const rows = data?.rows || [];
  // ONE formatter per widget, built from its options, so the axis, the tooltip
  // and any value label cannot spell the same number differently. It appends the
  // author's stated unit when there is one — and the widget footer attributes it
  // (`number-format.unitNote`), because a unit here is a person's claim, never
  // something read from the data (contract §4).
  const fmt = formatterFor(options);
  const motion = motionOptions();

  const valueIdx = numericColumns(data)[0];
  const row = rows[0];

  if (!row || valueIdx === undefined) {
    return <ChartNotice>Nothing matched this scope.</ChartNotice>;
  }

  const raw = row[valueIdx];
  if (typeof raw !== "number") {
    return <ChartNotice>No reading for this point in the window.</ChartNotice>;
  }

  const label = String(row[data.labelIndex] ?? data.columns[data.labelIndex] ?? "");

  // Source 1: the author stated a range.
  const statedMin = typeof options?.min === "number" ? options.min : undefined;
  const statedMax = typeof options?.max === "number" ? options.max : undefined;

  let min: number | undefined = statedMin;
  let max: number | undefined = statedMax;
  let basis = "range set on this widget";

  if (min === undefined || max === undefined) {
    // Source 2: the rest of the scope. Nulls excluded — a point that reported
    // nothing does not widen the range to zero.
    const peers = rows
      .map((r) => r[valueIdx])
      .filter((v): v is number => typeof v === "number");
    const lo = Math.min(...peers);
    const hi = Math.max(...peers);
    if (peers.length < 2 || !(hi > lo)) {
      return (
        <ChartNotice>
          A gauge needs a range to read the value against, and there is none here:
          this scope returned {peers.length === 1 ? "a single value" : "no values"}
          , and nothing on this deployment declares a nominal or a limit. Raise
          the row limit so the rest of the scope comes back, set a range on the
          widget, or use a Stat tile.
        </ChartNotice>
      );
    }
    min = min ?? lo;
    max = max ?? hi;
    basis = `lowest→highest of ${peers.length} in this scope`;
  }

  const option = {
    backgroundColor: "transparent",
    ...motion,
    series: [
      {
        name: label || "Value",
        type: "gauge",
        min,
        max,
        // Clamp only the ARC. The printed number below is always the real value,
        // so a stated range narrower than the reading is visible rather than
        // silently rewriting it.
        progress: { show: true, width: 10, itemStyle: { color: CHART_PALETTE[0] } },
        axisLine: { lineStyle: { width: 10, color: [[1, t.gaugeTrack]] } },
        // Four arcs, not ECharts' ten: at widget size ten split marks read as a
        // hatched band rather than as a scale.
        splitNumber: 4,
        axisTick: { show: false },
        splitLine: { distance: -19, length: 7, lineStyle: { color: t.axis } },
        axisLabel: {
          // Well inside the arc. ECharts' default (15) puts the labels on top of
          // the track at widget size, and a tick label sitting across the arc it
          // is labelling is worse than no tick label.
          distance: 20,
          color: t.text,
          ...CHART_FONT,
          // ONLY the endpoints are labelled. The interior splits stay as marks:
          // readings on this platform run to six figures (243,496 as it happens),
          // and five of those around a tile-sized dial overlap into a smear. The
          // two numbers that make the dial readable are the ones the basis line
          // under it names — where the scale starts and where it ends.
          formatter: (v: number) =>
            v === min || v === max ? fmt(v) : "",
        },
        pointer: { itemStyle: { color: t.tooltipText }, width: 4 },
        anchor: { show: true, size: 6, itemStyle: { color: t.tooltipText } },
        title: {
          color: t.text,
          ...CHART_FONT,
          offsetCenter: [0, "88%"],
          width: 260,
          overflow: "break",
          lineHeight: 12,
        },
        detail: {
          // The needle animation and the count-up are separate switches; both
          // follow `prefers-reduced-motion`.
          valueAnimation: motion.animation,
          color: t.tooltipText,
          fontSize: 22,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          // Below the pivot so the needle never crosses the number, and above
          // the two endpoint labels at the foot of the arc.
          offsetCenter: [0, "42%"],
          formatter: (v: number) => fmt(v),
        },
        // ECharts renders `name` under the dial. It carries the basis of the
        // scale, because a dial whose endpoints came from somewhere the reader
        // cannot see is the thing this chart exists to avoid.
        data: [{ value: raw, name: label ? `${label} · ${basis}` : basis }],
      },
    ],
  };

  return <ReactEChartsCore {...ECHARTS_PROPS} option={option} onEvents={onEvents} />;
}
