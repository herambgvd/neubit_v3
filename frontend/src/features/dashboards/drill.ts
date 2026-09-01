// DRILL-DOWN — click a bar or a slice and see what is behind it.
//
// The reference does this by running a SECOND SQL query the widget's author
// wrote (`drill-dialog.tsx`: `api.runQuery(drill.datasourceId, drill.query…)`),
// falling back to client-side filtering of the rows already on screen. So a
// drill-down there is a whole second authored artefact that can drift from the
// chart it hangs off, and its safety is the safety of another SQL string.
//
// With our model it is simpler AND stronger: a widget already stores builder
// STATE, so drilling is a PURE FUNCTION FROM STATE TO STATE. Take the widget's
// query, pin the clicked value as one more filter, drop the grouping that
// produced the clicked point and group by something else instead. Nothing new is
// authored, nothing can drift, and the derived query goes down the one executor
// path with the one set of honesty rules.
//
// Two consequences worth stating:
//
//  * The clicked value becomes a `Filter.value`, which the server BINDS. A series
//    literally named `'; DROP TABLE readings; --` drills to a query that finds
//    nothing, not to a query that runs something.
//  * The drill result carries its own `resolution` and `resolution_reason`, like
//    every other result, because it went through the same executor. The
//    reference's fallback path — filtering the rows already on screen — silently
//    presents rollup buckets as detail; that path is not reproduced.

import { dimensionOf, measureOf } from "./spec";
import type { Dataset, SelectItem, WidgetSpec } from "./spec";

/** What a click on a chart identified. */
export interface DrillPoint {
  /** The category or series NAME under the cursor, as drawn. */
  name: string;
  /** The value, when the chart had one. Display only. */
  value?: number | null;
}

/** How many rows a drill shows. A drill is a look, not an export. */
export const DRILL_LIMIT = 50;

/** Which DIMENSION a clicked point identifies, given the widget that drew it.
 *
 *  Two shapes, and neither is a guess:
 *
 *   * a grouped chart (bar, pie, table) draws one row per group, and the label
 *     column is the widget's first dimension select item — so the clicked label
 *     is a value of that dimension;
 *   * a split time-series draws one line per series, labelled by `series_label`
 *     when the dataset names one and by `series_by` otherwise — so the clicked
 *     series name is a value of whichever of those produced the legend.
 *
 *  Anything else returns null, and the chart is simply not drillable. Inventing
 *  a dimension to pin would produce a detail view of the wrong thing, which is
 *  worse than no detail view. */
export function drillDimension(spec: WidgetSpec): string | null {
  const q = spec.query;
  if (q.time_series) {
    if (!q.series_by) return null;
    return q.series_label || q.series_by;
  }
  const first = (q.select || []).find((s) => s.dimension);
  return first?.dimension || null;
}

/** Can this widget be drilled at all? Drives whether the tile shows the affordance. */
export function isDrillable(spec: WidgetSpec): boolean {
  return !!drillDimension(spec);
}

/** The dimension a drill breaks the pinned value down BY, by default.
 *
 *  The first dimension of the dataset that is not the one just pinned and is not
 *  already grouped by — i.e. the next question a person is likely to have. The
 *  dialog lets them change it; this only has to be a sensible opening move. */
export function defaultBreakdown(spec: WidgetSpec, ds: Dataset | undefined, pinned: string): string | null {
  if (!ds) return null;
  const used = new Set<string>([pinned, ...(spec.query.group_by || [])]);
  const free = ds.dimensions.filter((d) => !used.has(d.key));
  // Prefer a dimension a person can READ. A dataset's first free dimension is
  // very often an id (`point_id`), and a detail table of forty uuids answers
  // nothing — the tag beside it is the same breakdown in words. Ids remain
  // selectable in the picker; they are just not the opening move.
  const readable = free.find((d) => d.type !== "uuid");
  return (readable || free[0])?.key || null;
}

/** Widget state + a clicked point → the DETAIL widget's state.
 *
 *  Pure. It reads no network, writes no SQL, and returns a spec the ordinary
 *  executor answers — which is the whole reason this is fifty lines rather than
 *  the reference's two code paths and a fallback. */
export function deriveDrillSpec(
  spec: WidgetSpec,
  ds: Dataset | undefined,
  pinnedDimension: string,
  pinnedValue: string,
  breakdown: string | null,
): WidgetSpec {
  const q = spec.query;

  // Keep the widget's MEASURES — the number the person was looking at is the
  // number they want broken down. Its dimensions go: they described the grouping
  // that has just been replaced.
  const measures: SelectItem[] = (q.select || []).filter((s) => s.measure);
  const kept = measures.length
    ? measures
    : // A widget that selected no measure at all (a plain dimension table).
      // Fall back to the dataset's default measure so the detail has a number in
      // it; if the dataset declares none, the detail is a list of values, which
      // is still an honest answer.
      (() => {
        const key = ds?.defaults.measure || ds?.measures[0]?.key;
        const m = measureOf(ds, key);
        return key && m ? [{ measure: key, aggregate: m.aggregates[0] }] : [];
      })();

  const breakdownItem: SelectItem[] = breakdown ? [{ dimension: breakdown }] : [];
  const select = [...breakdownItem, ...kept];

  return {
    spec_version: spec.spec_version,
    viz: "table",
    query: {
      dataset: q.dataset,
      resolution: q.resolution,
      window: q.window,
      time_series: false,
      series_by: null,
      series_label: null,
      select,
      group_by: breakdown ? [breakdown] : [],
      // The pin is one more ordinary filter. The server binds its value like
      // every other value; there is no path by which a series name becomes SQL.
      filters: [
        ...(q.filters || []),
        { column: pinnedDimension, op: "=" as const, value: pinnedValue },
      ],
      filter_combinator: "AND",
      having: [],
      order_by: select.length && kept.length ? [{ select_index: select.length - 1, dir: "desc" }] : [],
      limit: DRILL_LIMIT,
      // The drill inherits the widget's opt-outs. A tile that deliberately shows
      // the whole estate drills into the whole estate; changing that silently
      // would make the detail disagree with the chart it came from.
      ignore_filters: q.ignore_filters,
      ignore_all_filters: q.ignore_all_filters,
      ignore_window: q.ignore_window,
    },
    // Number formatting travels with the drill so the detail's numbers are
    // spelled the way the chart's were.
    options: { ...(spec.options || {}) },
  };
}

/** A human label for a dimension key, for the dialog's heading. */
export function dimensionLabel(ds: Dataset | undefined, key: string): string {
  return dimensionOf(ds, key)?.label || key;
}
