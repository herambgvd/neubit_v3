"use client";

// DASHBOARD CONTEXT, browser side — global filters, variables and a shared window.
//
// One dashboard serving many scopes: pick a site, a category, a time range, and
// every widget follows. This module holds the types, the session state and the
// URL sync; `filter-bar.tsx` renders it and `variables-panel.tsx` edits the
// definitions.
//
// THE MECHANISM, AND WHY IT IS NOT THE REFERENCE'S
// -----------------------------------------------
// The standalone product resolves a filter or a variable by string-substituting
// `{{name}}` into the widget's stored SQL text
// (`lib/dashboard/variables.ts::renderQueryWithVariables`), single-quote-escaping
// the value on the way in unless the variable is `raw: true` — at which point it
// can be a column name, a table name or an `OR 1=1`.
//
// We do not do that, and not because of a nicer escape function. Our widgets do
// not store SQL at all: they store builder STATE, and SQL is generated on the
// server. So a chosen filter value never meets a query string. It travels as
// DATA on `POST /bi/query` (`{spec, context}`), the server merges it into the
// widget's state (`backend/reading-writer/app/api/context.py`), and the generator
// binds it as a parameter. A value containing a quote, a semicolon or a whole
// statement is compared against a column and matches nothing.
//
// The consequence worth noticing: there is nothing in this file that builds a
// string. It builds an object.
//
// WHAT IS STORED AND WHAT IS NOT
// ------------------------------
// The dashboard's `config` stores DEFINITIONS — which filters this page offers
// and what each is bound to. The CHOSEN VALUES live in the URL (`?f_<id>=…`,
// `?v_<name>=…`, `?w=<hours>`), which is deliberate three times over: a filtered
// view is a shareable link, a reload keeps what you were looking at, and nobody
// can save their own filter selection onto everybody else's page.

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { FilterOp, SpecWindow, WidgetSpec } from "./spec";

// ── the definitions, as stored on `dashboard.config` ────────────────────────

/** One control on the filter bar. */
export interface DashFilter {
  /** Stable id. It is what a widget names to OPT OUT, so it must not change when
   *  the label does. Never used in SQL — a set-membership test on the server. */
  id: string;
  label: string;
  /** The dataset whose dimension values populate the picker. A dashboard may
   *  span datasets; a filter is applied only to widgets whose dataset publishes
   *  the same dimension key, and skipped (reported, not silently) elsewhere. */
  dataset: string;
  /** A dimension KEY from the registry. Not a column name — the physical column
   *  behind it comes from the dataset definition, server side. */
  column: string;
  op: FilterOp;
  /** Offer several values at once (`in`). */
  multi?: boolean;
  /** The value the page opens with when the URL says nothing. */
  default?: string | string[] | null;
}

/** A named value the page carries, which a widget's filter can reference.
 *
 *  It is a VALUE and only a value. It cannot carry an operator or a fragment of
 *  a query, and there is no `raw` flag — the reference needs one because its
 *  variables are spliced into SQL and somebody eventually needs a column name in
 *  there. Ours never touch SQL, so there is nothing to escape from. */
export interface DashVariable {
  /** `^[A-Za-z_][A-Za-z0-9_]*$`. Referenced by a widget filter's `variable`. */
  name: string;
  label: string;
  /** Where the picker's options come from. `dataset` reads the registry's
   *  distinct values; `static` is a list the author typed; `text` is a free box. */
  source: "dataset" | "static" | "text";
  /** For `source: "dataset"`. */
  dataset?: string;
  column?: string;
  /** For `source: "static"`. */
  options?: { value: string; label: string }[];
  multi?: boolean;
  default?: string | string[] | null;
  /** Show it on the filter bar. A variable with no control is still resolvable —
   *  it just always takes its default. */
  control?: boolean;
}

