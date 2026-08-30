"use client";

// Dashboard builder API module.
//
// TWO backends, on purpose, and it is worth knowing which is which:
//
//   /api/v1/dashboards/*   the DASHBOARDS service — definitions only. What
//                          dashboards exist, what widgets are on them, where
//                          those widgets sit. Gated by `dashboards.read` /
//                          `dashboards.manage`.
//
//   /api/v1/bi/query       the READING-WRITER — the widget executor. It owns the
//                          readings schema (pipeline contract §7) and is the only
//                          thing that runs a spec. Gated by `bi.read`.
//
// The browser joins them. That is deliberate: a dashboards service that fetched
// readings itself would be a second service SELECTing tables it does not own, and
// a second place the rollup-vs-raw rules could drift. It also means the two
// permissions compose honestly — a user with `dashboards.read` but not `bi.read`
// sees the canvas and empty widgets, which is the truth about what they may see.

import { api } from "@/lib/api";

import type { QueryContext } from "./dashboard-context";
import type { Dataset, QueryResult, WidgetSpec } from "./spec";

const DASH = "/dashboards";

const unwrap = (p: Promise<any>): Promise<any> => p.then((r) => r.data);

export interface DashboardSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  grid_cols: number;
  row_height: number;
  widget_count: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardWidget {
  id: string;
  dashboard_id: string;
  title: string;
  spec: WidgetSpec;
  x: number;
  y: number;
  w: number;
  h: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardDetail extends DashboardSummary {
  /** The page's own builder state: which filters it offers, what variables it
   *  carries. Definitions only — the CHOSEN values live in the URL, so a
   *  filtered view is a link rather than something one person saved onto
   *  everybody else's page. */
  config: import("./dashboard-context").DashboardConfig;
  widgets: DashboardWidget[];
}

export interface VersionSummary {
  version: number;
  label: string;
  created_at: string;
  created_by: string | null;
  widget_count: number;
}

export interface VersionDetail extends VersionSummary {
  /** The whole dashboard at that moment. Fetched per version rather than shipped
   *  with the list — thirty snapshots is the dashboard thirty times over. */
  snapshot: Record<string, any>;
}

export interface VersionListResponse {
  total: number;
  items: VersionSummary[];
  max_versions: number;
  /** The live dashboard in the SAME shape as a snapshot, so a diff compares like
   *  with like instead of the browser reassembling it. */
  current: Record<string, any>;
}

export const dashboards = {
  list: (): Promise<{ total: number; items: DashboardSummary[] }> => unwrap(api.get(DASH)),

  get: (id: string): Promise<DashboardDetail> => unwrap(api.get(`${DASH}/${id}`)),

  create: (body: {
    name: string;
    description?: string | null;
    grid_cols?: number;
    row_height?: number;
  }): Promise<DashboardDetail> => unwrap(api.post(DASH, body)),

  update: (id: string, body: Record<string, any>): Promise<DashboardDetail> =>
    unwrap(api.patch(`${DASH}/${id}`, body)),

  remove: (id: string): Promise<void> => unwrap(api.delete(`${DASH}/${id}`)),

  addWidget: (
    id: string,
    body: { title?: string; spec: WidgetSpec; x?: number; y?: number; w?: number; h?: number },
  ): Promise<DashboardWidget> => unwrap(api.post(`${DASH}/${id}/widgets`, body)),

  updateWidget: (
    id: string,
    widgetId: string,
    body: Record<string, any>,
  ): Promise<DashboardWidget> => unwrap(api.patch(`${DASH}/${id}/widgets/${widgetId}`, body)),

  removeWidget: (id: string, widgetId: string): Promise<void> =>
    unwrap(api.delete(`${DASH}/${id}/widgets/${widgetId}`)),

  /** The whole canvas geometry in ONE write — see the backend's `save_layout`.
   *  A drag reflows several widgets; saving them individually could leave the
   *  arrangement half-persisted. */
  /** What this dashboard looked like, newest first. Reading history needs only
   *  `dashboards.read` — seeing an old state is not a write. */
  versions: (id: string): Promise<VersionListResponse> => unwrap(api.get(`${DASH}/${id}/versions`)),

  version: (id: string, version: number): Promise<VersionDetail> =>
    unwrap(api.get(`${DASH}/${id}/versions/${version}`)),

  /** Put the dashboard back. The state being discarded is snapshotted first, so
   *  a restore is itself undoable — see the service. Needs `dashboards.manage`. */
  restoreVersion: (id: string, version: number): Promise<DashboardDetail> =>
    unwrap(api.post(`${DASH}/${id}/versions/${version}/restore`, {})),

  saveLayout: (
    id: string,
    items: { id: string; x: number; y: number; w: number; h: number }[],
  ): Promise<DashboardDetail> => unwrap(api.put(`${DASH}/${id}/layout`, { items })),
};

// ── The executor + the dataset registry ─────────────────────────────────────

export const widgetQuery = {
  /** Run one widget's BUILDER STATE. POST because the state is a nested object;
   *  encoding it into a query string would be a second, lossy serialisation of a
   *  shape that is already defined.
   *
   *  `context` is the DASHBOARD's contribution — its global filters, its variables
   *  and its shared window. It is an OBJECT of keys and values, not a string: the
   *  server merges it into the widget's state and binds every value as a query
   *  parameter. The reference substitutes `{{name}}` into stored SQL instead;
   *  see `dashboard-context.ts` for why that mechanism did not come across.
   *
   *  Note what is NOT sent: SQL. The client sends state and the server generates
   *  the statement — there is no endpoint on this platform that accepts SQL from
   *  a browser (builder contract §3). The statement comes BACK on the result, as
   *  a read-only echo. */
  run: (spec: WidgetSpec, context?: QueryContext | null): Promise<QueryResult> =>
    unwrap(api.post("/bi/query", context ? { spec, context } : spec)),

  /** What the backend's spec supports. Fetched rather than hard-coded so the
   *  editor's options and the validator that rejects them cannot disagree. */
  capabilities: (): Promise<any> => unwrap(api.get("/bi/query/capabilities")),
};

export const datasets = {
  /** Every dataset this caller may read. Registered as DATA in the reporting
   *  store, so one that a domain published five minutes ago is here now — the
   *  builder discovers it, nothing in this console names it. */
  list: (): Promise<{ total: number; items: Dataset[]; aggregates: string[]; filter_ops: string[] }> =>
    unwrap(api.get("/bi/datasets")),

  get: (key: string): Promise<Dataset> => unwrap(api.get(`/bi/datasets/${key}`)),

  /** Distinct values of one dimension, for a filter picker. Without it the
   *  builder would be a form full of free-text boxes: a person filtering on
   *  `category` would have to know the gateway spells it `hvac`. */
  values: (
    key: string,
    column: string,
    search?: string,
  ): Promise<{ column: string; label: string; items: { value: string | null; count: number }[] }> =>
    unwrap(
      api.get(`/bi/datasets/${key}/values`, { params: { column, search: search || undefined } }),
    ),
};

export default dashboards;
