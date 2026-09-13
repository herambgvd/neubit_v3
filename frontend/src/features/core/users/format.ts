/** The three states the status segment can put an account in. */
export type AccountStatus = "active" | "disabled" | "locked";

/** Which of the three an account is in right now.
 *
 *  A lock OUTRANKS the active flag, and that order is the whole point: a locked
 *  account is still `is_active`, so reading the flag first paints a locked-out
 *  user green in the list and preselects "ACTIVE" in the segment that changes
 *  their status. Three screens each wrote this chain out; they now share it. */
export function accountStatus(u: { locked?: boolean | null; is_active?: boolean | null }): AccountStatus {
  if (u.locked) return "locked";
  return u.is_active ? "active" : "disabled";
}

// "Never", or a compact relative/absolute last-login time. Kept local (not the
// shared fmtRelative) to preserve this view's exact labels: "Never" for empty
// and a year-bearing date for older logins.
export function fmtLogin(ts: string | null | undefined): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
