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
//  * the min/max band comes back as its own array, aligned to the rows.
//
// NULL passes through as NULL. It is never flattened to zero: "no sample in this
// bucket" and "the reading was zero" are different facts.

import type { QueryResult } from "../spec";
import type { Cell, ChartData } from "./types";

/** True when a column holds ISO timestamps we should plot on a time axis. */
const ISO = /^\d{4}-\d{2}-\d{2}T/;

export function toChartData(result: QueryResult): ChartData {
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
