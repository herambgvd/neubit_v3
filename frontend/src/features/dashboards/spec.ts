// The WIDGET SPEC, browser side — spec_version 2.
//
// This is the same object `backend/reading-writer/app/api/spec.py` validates and
// `sqlgen.py` turns into SQL. Read those for the reasoning; this file is the
// TypeScript view plus the small amount of presentation knowledge the backend
// deliberately does not have.
//
// WHAT CHANGED FROM v1 AND WHY
// ----------------------------
// v1 had an IoT vocabulary baked into it — `scope: points | device | category |
// all`, `metric: avg | … | count`. It could not chart a door-access event or a
// fire-panel state, so it could not be the platform's one builder. v2 names a
// DATASET from the registry and picks dimensions, measures and aggregates out of
// whatever that dataset publishes. Nothing in this file knows what a "point" is.
//
// The split to keep in mind while editing:
//
//   query.*    is CONTRACT. It goes to the backend, which validates it with
//              `extra="forbid"`. Adding a field here without adding it there is
//              a 400 naming the field, not a silent no-op.
//   viz        is ADVISORY. The backend never validates it; every result is the
//              same `{columns, rows}` table, so a new chart needs no backend
//              change at all.
//   options.*  is OURS ALONE. Presentation only, stored verbatim, never parsed
//              by the backend.
//
// **There is no `sql` field, here or anywhere.** The client sends STATE; the
// server generates the statement. See the backend spec module — that decision is
// not reopened.

export const SPEC_VERSION = 2;

export type Viz = "line" | "bar" | "stat" | "table";

/** Aggregates the builder can ask for. Ported from the reference product's
 *  `AGGREGATE_OPTIONS`, plus first/last which this platform's stores can answer.
 *  Which of them a given measure PERMITS comes from the dataset, not from here. */
export type Aggregate =
  | "count"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "first"
  | "last";

/** Filter operators. Ported verbatim from their `FILTER_OP_OPTIONS`. */
export type FilterOp =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "contains"
  | "like"
  | "in"
  | "between"
  | "is null"
  | "is not null";

export const AGGREGATE_LABEL: Record<Aggregate, string> = {
  count: "Count",
  count_distinct: "Count distinct",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  first: "First",
  last: "Last",
};

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  "=": "equals",
  "!=": "not equals",
  ">": "greater than",
  ">=": "greater or equal",
  "<": "less than",
  "<=": "less or equal",
  contains: "contains",
  like: "like (pattern)",
  in: "is one of",
  between: "between",
  "is null": "is empty",
  "is not null": "is not empty",
};

/** Operators that take no value at all — the form hides the value box for these. */
export const NO_VALUE_OPS: FilterOp[] = ["is null", "is not null"];

// ── the dataset registry, as the browser sees it ────────────────────────────

export interface DatasetDimension {
  key: string;
  label: string;
  type: "text" | "uuid" | "number" | "bool" | "time";
  description?: string;
}

export interface DatasetMeasure {
  key: string;
  label: string;
  type: string;
  /** Which aggregates this measure permits. A measure that must not be summed
   *  says so HERE, and the editor offers only what is listed. */
  aggregates: Aggregate[];
  description?: string;
  /** False when values are not comparable across series — the honesty rule
   *  (contract §4). The editor steers instead of letting the user discover it as
   *  a 422. */
  comparable: boolean;
  comparable_within: string[];
  incomparable_hint?: string;
}

export interface DatasetResolution {
  key: string;
  grain_sec: number;
  max_window_minutes: number | null;
  reason: string;
}

export interface Dataset {
  key: string;
  name: string;
  description: string;
  permission: string;
  dimensions: DatasetDimension[];
  measures: DatasetMeasure[];
  resolutions: DatasetResolution[];
  defaults: {
    series_by?: string | null;
    label_dimension?: string | null;
    measure?: string | null;
    aggregate?: Aggregate | null;
  };
}

