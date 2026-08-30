"use client";

// ChartWidget — renders ONE dashboard widget.
//
// PORTED from `frontend-next/src/components/dashboard/chart-widget.tsx` (365
// lines). What came across is the SHELL, which is the valuable part and is not
// obvious to get right:
//
// * the `CHART_COMPONENTS` registry of dynamically-imported, `ssr: false`
//   renderers, so a chart library never evaluates during SSR and a dashboard
//   only downloads the chart types it actually uses;
// * the header/body/footer frame, with the actions in a `.widget-actions` div —
//   which is the class the grid names in `draggableCancel`, and is what stops a
//   click on "remove" from being swallowed as the start of a drag;
// * `onMouseDown={(e) => e.stopPropagation()}` on each action button, which is
//   the second half of that same fix and the one that is easy to leave out;
// * the four display states — error, data, loading skeleton, empty — and the
//   "refreshing" dot that appears when a refetch is in flight over data that is
//   already drawn, so a poll never blanks the widget;
// * the `Updated HH:MM:SS` footer.
//
// **What deliberately did NOT come across.** Theirs is built around free-SQL:
// `widget.query` + `widget.datasourceId`, `renderQueryWithVariables`,
// `applyCalculatedFields`, cross-filters, and a second WebSocket client
// (`@/lib/dashboard/ws`) for live/CDC modes. The structured-query-spec decision
// stands, so the whole data path is replaced: this widget carries a SPEC, and
// running it is one react-query call to the executor. In consequence:
//
// * no `datasourceId` — there is one store and the executor owns it;
// * no variable substitution — there is no query text to substitute into;
// * no calculated fields — an expression evaluated in the browser over rollup
//   buckets would be a third place the numbers are computed;
// * no live socket — this console already has its own realtime transport, and a
//   second WS client is exactly the kind of thing that should not arrive with a
//   copied component. The feed publishes on a ~5 minute cycle, so polling is
//   both sufficient and honest about its own latency;
// * no cross-filter / drill-down — that is a whole feature, not a port.
//
// One thing ADDED that theirs has no notion of: the footer prints
// `resolution_reason` — which store answered and what that means for freshness —
// so a chart never implies a precision it does not have.

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";

import { datasets as datasetsApi, widgetQuery } from "./api";
import { seriesBand, toChartData } from "./charts/adapt";
// All chart renderers are dynamically imported client-only — ECharts is
// browser-only, and a dashboard with no line chart on it should not pay for one.
// The map itself lives next to the renderers and next to `widget-types.ts`, so a
// palette entry without a renderer is caught where both lists are visible.
import { CHART_COMPONENTS } from "./charts/registry";
import type { Dataset, QueryResult, WidgetSpec } from "./spec";
import { migrateSpec, specIssue } from "./spec";

// How often a widget re-reads. The building publishes on a ~5 minute cycle, so
// 60s is comfortably inside it without turning a 20-widget dashboard into a
// steady stream of requests.
const REFRESH_MS = 60_000;

export interface ChartWidgetProps {
  title?: string;
  spec: WidgetSpec;
  /** Edit-mode actions. Absent in view mode, which is what makes the two modes
   *  genuinely different rather than the same screen with disabled buttons. */
  onEdit?: (() => void) | null;
  onRemove?: (() => void) | null;
  /** Chrome only: the header doubles as the drag handle in edit mode. */
  draggable?: boolean;
  refreshMs?: number;
}

/** The widget BODY — fetch, states, renderer. Exported on its own because the
 *  editor's live preview renders exactly this, so what you see while building is
 *  what gets saved. A separate preview path would drift, and it would drift first
 *  on the states below. */
