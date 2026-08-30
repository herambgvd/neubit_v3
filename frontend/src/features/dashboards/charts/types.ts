// The chart-data contract.
//
// PORTED from the standalone product (`frontend-next/src/components/charts/types.ts`)
// and kept almost verbatim, because the shape it defines is the good part of that
// design: every chart renderer consumes a plain `{ columns, rows }` table and
// knows nothing about where the numbers came from. That is what lets a new chart
// type be added without touching the query layer, and it is why their eleven
// charts share one prop type.
//
// The ONE thing that changed is what fills it. Theirs is a free-SQL `QueryResult`
// — literally the column names and rows a user's SQL returned. Ours is produced
// by `adapt.ts` from a STRUCTURED query spec (see `../spec.ts` for why that
// decision is not reopened). The renderers cannot tell the difference, which is
// exactly the point of keeping the contract.

/** ECharts types its option object as `any`; event params are untyped. */
export type EChartsClickParams = any;

/** A tabular result: named columns and positional rows. A cell is a number, a
 *  string, or null — and NULL IS NOT ZERO. "No reading in this window" and "the
 *  reading was zero" are different facts, and every renderer here draws them
 *  differently (an em dash versus a 0). */
export type Cell = number | string | null;

export interface ChartData {
  columns: string[];
  rows: Cell[][];
  /** Index of the column that is the x axis / the row label. Always 0 today; it
   *  is named rather than assumed so a future chart can say otherwise. */
  labelIndex: number;
  /** Which store answered and what that means for freshness, in one line of
   *  plain English, straight from the executor. A chart prints it rather than
   *  implying a precision it does not have. */
  resolutionReason?: string;
}

/** Presentation options a widget carries. Free-form on the wire (`spec.options`)
 *  and never seen by the backend; this is the subset the renderers read. */
export interface WidgetOptions {
  /** Fixed decimal places. Unset means the adaptive formatter in `../spec.ts`. */
  decimals?: number;
  /** Draw the min→max envelope behind a single series. */
  band?: boolean;
  [key: string]: any;
}

export interface ChartProps {
  data: ChartData;
  options?: WidgetOptions;
  onEvents?: Record<string, (params: EChartsClickParams) => void>;
}

/** Column indices that hold numbers.
 *
 *  NOT in the original — and it is a fix, not just an addition. Their `line-chart`
 *  and `bar-chart` take EVERY column except the x axis as a series, which is only
 *  correct because a free-SQL result is assumed to be "labels first, numbers
 *  after". Our aggregate table carries a second STRING column (the device a point
 *  hangs off), and charting it would draw a junk series of NaNs. Detecting the
 *  numeric columns is both more robust and what makes one adapter able to feed
 *  the table and the charts from the same rows. */
export function numericColumns(data: ChartData): number[] {
  const { columns, rows, labelIndex } = data;
  return columns
    .map((_, i) => i)
    .filter((i) => i !== labelIndex)
    .filter((i) => rows.some((r) => typeof r[i] === "number"));
}
