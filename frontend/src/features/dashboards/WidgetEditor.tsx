"use client";

// The widget editor — the no-code half of the builder.
//
// It is a form over the builder state, and every control corresponds to one
// field of `spec.query`. That correspondence is the point: there is nothing to
// learn beyond "what am I looking at, which number, over what window", and there
// is no text box in which a user can type SQL — because there is no endpoint that
// would accept it.
//
// Four things it does that matter more than the layout:
//
// 1. **It is dataset-driven, end to end.** The dataset list, its dimensions, its
//    measures and the aggregates each measure permits all come from the registry.
//    Nothing here names a column. A domain that registers a dataset this
//    afternoon is buildable this afternoon, with no release of this console —
//    which is the whole point of the generalisation.
//
// 2. **The preview is the real widget.** The right-hand pane renders
//    `<WidgetBody>` — the same component, the same fetch, the same error
//    handling as the canvas. A separate preview renderer would drift, and it
//    would drift first on exactly the states (empty window, refused aggregate) a
//    builder most needs to see before saving.
//
// 3. **It steers instead of trapping.** Changing the chart type rewrites
//    `time_series`, because a bar chart asking for time buckets is a spec that
//    can only 422. An aggregate a measure does not permit is not offered at all.
//    An aggregate over incomparable series is called out in words, with what to
//    do instead.
//
// 4. **It shows the generated SQL, read-only.** The server generated it and sent
//    it back on the result. Seeing it is how a person builds trust in a no-code
//    builder; being able to EDIT it is how a browser ends up sending SQL, which
//    is why this is an echo and not a text area.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Input, Modal, Select } from "@/components/ui/kit";
import { Segmented } from "@/components/console";

import { datasets as datasetsApi } from "./api";
import type { DashboardConfig } from "./dashboard-context";
import { DEFAULT_SIZE } from "./constants";
import QueryBuilderForm from "./QueryBuilderForm";
import WidgetCalcFields from "./widget-calc-fields";
import WidgetRefresh from "./widget-refresh";
import WidgetNumberFormat from "./widget-number-format";
import { VIZ_TIME_SERIES, WINDOWS, migrateSpec, newSpec, specIssue } from "./spec";
import type { Dataset, QueryResult, SpecQuery, Viz, WidgetSpec } from "./spec";
import { WIDGET_TYPES, widgetTypeDef } from "./widget-types";
import { WidgetBody } from "./ChartWidget";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
        {children}
      </span>
      {hint ? <span className="truncate text-[10px] text-nb-faint/70">{hint}</span> : null}
    </div>
  );
}

export interface EditorValue {
  title: string;
  spec: WidgetSpec;
}