export interface DashboardConfig {
  filters?: DashFilter[];
  variables?: DashVariable[];
  /** The page's default window, in hours. A widget follows it unless it opted
   *  out (`query.ignore_window`). */
  window?: { last_hours?: number | null } | null;
}

// ── the values in flight ────────────────────────────────────────────────────

/** The wire shape of `context` on `POST /bi/query`. Mirrors
 *  `backend/reading-writer/app/api/context.py`. Data, not text. */
export interface QueryContext {
  filters: {
    id: string;
    column: string;
    op: FilterOp;
    value?: string | number | null;
    values?: (string | number)[];
  }[];
  variables: Record<string, { value?: string | number | null; values?: (string | number)[] }>;
  window?: SpecWindow | null;
}

/** What the page has chosen right now: filter id → value(s), variable name →
 *  value(s), and the window override. */
export interface ContextValues {
  filters: Record<string, string[]>;
  variables: Record<string, string[]>;
  windowHours: number | null;
}

const F_PREFIX = "f_";
const V_PREFIX = "v_";
const W_PARAM = "w";
/** Multi-values ride in one param. A comma is the separator the rest of this
 *  builder already uses for an `in` filter's value box. */
const SEP = ",";

const asList = (v: string | string[] | null | undefined): string[] =>
  v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : v === "" ? [] : [String(v)];

/** Read the chosen values out of the URL, falling back to each definition's
 *  default. An EXPLICIT empty param (`?f_cat=`) means "cleared", which is not the
 *  same as absent — absent means "the author's default". */
export function readValues(config: DashboardConfig, params: URLSearchParams): ContextValues {
  const filters: Record<string, string[]> = {};
  for (const f of config.filters || []) {
    const raw = params.get(F_PREFIX + f.id);
    filters[f.id] =
      raw === null ? asList(f.default) : raw === "" ? [] : raw.split(SEP).filter(Boolean);
  }
  const variables: Record<string, string[]> = {};
  for (const v of config.variables || []) {
    const raw = params.get(V_PREFIX + v.name);
    variables[v.name] =
      raw === null ? asList(v.default) : raw === "" ? [] : raw.split(SEP).filter(Boolean);
  }
  const w = params.get(W_PARAM);
  const parsed = w ? Number(w) : NaN;
  const windowHours = Number.isFinite(parsed) && parsed > 0 ? parsed : config.window?.last_hours ?? null;
  return { filters, variables, windowHours };
}

/** Chosen values → the `context` object the executor gets.
 *
 *  Every entry is a key and a value. Nothing is concatenated, nothing is quoted,
 *  and there is no branch here that could produce a fragment of a statement. */
export function toQueryContext(config: DashboardConfig, values: ContextValues): QueryContext {
  const filters: QueryContext["filters"] = [];
  for (const f of config.filters || []) {
    const chosen = values.filters[f.id] || [];
    if (!chosen.length) continue; // no value chosen = no constraint
    if (f.multi || f.op === "in") {
      filters.push({ id: f.id, column: f.column, op: "in", values: chosen });
    } else {
      filters.push({ id: f.id, column: f.column, op: f.op, value: chosen[0] });
    }
  }
  const variables: QueryContext["variables"] = {};
  for (const v of config.variables || []) {
    const chosen = values.variables[v.name] || [];
    // An unset variable is sent as EMPTY rather than omitted: the server needs to
    // know the dashboard defines it (so a widget referencing it is legal) and
    // that it currently constrains nothing (so the widget's filter is dropped
    // rather than becoming `= ''`).
    variables[v.name] =
      v.multi && chosen.length > 1 ? { values: chosen } : { value: chosen[0] ?? null };
  }
  return {
    filters,
    variables,
    window: values.windowHours ? { last_hours: values.windowHours } : null,
  };
}

/** The context as ONE widget will see it — used for the react-query cache key, so
 *  a widget that opted out of every filter is not refetched when they change.
 *
 *  Without this, changing a page filter would invalidate all twenty tiles even
 *  though only the eight it applies to can move. */
