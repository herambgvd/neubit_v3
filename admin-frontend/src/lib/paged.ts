import type { Paged } from "./types";

/**
 * Some list endpoints answer with the paginated envelope `{ items, total, … }`
 * and some with a bare array (the older shape). These two helpers are the single
 * place that difference is handled — callers get rows and a total either way.
 */
export function pagedItems<T>(res: Paged<T> | T[] | undefined | null): T[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return Array.isArray(res.items) ? res.items : [];
}

/** Total row count across all pages; falls back to the length of this page. */
export function pagedTotal<T>(res: Paged<T> | T[] | undefined | null): number {
  if (!res) return 0;
  if (Array.isArray(res)) return res.length;
  return typeof res.total === "number" ? res.total : pagedItems(res).length;
}

/** Page size the server used, or `fallback` when it did not say. */
export function pagedSize<T>(res: Paged<T> | T[] | undefined | null, fallback = 20): number {
  if (!res || Array.isArray(res)) return fallback;
  return res.page_size || fallback;
}