// ── builder state ───────────────────────────────────────────────────────────

export interface SelectItem {
  dimension?: string | null;
  measure?: string | null;
  aggregate?: Aggregate | null;
  alias?: string | null;
}

export interface Filter {
  column: string;
  op: FilterOp;
  value?: string | number | null;
  value2?: string | number | null;
  values?: (string | number)[];
}

export interface Having {
  measure: string;
  aggregate: Aggregate;
  op: FilterOp;
  value?: number | null;
  value2?: number | null;
}

export interface OrderBy {
  select_index: number;
  dir: "asc" | "desc";
}

export interface SpecWindow {
  last_hours?: number | null;
  start?: string | null;
  end?: string | null;
}

export interface SpecQuery {
  dataset: string;
  resolution: string;
  window: SpecWindow;
  select: SelectItem[];
  time_series?: boolean;
  series_by?: string | null;
  series_label?: string | null;
  filters?: Filter[];
  filter_combinator?: "AND" | "OR";
  group_by?: string[];
  having?: Having[];
  order_by?: OrderBy[];
  limit: number;
  band?: boolean;
}

export interface WidgetSpec {
  spec_version: number;
  viz: string;
  query: SpecQuery;
  options?: Record<string, any>;
}

// ── the result ──────────────────────────────────────────────────────────────
//
// ONE shape, for every dataset and every chart: named columns and positional
// rows. It is the reference product's chart-data contract, which is what lets a
// chart type be added without touching the query layer.

export interface QueryResult {
  shape: "table";
  dataset: string;
  columns: string[];
  rows: (string | number | null)[][];
  label_index: number;
  resolution: string;
  resolution_reason: string;
  start: string;
  end: string;
  matched: number;
  truncated: boolean;
  band: [number | null, number | null][] | null;
  /** A read-only ECHO of the statement the SERVER generated. Shown in the
   *  builder so a person can see exactly what will run. Nothing anywhere accepts
   *  SQL back — see the backend spec module. */
  sql: string;
}

// ── steering ────────────────────────────────────────────────────────────────

/** Which chart types are time-series shaped. A line chart asks for buckets over
 *  time; a bar/stat/table asks for one row per group. Flipping this when the
 *  chart type changes is what stops a bar chart asking for time buckets it
 *  cannot draw. */
export const VIZ_TIME_SERIES: Record<Viz, boolean> = {
  line: true,
  bar: false,
  stat: false,
  table: false,
};

export const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: "1H" },
  { hours: 6, label: "6H" },
  { hours: 24, label: "24H" },
  { hours: 24 * 7, label: "7D" },
  { hours: 24 * 30, label: "30D" },
];

export const measureOf = (ds: Dataset | undefined, key?: string | null) =>
  ds?.measures.find((m) => m.key === key);
export const dimensionOf = (ds: Dataset | undefined, key?: string | null) =>
  ds?.dimensions.find((d) => d.key === key);

/** A blank widget over a dataset, using the dataset's OWN declared defaults —
 *  so a domain that registers tomorrow gets a sensible starting widget without
 *  anything here knowing its column names. */
export function newSpec(viz: Viz, ds?: Dataset): WidgetSpec {
  const timeSeries = VIZ_TIME_SERIES[viz];
  const measure = ds?.defaults.measure || ds?.measures[0]?.key || "";
  const m = measureOf(ds, measure);
  const aggregate = (ds?.defaults.aggregate && m?.aggregates.includes(ds.defaults.aggregate)
    ? ds.defaults.aggregate
    : m?.aggregates[0]) as Aggregate | undefined;
  const seriesBy = ds?.defaults.series_by || null;
  const label = ds?.defaults.label_dimension || null;

  const select: SelectItem[] = timeSeries
    ? [{ measure, aggregate }]
    : [
        ...(label ? [{ dimension: label } as SelectItem] : []),
        { measure, aggregate },
      ];

  return {
    spec_version: SPEC_VERSION,
    viz,
    query: {
      dataset: ds?.key || "",
      resolution: "auto",
      window: { last_hours: 6 },
      select,
      time_series: timeSeries,
      series_by: timeSeries ? seriesBy : null,
      series_label: timeSeries && seriesBy && label && label !== seriesBy ? label : null,
      filters: [],
      filter_combinator: "AND",
      group_by: timeSeries ? [] : label ? [label] : [],
      having: [],
      order_by: timeSeries ? [] : [{ select_index: select.length - 1, dir: "desc" }],
      limit: viz === "stat" ? 1 : viz === "line" ? 4 : 8,
    },
    options: {},
  };
}

