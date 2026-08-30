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
// * **Four types, not eleven.** Theirs lists pie, gauge, candlestick, heatmap,
//   world map, 3D bar and 3D scatter. Every one of those needs `echarts-gl` or a
//   geo dataset, and — more to the point — needs data this store cannot honestly
//   supply: a gauge needs a target, a choropleth needs geography, a candlestick
//   needs OHLC. Four types that work beat eight that half-work, and the executor
//   already accepts any `viz` string, so adding a fifth later is additive.
// * `kpi` is spelled `stat` here, matching the label the rest of this console
//   uses for a single-number tile.
//
// `hint` is shown under the label in the picker. It says what the widget is FOR,
// which is the thing a person choosing between four of them actually needs.

export interface WidgetTypeDef {
  type: string;
  label: string;
  /** An @iconify/react name (heroicons), not a component. */
  icon: string;
  hint: string;
  /** Which result shape the executor must return for it. Mirrors `spec.VIZ_KIND`
   *  and is repeated here so the palette can group by shape without importing
   *  the spec module. */
  shape: "series" | "aggregate";
}

export const WIDGET_TYPES: WidgetTypeDef[] = [
  {
    type: "line",
    label: "Time series",
    icon: "heroicons:presentation-chart-line",
    hint: "How values moved across the window, one line per point.",
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
];

export const WIDGET_TYPE_OPTIONS = WIDGET_TYPES.map((w) => ({ value: w.type, label: w.label }));

export const widgetTypeDef = (type: string): WidgetTypeDef | undefined =>
  WIDGET_TYPES.find((w) => w.type === type);
