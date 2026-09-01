// Date-only formatter for key created/last-used columns. Kept local (not the
// shared fmtDateTime, which adds a time component) to preserve this view's
// year-bearing, date-only labels.
export function fmtDate(v?: string | number | Date | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
