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

import type { QueryResult, WidgetSpec } from "./spec";

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
  widgets: DashboardWidget[];
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
  saveLayout: (
    id: string,
    items: { id: string; x: number; y: number; w: number; h: number }[],
  ): Promise<DashboardDetail> => unwrap(api.put(`${DASH}/${id}/layout`, { items })),
};

// ── The executor ────────────────────────────────────────────────────────────

export const widgetQuery = {
  /** Run one widget spec. POST because a spec is a nested object with a point-id
   *  list; encoding that into a query string would be a second, lossy
   *  serialisation of a shape that is already defined. Nothing here writes. */
  run: (spec: WidgetSpec): Promise<QueryResult> => unwrap(api.post("/bi/query", spec)),

  /** What the backend's spec supports. Fetched rather than hard-coded so the
   *  editor's options and the validator that rejects them cannot disagree. */
  capabilities: (): Promise<any> => unwrap(api.get("/bi/query/capabilities")),
};

export default dashboards;
