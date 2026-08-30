// Executor result → the `{ columns, rows }` chart-data contract.
//
// This module has no counterpart in the standalone product, and it is the seam
// that made reusing their chart layer possible at all. Theirs fills `ChartData`
// with literally whatever a user's SQL returned. Ours fills the SAME shape from a
// server-generated query over a registered dataset, so their renderers port
// across unchanged while the free-SQL data path — the one decision this module
// does not reopen — stays out.
//
// Since the generalisation the executor returns ONE shape for every dataset and
// every chart, so this file is now almost a pass-through. It still exists, and
// still earns its place, for three reasons:
//
//  * a TIME column arrives as an ISO string and a time axis needs epoch
//    milliseconds — a category axis of pre-formatted strings would space gaps
//    wrongly, which is a chart lying about when nothing was measured;
//  * `resolution_reason` has to reach the renderer so a chart can print which
//    store answered it;
//  * the min/max band comes back as its own array, aligned to the rows;
//  * and the SELECT's aggregates are matched back onto the columns, because the
//    executor names a value column after its measure and a chart that claims its
//    slices are parts of a whole has to be able to tell a sum from an average.
//
// NULL passes through as NULL. It is never flattened to zero: "no sample in this
// bucket" and "the reading was zero" are different facts.

import type { QueryResult, WidgetSpec } from "../spec";
import type { Cell, ChartData } from "./types";

/** True when a column holds ISO timestamps we should plot on a time axis. */
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** Which aggregate produced each column, where that can be known FOR CERTAIN.
 *
 *  The executor returns column names, not the aggregates behind them, so this
 *  reads them back off the spec that asked the question. It matches positionally
 *  and only when the positions are unambiguous:
 *
 *   * a grouped table selects one column per `select` item, in order;
 *   * a time series selects ONE measure and spreads it across a column per
 *     series, so every non-time column shares that one aggregate.
 *
 *  Anything else — a count that does not line up, a spec that was not passed —
 *  returns `undefined`, and every consumer treats that as "unknown" rather than
 *  as a default. Guessing here would put a wrong aggregate on a column, which is
 *  worse than not knowing. */
function columnAggregates(result: QueryResult, spec?: WidgetSpec): (string | null)[] | undefined {
  const select = spec?.query?.select;
  if (!select?.length) return undefined;
  const columns = result.columns || [];

  if (spec?.query?.time_series) {
    if (select.length !== 1) return undefined;
    const agg = select[0]?.aggregate ?? null;
    return columns.map((_, i) => (i === (result.label_index ?? 0) ? null : agg));
  }

  if (select.length !== columns.length) return undefined;
  return select.map((item) => (item.measure ? (item.aggregate ?? null) : null));
}

export function toChartData(result: QueryResult, spec?: WidgetSpec): ChartData {
  const columns = result.columns || [];
  const timeCol = result.label_index ?? 0;
  const rows: Cell[][] = (result.rows || []).map((r) =>
    r.map((cell, i) => {
      if (i !== timeCol) return cell as Cell;
      if (typeof cell === "string" && ISO.test(cell)) {
        // Epoch ms, so the axis is a real time axis: gaps are spaced in time
        // rather than evenly, which is what makes a missing hour LOOK missing.
        const t = Date.parse(cell);
        return Number.isNaN(t) ? cell : t;
      }
      return cell as Cell;
    }),
  );
  return {
    columns,
    rows,
    labelIndex: timeCol,
    resolutionReason: result.resolution_reason,
    aggregates: columnAggregates(result, spec),
  };
}

/** The min→max envelope for a SINGLE series, as `[lo, hi]` per row.
 *
 *  MEASURED, not inferred. The executor computes it from the same buckets the
 *  line came from (`query.band`), rather than the browser inventing a range out
 *  of the averages it happens to hold. Only ever for one series: overlaid bands
 *  on six lines are unreadable, so the backend refuses to compute more and the
 *  band is dropped rather than drawn badly. It matters because a 1-hour average
 *  otherwise hides a spike entirely. */
export function seriesBand(result: QueryResult): [number | null, number | null][] | null {
  if (!result.band || !result.band.length) return null;
  return result.band.map((b) => [b?.[0] ?? null, b?.[1] ?? null]);
}
