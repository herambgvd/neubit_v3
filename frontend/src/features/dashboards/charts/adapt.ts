// Spec result → the `{ columns, rows }` chart-data contract.
//
// This module has no counterpart in the standalone product, and it is the seam
// that made reusing their chart layer possible at all. Theirs fills `ChartData`
// with literally whatever a user's SQL returned. Ours fills the SAME shape from a
// structured query result, so their renderers port across unchanged while the
// free-SQL data path — which is the one decision this module does not reopen —
// stays out.
//
// Two result shapes come in (`series` and `aggregate`, the executor's only two)
// and one table goes out. That is what lets four widget types share one adapter,
// and what means a fifth chart drawing an existing shape needs nothing here.

import type { QueryResult, ResultSeries } from "../spec";
import type { Cell, ChartData } from "./types";

/** Which bucket field a metric reads. `count` is the sample count — the one
 *  quantity that is meaningful without a unit. */
const BUCKET_FIELD: Record<string, keyof ResultSeries["buckets"][number]> = {
  avg: "avg",
  min: "min",
  max: "max",
  first: "first",
  last: "last",
  count: "count",
};

/** Align several series onto ONE x axis.
 *
 *  Points do not share bucket timestamps: devices report at different rates, and
 *  a bucket with no sample simply does not exist in the rollup. So the union of
 *  every series' timestamps becomes the axis and a series with no value at a
 *  given timestamp gets `null` — which ECharts draws as a GAP, because
 *  `connectNulls` is left off. Bridging it would draw a reading nobody took. */
function fromSeries(result: QueryResult): ChartData {
  const field = BUCKET_FIELD[result.metric] ?? "avg";

  const stamps = new Set<number>();
  for (const s of result.series) for (const b of s.buckets) stamps.add(Date.parse(b.t));
  const xs = [...stamps].sort((a, b) => a - b);
  const index = new Map(xs.map((t, i) => [t, i]));

  const columns = [
    "time",
    ...result.series.map((s) => s.point_tag || s.point_id.slice(0, 8)),
  ];

  const rows: Cell[][] = xs.map((t) => {
    const row: Cell[] = new Array(columns.length).fill(null);
    // The x cell is the epoch millisecond, formatted by the chart. Keeping it
    // numeric means the axis is a real time axis rather than a category axis of
    // pre-formatted strings, so gaps are spaced correctly in time.
    row[0] = t;
    return row;
  });

  result.series.forEach((s, si) => {
    for (const b of s.buckets) {
      const i = index.get(Date.parse(b.t));
      if (i === undefined) continue;
      const v = (b as any)[field];
      rows[i][si + 1] = v === null || v === undefined ? null : Number(v);
    }
  });

  return { columns, rows, labelIndex: 0, resolutionReason: result.resolution_reason };
}

/** The aggregate table: one row per group.
 *
 *  Four columns, and the two string ones are why `numericColumns` exists — a
 *  chart must not try to plot the device name. The table widget shows all four;
 *  the bar chart plots column 0 against the numeric ones. One adapter, because
 *  two would drift on exactly the metric label. */
function fromAggregate(result: QueryResult): ChartData {
  const metricCol = result.metric === "count" ? "samples" : result.metric;
  const columns = ["point", "device", metricCol, "samples"];
  const rows: Cell[][] = result.rows.map((r) => [
    r.label,
    r.sublabel ?? null,
    // NULL, not 0 — the executor returns null when nothing was measured in the
    // window, and flattening that to zero would invent a reading.
    r.value === null || r.value === undefined ? null : r.value,
    r.samples,
  ]);
  return { columns, rows, labelIndex: 0, resolutionReason: result.resolution_reason };
}

export function toChartData(result: QueryResult): ChartData {
  return result.shape === "series" ? fromSeries(result) : fromAggregate(result);
}

/** The min→max envelope for a SINGLE series, as two ECharts series.
 *
 *  Only ever for one series: overlaid bands on six lines are unreadable, so the
 *  band is dropped rather than drawn badly. It matters because a 1-hour average
 *  otherwise hides a spike entirely — the same reason the hand-built BI trend
 *  chart draws one. Returns `[lows, highs]` aligned to `toChartData`'s rows. */
export function seriesBand(result: QueryResult): [number | null, number | null][] | null {
  if (result.shape !== "series" || result.series.length !== 1) return null;
  if (result.metric === "count") return null;

  const s = result.series[0];
  const stamps = new Set<number>();
  for (const b of s.buckets) stamps.add(Date.parse(b.t));
  const xs = [...stamps].sort((a, b) => a - b);
  const by = new Map(s.buckets.map((b) => [Date.parse(b.t), b]));

  return xs.map((t) => {
    const b = by.get(t);
    if (!b) return [null, null];
    const lo = b.min ?? b.avg;
    const hi = b.max ?? b.avg;
    return [lo ?? null, hi ?? null];
  });
}
