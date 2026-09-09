// Grouping an event feed the way an operator reads it: by day, newest first,
// with the two days that have their own names spelled out.
//
// Pure, and tested — a feed that silently mislabels "Today" is worse than one
// with no headers at all, and the boundary cases (local midnight, an event from
// a device whose clock is ahead) are exactly what a rendered test cannot pin.

import type { NormalizedVmsEvent } from "./eventLib";

export interface EventDay {
  /** YYYY-MM-DD in LOCAL time — the key the header is grouped by. */
  key: string;
  /** "Today" / "Yesterday" / "Mon 8 Sep" — what the header prints. */
  label: string;
  events: NormalizedVmsEvent[];
}

/** LOCAL calendar day of an instant. `toISOString()` would roll to the previous
 *  day for anyone east of UTC before their morning. */
export function localDayKey(iso: string | null | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : now;
  const at = Number.isNaN(d.getTime()) ? now : d;
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export function dayLabel(key: string, now = new Date()): string {
  const today = localDayKey(null, now);
  if (key === today) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === localDayKey(null, y)) return "Yesterday";
  const [yy, mm, dd] = key.split("-").map(Number);
  return new Date(yy, mm - 1, dd).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** The feed, split into day buckets in the order it was given (newest first).
 *  Order is preserved rather than re-sorted: the caller already merged live
 *  frames onto history, and re-sorting here would fight that. */
export function groupByDay(events: NormalizedVmsEvent[], now = new Date()): EventDay[] {
  const out: EventDay[] = [];
  let current: EventDay | null = null;
  for (const e of events) {
    const key = localDayKey(e.occurred_at, now);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(key, now), events: [] };
      out.push(current);
    }
    current.events.push(e);
  }
  return out;
}

/** "just now" · "4m" · "2h" · "3d" — a feed reads in elapsed time, not clock
 *  time, and the exact instant stays on the row beside it. */
export function ago(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((now.getTime() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86_400)}d`;
}