export default function WidgetEditor({
  open,
  initial,
  onClose,
  onSave,
  saving,
  config,
}: {
  open: boolean;
  initial?: EditorValue | null;
  /** The dashboard's filters and variables, so this widget can bind a filter to
   *  a variable and opt out of the page's filters one at a time. */
  config?: DashboardConfig;
  onClose: () => void;
  onSave: (value: EditorValue & { size: { w: number; h: number } }) => void;
  saving?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState<WidgetSpec | null>(null);
  const [showSql, setShowSql] = useState(false);
  // The last result the PREVIEW got, kept only so the generated-SQL echo has
  // something to show. It is the server's statement travelling back, never a
  // client-authored one going out.
  const [lastResult, setLastResult] = useState<QueryResult | null>(null);

  // What this caller may chart. Registered as DATA in the reporting store, so
  // this list is discovered, never hard-coded.
  const dsQ = useQuery<{ items: Dataset[] }>({
    queryKey: ["bi-datasets"],
    queryFn: () => datasetsApi.list(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const allDatasets = dsQ.data?.items || [];

  // Reset from `initial` whenever the dialog OPENS, not on every render: editing
  // a widget must start from what is saved, and typing must not be clobbered.
  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    // Editing a v1 widget opens the v2 form on the migrated state, so a person
    // can adjust it and save it forward rather than being told to rebuild it.
    setSpec(initial?.spec ? migrateSpec(structuredClone(initial.spec)) : null);
    setShowSql(false);
  }, [open, initial]);

  // A NEW widget waits for the dataset list, then starts on the first dataset the
  // caller can read — rather than guessing a key that may not exist here.
  //
  // `!initial` is load-bearing, not defensive: the reset effect above sets state
  // asynchronously, so on the render where an EXISTING widget is opened `spec` is
  // still null here. Without the guard this would race it and replace a saved
  // widget's query with a blank one on the first dataset in the list.
  useEffect(() => {
    if (!open || initial || spec || !allDatasets.length) return;
    setSpec(newSpec("line", allDatasets[0]));
  }, [open, initial, spec, allDatasets]);

  const ds = useMemo(
    () => allDatasets.find((d) => d.key === spec?.query.dataset),
    [allDatasets, spec?.query.dataset],
  );

  const patchQuery = (patch: Partial<SpecQuery>) =>
    setSpec((s) => (s ? { ...s, query: { ...s.query, ...patch } } : s));

  const setViz = (viz: Viz) =>
    setSpec((s) => {
      if (!s) return s;
      const timeSeries = VIZ_TIME_SERIES[viz];
      if (timeSeries === s.query.time_series) {
        return { ...s, viz, query: { ...s.query, limit: viz === "stat" ? 1 : s.query.limit } };
      }
      // The shape changed, so the select list has to. Rebuilding from the
      // dataset's defaults is honest: a time-series' single measure and a
      // grouped table's label+measure are genuinely different queries, and
      // silently keeping half of one is what produces a widget that 422s.
      const fresh = newSpec(viz, ds);
      return { ...fresh, viz, options: s.options, query: { ...fresh.query, window: s.query.window } };
    });

  const setDataset = (key: string) => {
    const next = allDatasets.find((d) => d.key === key);
    if (!next || !spec) return;
    // Every column reference belongs to the OLD dataset, so the query is rebuilt
    // rather than carried across and left naming columns that do not exist.
    const fresh = newSpec(spec.viz as Viz, next);
    setSpec({ ...fresh, options: spec.options, query: { ...fresh.query, window: spec.query.window } });
  };

  const issue = spec ? specIssue(spec, ds) : "Loading datasets…";
  const resolutions = ds?.resolutions || [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={initial ? "Edit widget" : "Add widget"}
      subtitle="Pick a dataset, then the columns and numbers. No query language — the server writes the SQL from these choices."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              spec &&
              onSave({ title, spec, size: DEFAULT_SIZE[spec.viz] || { w: 4, h: 4 } })
            }
            disabled={!!issue || !!saving || !spec}
            icon={saving ? "svg-spinners:180-ring" : "heroicons:check"}
          >
            {initial ? "Save widget" : "Add widget"}
          </Button>
        </>
      }
    >
      {!spec ? (
        <div className="px-2 py-8 text-center text-[11.5px] text-nb-faint">
          {dsQ.isError
            ? "No datasets could be loaded. You may not have permission to read any."
            : !dsQ.isLoading && !allDatasets.length
              ? "No datasets are registered for you to chart yet."
              : "Loading datasets…"}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── the form ───────────────────────────────────────────────── */}
          <div className="space-y-3.5">
            <Input
              label="Title"
              value={title}
              onChange={(e: any) => setTitle(e.target.value)}
              placeholder="e.g. Main incomer current"
            />

            <Select
              label="Dataset"
              hint={ds?.description}
              value={spec.query.dataset}
              onChange={(e: any) => setDataset(e.target.value)}
              options={allDatasets.map((d) => ({ value: d.key, label: d.name }))}
            />

            <div>
              <FieldLabel hint={widgetTypeDef(spec.viz)?.hint}>Chart</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {WIDGET_TYPES.map((w) => (
                  <button
                    key={w.type}
                    type="button"
                    title={w.hint}
                    onClick={() => setViz(w.type as Viz)}
                    className={`flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] transition ${
                      spec.viz === w.type
                        ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
                        : "border-nb-line text-nb-faint hover:text-nb-muted"
                    }`}
                  >
                    <Icon icon={w.icon} className="text-[14px]" />
                    {w.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <FieldLabel>Window</FieldLabel>
              <Segmented
                value={String(spec.query.window.last_hours ?? 6)}
                onChange={(v: string) => patchQuery({ window: { last_hours: Number(v) } })}
                options={WINDOWS.map((w) => ({ value: String(w.hours), label: w.label }))}
              />
            </div>

            <Select
              label="Resolution"
              // The dataset's OWN stores, with its own words for what each costs
              // in freshness. Nothing here knows what a "1h rollup" is.
              hint={
                resolutions.find((r) => r.key === spec.query.resolution)?.reason ||
                "the store picks itself from the window"
              }
              value={spec.query.resolution}
              onChange={(e: any) => patchQuery({ resolution: e.target.value })}
              options={[
                { value: "auto", label: "Auto" },
                ...resolutions.map((r) => ({
                  value: r.key,
                  label:
                    r.key +
                    (r.max_window_minutes ? ` · up to ${r.max_window_minutes} min` : ""),
                })),
              ]}
            />

            <div>
              <FieldLabel hint="worked out from the columns above, in the browser">
                Calculated fields
              </FieldLabel>
              <WidgetCalcFields
                options={spec.options || {}}
                // The columns the PREVIEW actually returned, so a typo is named
                // against real column names rather than guessed ones.
                columns={lastResult?.columns || []}
                onChange={(next) => setSpec((sp) => (sp ? { ...sp, options: next } : sp))}
              />
            </div>

            <div>
              <FieldLabel hint="how these numbers are spelled">Number format</FieldLabel>
              <WidgetNumberFormat
                options={spec.options || {}}
                onChange={(next) => setSpec((sp) => (sp ? { ...sp, options: next } : sp))}
              />
            </div>

            <WidgetRefresh
              options={spec.options || {}}
              onChange={(next) => setSpec((sp) => (sp ? { ...sp, options: next } : sp))}
            />

            {ds ? (
              <QueryBuilderForm
                ds={ds}
                query={spec.query}
                onChange={patchQuery}
                config={config}
              />
            ) : null}
          </div>

          {/* ── the live preview ───────────────────────────────────────── */}
          <div className="flex min-h-0 flex-col">
            <FieldLabel hint="the same renderer the canvas uses">Preview</FieldLabel>
            <div className="h-[300px] overflow-hidden rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.55)]">
              <div className="flex h-full min-h-0 flex-col">
                <div className="shrink-0 px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[1.4px] text-nb-muted">
                  {title || "Untitled widget"}
                </div>
                <div className="min-h-0 flex-1">
                  <WidgetBody spec={spec} refreshMs={0} onResult={setLastResult} />
                </div>
              </div>
            </div>
            {issue ? (
              <p className="mt-2 text-[11px] leading-snug text-nb-warn">{issue}</p>
            ) : (
              <p className="mt-2 text-[10.5px] leading-snug text-nb-faint">
                No unit is shown anywhere unless the dataset stores one. A guessed
                unit on a dashboard is worse than a blank.
              </p>
            )}

            {/* The SERVER's statement, echoed. Read-only on purpose: seeing the
                query is what builds trust in a no-code builder; editing it is
                how a browser starts sending SQL. */}
            <button
              type="button"
              onClick={() => setShowSql((v) => !v)}
              className="mt-2 self-start text-[10.5px] uppercase tracking-[1.2px] text-nb-faint hover:text-nb-muted"
            >
              {showSql ? "− " : "+ "}The query the server ran
            </button>
            {showSql ? (
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.6)] p-2 text-[10px] leading-relaxed text-nb-soft">
                {lastResult?.sql || "Run the preview to see the generated SQL."}
              </pre>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
