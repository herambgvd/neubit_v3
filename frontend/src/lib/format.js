// Shared formatting + data helpers. Previously copy-pasted into many views
// (titleize ×2, asItems ×4, idOf, date formatters). Import from here instead.

// "fire_alarm" → "Fire Alarm"; null/"" → "—".
export const titleize = (s) =>
  s ? String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "—";

// List endpoints return either a bare array or { items, total }. Normalise to array.
export const asItems = (d) => (Array.isArray(d) ? d : d?.items || []);

// First non-null value among the given keys — handles backends that vary the id
// field name (id vs sop_id vs state_id …). idOf(obj, "id", "sop_id").
export const idOf = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v != null);

// "Just now" / "5m ago" / "3h ago" / locale date for older.
export function fmtRelative(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Fixed, unambiguous date-time (e.g. incident timestamps).
export function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
