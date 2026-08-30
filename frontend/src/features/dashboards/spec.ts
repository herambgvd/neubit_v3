// The WIDGET QUERY SPEC, browser side.
//
// This is the same object `backend/reading-writer/app/api/spec.py` validates and
// executes — read that file for the reasoning (why a structured spec instead of
// user-authored SQL, and what makes it forward-compatible). This file is the
// TypeScript view of it plus the small amount of presentation knowledge the
// backend deliberately does not have.
//
// The split to keep in mind while editing:
//
//   query.*    is CONTRACT. It goes to the backend, which validates it with
//              `extra="forbid"`. Adding a field here without adding it there is
//              a 400 naming the field, not a silent no-op.
//   viz        is ADVISORY. The backend never validates it: it only cares
//              whether `query.kind` is `series` or `aggregate`. A new chart that
//              reuses a shape needs nothing on the backend at all.
//   options.*  is OURS ALONE. Presentation only, stored verbatim, never parsed
//              by the backend. An option added here cannot break a saved
//              dashboard on an older backend.
//
// SPEC_VERSION must move in lockstep with the backend's. It exists so a
// dashboard saved by a newer build is REFUSED with a clear message instead of
// being half-rendered by an older one.

export const SPEC_VERSION = 1;

export type Viz = "line" | "bar" | "stat" | "table";
export type QueryKind = "series" | "aggregate";
export type Metric = "avg" | "min" | "max" | "last" | "first" | "count";
export type Rollup = "auto" | "1m" | "1h" | "raw";
export type ScopeType = "points" | "device" | "category" | "all";
export type GroupBy = "point" | "device" | "category";

export interface SpecScope {
  type: ScopeType;
  point_ids?: string[];
  device_id?: string | null;
  device_tag?: string | null;
  /** "" is meaningful: the points nothing has classified. */
  category?: string | null;
}

export interface SpecWindow {
  last_hours?: number | null;
  start?: string | null;
  end?: string | null;
}

export interface SpecQuery {
  kind: QueryKind;
  scope: SpecScope;
  metric: Metric;
  rollup: Rollup;
  window: SpecWindow;
  group_by: GroupBy;
  limit: number;
}

export interface WidgetSpec {
  spec_version: number;
  viz: string;
  query: SpecQuery;
  options?: Record<string, any>;
}

// ── Result shapes ───────────────────────────────────────────────────────────
// Two, matching the backend. Four chart types render them between them, which is
// what decouples "add a chart" from "change the backend".

export interface ResultBucket {
  t: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  first: number | null;
  last: number | null;
  txt_last: string | null;
}

export interface ResultSeries {
  point_id: string;
  point_tag: string | null;
  device_tag: string | null;
  /** As STORED. null on this deployment and that is correct — never substituted. */
  unit: string | null;
  buckets: ResultBucket[];
}

export interface ResultRow {
  key: string;
  label: string;
  sublabel: string | null;
  value: number | null;
  samples: number;
  unit: string | null;
}

export interface QueryResult {
  shape: QueryKind;
  metric: Metric;
  resolution: string;
  resolution_reason: string;
  start: string;
  end: string;
  series: ResultSeries[];
  rows: ResultRow[];
  truncated: boolean;
  matched: number;
}

// ── Which shape a chart needs ───────────────────────────────────────────────
//
// The ONE place that maps a visualisation to a result shape. The widget editor
// reads it so switching chart type flips `query.kind` automatically instead of
// leaving a bar chart asking for time buckets it cannot draw.

export const VIZ_KIND: Record<Viz, QueryKind> = {
  line: "series",
  bar: "aggregate",
  stat: "aggregate",
  table: "aggregate",
};

// (The chart-type catalog — label, icon and hint per `viz` — lives in
// `widget-types.ts`, ported from the standalone product, so the palette and the
// editor cannot offer different sets.)

export const METRIC_META: Record<Metric, { label: string; blurb: string }> = {
  avg: { label: "Average", blurb: "Sample-weighted mean across the window." },
  min: { label: "Minimum", blurb: "Lowest value seen in the window." },
  max: { label: "Maximum", blurb: "Highest value seen in the window." },
  first: { label: "First", blurb: "Oldest value in the window." },
  last: { label: "Last", blurb: "Newest value in the window." },
  count: { label: "Samples", blurb: "How many readings arrived. Not a physical quantity." },
};

export const ROLLUP_META: Record<Rollup, { label: string; blurb: string }> = {
  auto: {
    label: "Auto",
    blurb: "1-minute rollup up to 3 hours, 1-hour beyond. What every built screen uses.",
  },
  "1m": { label: "1 minute", blurb: "readings_1m — materialized, the newest ~2 min may be missing." },
  "1h": { label: "1 hour", blurb: "readings_1h — real-time, the current partial hour is included." },
  raw: { label: "Raw", blurb: "Every sample. Limited to a 3-hour window by the server." },
};

export const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: "1H" },
  { hours: 6, label: "6H" },
  { hours: 24, label: "24H" },
  { hours: 24 * 7, label: "7D" },
  { hours: 24 * 30, label: "30D" },
];

/** A metric that can only be compared across differently-measured points.
 *  Mirrors the backend rule; the editor greys the option rather than letting a
 *  user discover it as a 400. */
export const GROUPED_METRICS: Metric[] = ["count"];

export function canGroup(metric: Metric, groupBy: GroupBy): boolean {
  return groupBy === "point" || GROUPED_METRICS.includes(metric);
}

/** A blank widget. `line` over the last 6 hours is the least surprising default
 *  and matches what the two hand-built BI consoles show. */
export function newSpec(viz: Viz = "line"): WidgetSpec {
  return {
    spec_version: SPEC_VERSION,
    viz,
    query: {
      kind: VIZ_KIND[viz],
      scope: { type: "points", point_ids: [] },
      metric: "avg",
      rollup: "auto",
      window: { last_hours: 6 },
      group_by: "point",
      limit: viz === "stat" ? 1 : viz === "line" ? 4 : 8,
    },
    options: {},
  };
}

/** Is this spec answerable? Mirrors the backend's scope rules so the editor can
 *  say "pick a point" instead of firing a request that 400s. */
export function specIssue(spec: WidgetSpec): string | null {
  const { scope, metric, group_by } = spec.query;
  if (scope.type === "points" && !(scope.point_ids || []).length) {
    return "Pick at least one point.";
  }
  if (scope.type === "device" && !scope.device_id && !scope.device_tag) {
    return "Pick a device.";
  }
  if (scope.type === "category" && scope.category === null) {
    return "Pick a category.";
  }
  if (!canGroup(metric, group_by)) {
    return `“${METRIC_META[metric].label}” cannot be grouped by ${group_by}: values from different points are not comparable, because no unit is on the wire. Group by point, or use Samples.`;
  }
  return null;
}

/** Format a reading for display. NO unit is ever appended — `points.unit` is null
 *  for every point on this deployment because the source payloads carry none, and
 *  a fabricated "kW" is worse than a blank one (pipeline contract §11/§12). */
export function fmtValue(v: number | null | undefined, decimals?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (typeof decimals === "number") return v.toFixed(decimals);
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  // An exact integer prints as one. Without this a sample COUNT of 12 renders as
  // "12.0", which reads as a measurement rather than a tally — and the table's
  // samples column is nothing but counts.
  if (Number.isInteger(v)) return v.toLocaleString();
  if (abs >= 1_000_000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs < 0.001) return v.toExponential(2);
  return v.toFixed(3);
}