export function WidgetBody({
  spec: storedSpec,
  refreshMs = REFRESH_MS,
  onResult,
}: {
  spec: WidgetSpec;
  refreshMs?: number;
  /** Handed the raw result when one arrives. The editor uses it for the
   *  read-only echo of the statement the SERVER generated — so what a person
   *  inspects is what actually ran, not a second guess at it. */
  onResult?: (r: QueryResult) => void;
}) {
  // A stored v1 (IoT-shaped) spec is brought forward HERE, at the one boundary
  // where a saved widget becomes a running one — the same translation the server
  // does on read. Without it a v1 widget would fail the client-side validator
  // with "pick a dataset" over a query the server can answer perfectly well.
  const spec = useMemo(() => migrateSpec(storedSpec), [storedSpec]);

  // The dataset this widget charts — its dimensions, measures and the aggregates
  // each measure permits. Loaded so the client-side validator can mirror the
  // server's honesty rules; a widget still renders if it has not arrived (the
  // server is the authority, this is only steering). Cached across widgets.
  const dsQ = useQuery<{ items: Dataset[] }>({
    queryKey: ["bi-datasets"],
    queryFn: () => datasetsApi.list(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const ds = (dsQ.data?.items || []).find((d) => d.key === spec.query.dataset);

  // Ask the client-side validator first: an unanswerable spec should say what is
  // missing rather than fire a request that comes back 422.
  const issue = specIssue(spec, ds);

  const q = useQuery<any>({
    // The spec IS the cache key. Change a metric and it is a different question,
    // so it must be a different cache entry — not a stale render with a new label.
    queryKey: ["widget-query", JSON.stringify(spec)],
    queryFn: () => widgetQuery.run(spec),
    enabled: !issue,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    retry: false,
  });

  const result: QueryResult | undefined = q.data;

  useEffect(() => {
    if (result && onResult) onResult(result);
    // `onResult` is a setState in practice; keying on the result alone keeps this
    // from re-firing on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const chart = useMemo(() => {
    if (!result) return null;
    return { data: toChartData(result), band: seriesBand(result) };
  }, [result]);

  if (issue) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-nb-faint">
        {issue}
      </div>
    );
  }

  if (q.isError) {
    // The executor's 400s NAME the offending field ("metric 'avg' cannot be
    // grouped by device: …"), so the message is printed verbatim. Paraphrasing it
    // into "something went wrong" throws away the only actionable thing here.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 py-4 text-center">
        <Icon icon="heroicons:exclamation-triangle" className="text-lg text-nb-crit" />
        <span className="text-[11.5px] font-medium text-nb-crit">This widget could not run</span>
        <span className="line-clamp-4 text-[11px] leading-snug text-nb-soft">
          {apiError(q.error, "Query failed")}
        </span>
      </div>
    );
  }

  if (q.isLoading || !chart) {
    // The skeleton is theirs: a row of bars of varying height, so the loading
    // state has the SHAPE of a chart instead of a spinner in an empty box.
    return (
      <div className="flex h-full flex-col justify-end gap-2 px-3 pb-2 pt-3" aria-label="Loading widget data">
        <div className="flex flex-1 items-end gap-2">
          {[55, 80, 40, 70, 90, 50, 65].map((h, i) => (
            <div
              key={`${h}-${i}`}
              className="nb-skeleton flex-1 rounded-[3px] bg-[rgba(150,180,245,.09)]"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="nb-skeleton h-2 w-1/3 rounded-[3px] bg-[rgba(150,180,245,.09)]" />
      </div>
    );
  }

  const Chart = CHART_COMPONENTS[spec.viz];
  const hasRows = chart.data.rows.length > 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {!Chart ? (
          // A saved dashboard naming a chart type this build does not have. The
          // data loaded fine — the executor never validates `viz` — so say
          // exactly that rather than rendering a blank box or silently
          // substituting a chart the author did not choose. This is the
          // forward-compatibility rule made visible.
          <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-nb-faint">
            This widget is a “{spec.viz}”, which this version cannot draw. Its data
            loaded fine — update the console, or change the chart type.
          </div>
        ) : hasRows ? (
          <Chart data={chart.data} options={spec.options} band={chart.band} />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-nb-faint">
            No readings in this window.
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-0.5 text-[9.5px] leading-tight text-nb-faint">
        {/* Their `Updated HH:MM:SS`, taken from react-query's own
            `dataUpdatedAt` rather than a second piece of state. */}
        {q.dataUpdatedAt ? (
          <span className="shrink-0" title="when this widget last read the store">
            {new Date(q.dataUpdatedAt).toLocaleTimeString()}
          </span>
        ) : null}
        <span className="truncate" title={result.resolution_reason}>
          {result.resolution_reason}
        </span>
        {result.truncated ? (
          // `matched` counts the SERIES or GROUPS the query found, which is the
          // same unit the widget draws — so "showing 8 of 37" compares two of
          // the same thing.
          <span
            className="ml-auto shrink-0 text-nb-warn"
            title={`the query matched ${result.matched}; this widget shows fewer`}
          >
            {/* A split time-series draws one COLUMN per series; everything else
                draws one ROW per group. Counting the wrong one would say
                "showing 24 of 3". */}
            {`showing ${
              spec.query.time_series && spec.query.series_by
                ? Math.max(result.columns.length - 1, 0)
                : result.rows.length
            } of ${result.matched}`}
          </span>
        ) : null}
      </div>
      {/* Refetching over data that is already drawn: a dot, never a blank widget. */}
      {q.isFetching && !q.isLoading ? (
        <div
          className="nb-pulse absolute right-2 top-2 size-1.5 rounded-full bg-nb-warn"
          title="Refreshing"
        />
      ) : null}
    </div>
  );
}

export default function ChartWidget({
  title,
  spec,
  onEdit,
  onRemove,
  draggable,
  refreshMs,
}: ChartWidgetProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.55)] transition-colors hover:border-nb-line2">
      <div
        className={`flex shrink-0 items-center justify-between gap-2 border-b border-nb-line/60 px-3 py-2 ${
          draggable ? "widget-drag-handle cursor-move" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {draggable ? (
            <Icon icon="heroicons:bars-2" className="shrink-0 text-[13px] text-nb-faint" />
          ) : null}
          <span
            className="truncate text-[11px] font-semibold uppercase tracking-[1.4px] text-nb-muted"
            title={title || spec.viz}
          >
            {title || "Untitled widget"}
          </span>
        </div>
        {(onEdit || onRemove) && (
          // `.widget-actions` is what the grid's `draggableCancel` names — without
          // it a click here starts a drag instead of firing the button.
          <div className="widget-actions flex shrink-0 items-center gap-0.5">
            {onEdit && (
              <button
                type="button"
                aria-label="Configure widget"
                title="Configure widget"
                className="rounded-[6px] p-1 text-nb-faint transition-colors hover:bg-[rgba(150,180,245,.1)] hover:text-nb-ink"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onEdit}
              >
                <Icon icon="heroicons:cog-6-tooth" className="text-[14px]" />
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                aria-label="Remove widget"
                title="Remove widget"
                className="rounded-[6px] p-1 text-nb-faint transition-colors hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onRemove}
              >
                <Icon icon="heroicons:x-mark" className="text-[14px]" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <WidgetBody spec={spec} refreshMs={refreshMs} />
      </div>
    </div>
  );
}