/** Is this spec answerable? Mirrors the backend's rules so the editor can say
 *  what is missing instead of firing a request that comes back 422.
 *
 *  The comparability check is the one that matters: it is contract §4's "a value
 *  metric cannot be grouped across incomparable series", enforced on the server
 *  and MIRRORED here so the editor steers rather than traps. */
export function specIssue(spec: WidgetSpec, ds?: Dataset): string | null {
  const q = spec.query;
  if (!q.dataset) return "Pick a dataset.";
  if (!q.select.length) return "Add at least one column or measure.";
  if (!ds) return null;

  for (const item of q.select) {
    if (item.measure) {
      const m = measureOf(ds, item.measure);
      if (!m) return `This dataset has no measure “${item.measure}”.`;
      if (!item.aggregate || !m.aggregates.includes(item.aggregate)) {
        return `Pick an aggregate for “${m.label}”.`;
      }
    }
  }
  if (q.time_series && q.series_by && q.select.filter((s) => s.measure).length !== 1) {
    return "A split time-series draws exactly one measure.";
  }

  const pinned = new Set<string>([...(q.group_by || [])]);
  if (q.series_by) pinned.add(q.series_by);
  for (const f of q.filters || []) {
    if (f.op === "=" && f.value !== undefined && f.value !== null && `${f.value}` !== "") {
      pinned.add(f.column);
    }
    if (f.op === "in" && (f.values || []).length === 1) pinned.add(f.column);
  }
  for (const item of q.select) {
    if (!item.measure) continue;
    if (item.aggregate === "count" || item.aggregate === "count_distinct") continue;
    const m = measureOf(ds, item.measure);
    if (!m || m.comparable) continue;
    if (m.comparable_within.some((k) => pinned.has(k))) continue;
    const names = m.comparable_within
      .map((k) => dimensionOf(ds, k)?.label || k)
      .join(", ");
    return `“${AGGREGATE_LABEL[item.aggregate!]} of ${m.label}” cannot be computed across mixed series: ${
      m.incomparable_hint || "values from different series are not comparable."
    } Group by (or filter to) one of: ${names}.`;
  }
  return null;
}

/** Format a number for display. NO unit is ever appended — a dataset can name a
 *  unit column but nothing here invents one, and a fabricated "kW" on an axis is
 *  worse than a blank (contract §4). */
export function fmtValue(v: number | null | undefined, decimals?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (typeof decimals === "number") return v.toFixed(decimals);
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  // An exact integer prints as one. Without this a sample COUNT of 12 renders as
  // "12.0", which reads as a measurement rather than a tally.
  if (Number.isInteger(v)) return v.toLocaleString();
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs < 0.001) return v.toExponential(2);
  return v.toFixed(3);
}

// ── v1 → v2 migration (contract §6) ─────────────────────────────────────────
//
// Saved widgets exist against the v1, IoT-shaped spec (`scope` / `metric` /
// `group_by`). The backend migrates one on every read; this is the SAME
// translation on the browser side, and it is needed for a reason worth stating:
// the editor and the client-side validator both work against v2 state, so a v1
// spec reaching them unmigrated would show "Pick a dataset" over a widget that
// the server can answer perfectly well. Keeping the two in step is what makes a
// saved dashboard keep rendering rather than going blank.
//
// It is a mirror of `backend/reading-writer/app/api/builder.py::migrate_v1`. If
// one changes the other must; that is the cost of having a client-side validator
// at all, and it is cheaper than a dashboard that only reports its errors from
// the server.

