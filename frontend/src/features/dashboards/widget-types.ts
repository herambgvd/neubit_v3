// The catalog of widget types shown in the palette and the config panel.
//
// PORTED from `frontend-next/src/lib/dashboard/widget-types.ts`. The design is
// theirs and is worth keeping: ONE array of `{type, label, icon, hint}` that both
// the "add a widget" palette and the editor's chart picker render from, so the
// two can never offer different sets.
//
// Changed:
// * **`lucide-react` → `@iconify/react`.** This console has no lucide dependency
//   and uses heroicons names throughout; `icon` is therefore a string key, not a
//   `LucideIcon` component.
// * **Seven types, not eleven.** See the ported/skipped list below.
// * `kpi` is spelled `stat` here, matching the label the rest of this console
//   uses for a single-number tile.
// * **This file is now the ONE registry.** `spec.ts` derives `Viz` and `VIZ_KIND`
//   from the array below rather than keeping a second hand-maintained list, so
//   adding a chart type is one entry here plus its renderer — it can no longer
//   half-land, registered in the palette but unknown to the editor.
//
// `hint` is shown under the label in the picker. It says what the widget is FOR,
// which is the thing a person choosing between seven of them actually needs.
//
// ── Which of the reference's eleven came across, and why ────────────────────
//
// PORTED  line, bar, table, kpi→stat  (the original four)
// PORTED  pie      — share of a countable total: events per camera, alarms per
//                    zone, samples per device. Refuses to draw a share of a
//                    non-additive metric; see `charts/pie-chart.tsx`.
// PORTED  gauge    — one value read against a range that is actually in the
//                    data (or one the author states), for "how close to the
//                    worst in this group". Refuses a range it would have to
//                    invent; see `charts/gauge-chart.tsx`.
// PORTED  heatmap  — time × entity density. The single most useful addition on
//                    this platform: 12 cameras' event counts by hour, or 30
//                    sensors' readings across a week, in one tile. It is the
//                    only chart here that scales past the ~6 series a line
//                    chart can carry legibly.
//
// SKIPPED bar3d, scatter3d — both need `echarts-gl`, a second ~600 kB renderer
//                    on top of ECharts, and a 3-D perspective makes the bar you
//                    are looking at read taller than the one behind it. This
//                    console already carries video, floor plans and access
//                    control; a chart type that misreads magnitudes is not
//                    worth the download.
// SKIPPED candle   — an OHLC financial chart. Worth noting honestly that our
//                    rollup buckets DO carry first/min/max/last, so a per-bucket
//                    range chart is expressible from this data; but that is a
//                    new chart designed for telemetry, not this one ported, and
//                    it needs `adapt.ts` to emit a shape nothing asks for yet.
//                    Recorded rather than half-built.
// SKIPPED map      — a world choropleth keyed on country name. Nothing in
//                    `neubit_reporting` carries geography: the executor's
//                    `ResultRow` is `{key,label,sublabel,value,samples,unit}`
//                    and `ResultSeries` is point/device tags — no latitude, no
//                    longitude, no country. Site floor-plan coordinates live in
//                    the VMS store, which the builder is banned from reading
//                    (contract §1). It would also need a GeoJSON asset fetched
//                    at runtime. A choropleth here could only be drawn by
//                    inventing the geography, which contract §4 forbids.

export interface WidgetTypeDef {
  type: string;
  label: string;
  /** An @iconify/react name (heroicons), not a component. */
  icon: string;
  hint: string;
  /** Which result shape the executor must return for it. `spec.VIZ_KIND` is
   *  built from this field, so the two cannot disagree. */
  shape: "series" | "aggregate";
}

export const WIDGET_TYPES = [
  {
    type: "line",
    label: "Time series",
    icon: "heroicons:presentation-chart-line",
    hint: "How values moved across the window, one line per point.",
    shape: "series",
  },
  {
    type: "heatmap",
    label: "Heatmap",
    icon: "heroicons:squares-2x2",
    hint: "Time across, one row per point. Reads many more series than a line chart can.",
    shape: "series",
  },
  {
    type: "bar",
    label: "Bar",
    icon: "heroicons:chart-bar",
    hint: "Compare points, devices or categories over the window.",
    shape: "aggregate",
  },
  {
    type: "pie",
    label: "Share",
    icon: "heroicons:chart-pie",
    hint: "What fraction of a countable total each group accounts for.",
    shape: "aggregate",
  },
  {
    type: "gauge",
    label: "Gauge",
    icon: "heroicons:signal",
    hint: "One value against the range the rest of the scope covers.",
    shape: "aggregate",
  },
  {
    type: "stat",
    label: "Stat",
    icon: "heroicons:hashtag",
    hint: "A single headline number, with the samples behind it.",
    shape: "aggregate",
  },
  {
    type: "table",
    label: "Table",
    icon: "heroicons:table-cells",
    hint: "Every row of the aggregate, values and sample counts.",
    shape: "aggregate",
  },
] as const satisfies readonly WidgetTypeDef[];

/** The `viz` strings this build knows. Derived, so the union cannot drift from
 *  the array the palette renders. */
export type WidgetTypeName = (typeof WIDGET_TYPES)[number]["type"];

/** `viz` → the result shape the executor must return. The one mapping; `spec.ts`
 *  re-exports it as `VIZ_KIND` for the call sites that already name it that. */
export const WIDGET_TYPE_SHAPE = Object.fromEntries(
  WIDGET_TYPES.map((w) => [w.type, w.shape]),
) as Record<WidgetTypeName, "series" | "aggregate">;

export const WIDGET_TYPE_OPTIONS = WIDGET_TYPES.map((w) => ({ value: w.type, label: w.label }));

export const widgetTypeDef = (type: string): WidgetTypeDef | undefined =>
  WIDGET_TYPES.find((w) => w.type === type);
