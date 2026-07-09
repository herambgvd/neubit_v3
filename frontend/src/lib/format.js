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

// Human byte size: 1536 → "1.5 KB". null/0 → "0 B".
export function fmtBytes(bytes) {
  const b = Number(bytes);
  if (!b || b <= 0 || Number.isNaN(b)) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), units.length - 1);
  return `${(b / k ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Duration in seconds → "1h 5m 3s" / "5m 3s" / "3s". null → "—".
export function fmtDuration(seconds) {
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
export function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