export function contextKeyFor(spec: WidgetSpec, ctx: QueryContext): string {
  const q: any = spec.query || {};
  if (q.ignore_all_filters && q.ignore_window) return "";
  const ignored = new Set<string>(q.ignore_filters || []);
  const filters = q.ignore_all_filters ? [] : ctx.filters.filter((f) => !ignored.has(f.id));
  // Variables are always included: a widget references one by name in its own
  // filter, and there is no opt-out from your own state.
  return JSON.stringify({
    filters,
    variables: ctx.variables,
    window: q.ignore_window ? null : ctx.window,
  });
}

// ── the session-state hook ──────────────────────────────────────────────────

export interface DashboardContextState {
  config: DashboardConfig;
  values: ContextValues;
  context: QueryContext;
  /** True when the page has narrowed anything at all. Drives the Reset button. */
  active: boolean;
  setFilter: (id: string, values: string[]) => void;
  setVariable: (name: string, values: string[]) => void;
  setWindowHours: (hours: number | null) => void;
  clear: () => void;
}

/** Filter/variable state, held in the URL.
 *
 *  `router.replace` rather than `push`: choosing a site is not a navigation, and
 *  filling somebody's back button with twelve filter permutations makes leaving
 *  the page take twelve presses. */
export function useDashboardContext(config: DashboardConfig): DashboardContextState {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString();

  const values = useMemo(
    () => readValues(config, new URLSearchParams(search)),
    [config, search],
  );
  const context = useMemo(() => toQueryContext(config, values), [config, values]);

  const write = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(search);
      mutate(next);
      const qs = next.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, search],
  );

  const setFilter = useCallback(
    (id: string, chosen: string[]) =>
      // The param is always WRITTEN, even when empty, because an absent param
      // means "the author's default" and clearing a filter that defaults to
      // something is a real thing to want.
      write((p) => p.set(F_PREFIX + id, chosen.join(SEP))),
    [write],
  );

  const setVariable = useCallback(
    (name: string, chosen: string[]) => write((p) => p.set(V_PREFIX + name, chosen.join(SEP))),
    [write],
  );

  const setWindowHours = useCallback(
    (hours: number | null) =>
      write((p) => (hours ? p.set(W_PARAM, String(hours)) : p.delete(W_PARAM))),
    [write],
  );

  const clear = useCallback(
    () =>
      write((p) => {
        for (const key of Array.from(p.keys())) {
          if (key.startsWith(F_PREFIX) || key.startsWith(V_PREFIX) || key === W_PARAM) {
            p.delete(key);
          }
        }
      }),
    [write],
  );

  const active = useMemo(() => {
    const p = new URLSearchParams(search);
    return Array.from(p.keys()).some(
      (k) => k.startsWith(F_PREFIX) || k.startsWith(V_PREFIX) || k === W_PARAM,
    );
  }, [search]);

  return { config, values, context, active, setFilter, setVariable, setWindowHours, clear };
}

// ── what a widget can say about the context ─────────────────────────────────

/** One line the executor sent back about what the page contributed to a widget.
 *  Mirrors `context.ContextNote`. */
export interface ContextNote {
  kind: "applied" | "skipped" | "opted_out" | "window";
  filter_id?: string;
  column?: string;
  reason?: string;
}

/** Whether a widget takes a given page filter. Used to draw the opt-out state on
 *  the tile, so "why did this one not move" is answerable by looking. */
export function widgetTakesFilter(spec: WidgetSpec, filterId: string): boolean {
  const q: any = spec.query || {};
  if (q.ignore_all_filters) return false;
  return !(q.ignore_filters || []).includes(filterId);
}

export const WINDOW_CHOICES = [
  { hours: 1, label: "1H" },
  { hours: 6, label: "6H" },
  { hours: 24, label: "24H" },
  { hours: 24 * 7, label: "7D" },
  { hours: 24 * 30, label: "30D" },
];
