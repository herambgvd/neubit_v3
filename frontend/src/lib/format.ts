// Shared formatting + data helpers. Previously copy-pasted into many views
// (titleize ×2, asItems ×4, idOf, date formatters). Import from here instead.

/** Anything `new Date()` accepts, plus the nothing-values the backend sends. */
export type DateInput = string | number | Date | null | undefined;

// "fire_alarm" → "Fire Alarm"; null/"" → "—".
export const titleize = (s: string | number | null | undefined): string =>
  s ? String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "—";

/** True only for `any` itself (the classic `0 extends 1 & T` probe). */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** What `asItems` yields for a given input. A typed list or envelope keeps its
 *  element type; a caller still holding an untyped `any` gets its `any` back
 *  rather than `unknown` — inference from `any` into `T[]` would otherwise
 *  collapse every not-yet-typed screen to `unknown[]`. No `any` originates here. */
export type ItemsOf<D> = IsAny<D> extends true
  ? any[] // eslint-disable-line @typescript-eslint/no-explicit-any -- passes the caller's own `any` through
  : ItemsOfEach<NonNullable<D>>;

/** The element half, split out so `D` is a NAKED type parameter and the
 *  conditional distributes. Several endpoints are typed `ItemList<T> | T[]`
 *  ("envelope or bare array"); tested as one union neither branch matches and
 *  every one of them fell through to `unknown[]`. */
type ItemsOfEach<D> = D extends readonly (infer T)[]
  ? T[]
  : D extends { items?: readonly (infer T)[] | null }
    ? T[]
    : unknown[];

// List endpoints return either a bare array or { items, total }. Normalise to array.
// NonNullable above is load-bearing: the usual argument is a react-query `.data`,
// which is `Envelope | undefined` until the query resolves. Distributing over that
// union gave `T[] | unknown[]`, so every typed list collapsed back to unknown[].
export const asItems = <D>(d: D): ItemsOf<D> =>
  (Array.isArray(d) ? d : (d as { items?: unknown[] | null } | null | undefined)?.items || []) as ItemsOf<D>;

// First non-null value among the given keys — handles backends that vary the id
// field name (id vs sop_id vs state_id …). idOf(obj, "id", "sop_id").
export const idOf = (o: object | null | undefined, ...keys: string[]): string | undefined =>
  // Every identifier on the wire is a string (uuid / slug); the lookup is by
  // name, so the value is asserted rather than inferred.
  keys.map((k) => (o as Record<string, unknown> | null | undefined)?.[k]).find((v) => v != null) as
    | string
    | undefined;

// "Just now" / "5m ago" / "3h ago" / locale date for older.
export function fmtRelative(ts: DateInput): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Human byte size: 1536 → "1.5 KB". null/0 → "0 B".
export function fmtBytes(bytes: number | string | null | undefined): string {
  const b = Number(bytes);
  if (!b || b <= 0 || Number.isNaN(b)) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), units.length - 1);
  return `${(b / k ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Duration in seconds → "1h 5m 3s" / "5m 3s" / "3s". null → "—".
export function fmtDuration(seconds: number | string | null | undefined): string {
  const s = Number(seconds);
  if (!s || s <= 0 || Number.isNaN(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Fixed, unambiguous date-time (e.g. incident timestamps).
export function fmtDateTime(ts: DateInput): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
