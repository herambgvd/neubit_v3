// "Never", or a compact relative/absolute last-login time. Kept local (not the
// shared fmtRelative) to preserve this view's exact labels: "Never" for empty
// and a year-bearing date for older logins.
export function fmtLogin(ts) {
  if (!ts) return "Never";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