const V1_METRIC: Record<string, [string, Aggregate]> = {
  avg: ["value", "avg"],
  min: ["value", "min"],
  max: ["value", "max"],
  first: ["value", "first"],
  last: ["value", "last"],
  // v1's `count` was SAMPLES — a tally of readings, not a physical quantity.
  count: ["samples", "sum"],
};

const V1_GROUP_DIM: Record<string, string> = {
  point: "point_id",
  device: "device_tag",
  category: "category",
};

function migrateV1(raw: any): WidgetSpec {
  const q = raw?.query || {};
  const scope = q.scope || {};
  const metric: string = q.metric || "avg";
  const [measure, aggregate] = V1_METRIC[metric] || ["value", "avg"];
  const filters: Filter[] = [];

  const stype = scope.type || "points";
  if (stype === "points") {
    filters.push({ column: "point_id", op: "in", values: (scope.point_ids || []).map(String) });
  } else if (stype === "device") {
    if (scope.device_id) filters.push({ column: "device_id", op: "=", value: String(scope.device_id) });
    else if (scope.device_tag) filters.push({ column: "device_tag", op: "=", value: scope.device_tag });
  } else if (stype === "category") {
    // v1: category "" meant the points nothing has classified.
    if (scope.category === "" || scope.category == null) {
      filters.push({ column: "category", op: "is null" });
    } else {
      filters.push({ column: "category", op: "=", value: scope.category });
    }
  }
  if (metric !== "count") {
    // v1 restricted value metrics to numeric points: a text point has no number,
    // and including it would show a permanently blank row.
    filters.push({ column: "reading_kind", op: "=", value: "num" });
  }

  const window = q.window || { last_hours: 6 };
  const limit = Number(q.limit || 12) || 12;
  const viz = raw?.viz || "line";

  let query: SpecQuery;
  if ((q.kind || "series") === "series") {
    query = {
      dataset: "iot_readings",
      resolution: q.rollup || "auto",
      window,
      time_series: true,
      series_by: "point_id",
      series_label: "point_tag",
      select: [{ measure, aggregate }],
      filters,
      limit: Math.min(limit, 24),
      band: !!raw?.options?.band,
    };
  } else {
    const dim = V1_GROUP_DIM[q.group_by || "point"] || "point_id";
    const select: SelectItem[] =
      dim === "point_id"
        ? [
            { dimension: "point_tag", alias: "point" },
            { dimension: "device_tag", alias: "device" },
            { measure, aggregate, alias: metric },
            { measure: "samples", aggregate: "sum", alias: "samples" },
          ]
        : [
            { dimension: dim, alias: q.group_by },
            { measure: "samples", aggregate: "sum", alias: "samples" },
          ];
    query = {
      dataset: "iot_readings",
      resolution: q.rollup || "auto",
      window,
      time_series: false,
      select,
      group_by: dim === "point_id" ? ["point_id", "point_tag", "device_tag"] : [dim],
      order_by: [{ select_index: select.length - 1, dir: "desc" }],
      filters,
      limit,
    };
  }

  return { spec_version: SPEC_VERSION, viz, query, options: { ...(raw?.options || {}) } };
}

/** Bring a stored spec up to `SPEC_VERSION`. The ONE place that happens on the
 *  browser side. A spec from the FUTURE is left alone — the server refuses it
 *  loudly, which is better than this build guessing at fields it has never
 *  heard of. */
export function migrateSpec(raw: WidgetSpec | any): WidgetSpec {
  if (!raw || typeof raw !== "object") return raw;
  const v = typeof raw.spec_version === "number" ? raw.spec_version : SPEC_VERSION;
  if (v <= 1) return migrateV1(raw);
  return raw as WidgetSpec;
}
