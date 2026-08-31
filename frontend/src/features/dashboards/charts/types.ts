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
  /** HOW each column was aggregated — `"sum"`, `"avg"`, `"count"`, … — aligned
   *  with `columns`, `null` for a column that is a dimension rather than a
   *  measure, and the whole field `undefined` when the caller does not know.
   *
   *  This is an ADDITION to the contract and it is worth saying why, because the
   *  rest of `ChartData` is deliberately just names and numbers. A pie chart
   *  claims that its slices are PARTS OF A WHOLE. That claim is true of a sum or
   *  a count and false of an average — eight points' average voltages do not add
   *  up to anything, and drawing them as a ring asserts a total the data never
   *  contained (contract §4). Nothing else in `{columns, rows}` can distinguish
   *  the two: since the query layer was generalised the executor names the value
   *  column after the MEASURE (`"Reading value"`), not the aggregate, so
   *  `sum(value)` and `avg(value)` come back under identical column names.
   *
   *  So the aggregate is carried explicitly, and every part of it degrades to
   *  "unknown" rather than to a guess: a producer that does not fill it in leaves
   *  it `undefined`, and a chart that cannot prove a column is non-additive draws
   *  it rather than refusing on a hunch. */
  aggregates?: (string | null)[];
  /** The same query over an earlier, equal-length window — present only when the
   *  widget asked for one, and ALIGNED index-for-index with `rows` by the server.
   *
   *  It is carried on `ChartData` rather than derived in a renderer for the same
   *  reason `aggregates` is: a chart cannot work out from `{columns, rows}` alone
   *  which of its rows is "the same thing, a week ago", and every renderer that
   *  guessed would guess differently. NULL means what it means everywhere else —
   *  no value, not zero — so a missing previous value draws as absent and its
   *  change is not shown at all. */
  comparison?: ChartComparison;
}

export interface ChartComparison {
  /** One line for a caption: "the same window a week earlier". */
  label: string;
  /** Aligned to `ChartData.rows`; a row of nulls means that group had no row in
   *  the earlier period. */
  rows: Cell[][];
  /** Fractional change per cell — `0.12` is +12%. NULL where the change is
   *  undefined: either side missing, or a previous value of exactly zero. */
  deltaPct: (number | null)[][];
  /** The earlier window returned nothing AT ALL. Different from "no change". */
  noData: boolean;
  /** Groups that existed then and do not now. */
  onlyPrevious: number;
}

/** Presentation options a widget carries. Free-form on the wire (`spec.options`)
 *  and never seen by the backend; this is the subset the renderers read. */
export interface WidgetOptions {
  /** Fixed decimal places. Unset means the adaptive formatter in `../spec.ts`. */
  decimals?: number;
  /** Draw the min→max envelope behind a single series. */
  band?: boolean;
  /** Gauge only: the range the value is read against. STATED by the widget's
   *  author — the gauge invents neither, and falls back to the spread of the
   *  rest of the scope rather than to a 0–100 dial nothing measured. */
  min?: number;
  max?: number;
  /** Heatmap only: colour every row on ONE absolute scale instead of
   *  normalising each row to its own min→max. Opt-in, because a shared ramp
   *  across points is only meaningful if they measure the same thing, and
   *  nothing on the wire says they do. */
  sharedScale?: boolean;
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
