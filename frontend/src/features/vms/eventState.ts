// AN EVENT IS AN INTERVAL, and some of them have not ended.
//
// The recorder's ledger carries `stateful`, `started_at` and `ended_at`, and the
// supervisor mirrors all three into `raw`. On the live estate 55 of 59 rows have
// an end and FOUR do not — a `connection_lost` that has been open thirteen hours
// among them. The console rendered every one of those as a point in time: a
// camera that has been dark since breakfast looked exactly like a motion blip.
//
// Two things follow, and this module is both of them:
//
//   * OPEN vs CLOSED. An open stateful event is happening NOW; it belongs at the
//     top of the screen with a duration that ticks, not in yesterday's list.
//   * DURATION. A tamper that ran five hours and a motion that lasted a frame are
//     not the same event, and a single timestamp says they are.
//
// Pure, because the interesting cases are the broken ones: the recorder sometimes
// reports an end BEFORE the start (a zeroed timestamp), and a negative bar drawn
// from that would be the console inventing a fact rather than reporting one.

import type { NormalizedVmsEvent } from "./eventLib";

export interface EventInterval {
  startMs: number | null;
  endMs: number | null;
  /** Stateful and still running: no end yet. */
  open: boolean;
  /** Milliseconds, when both ends are known AND the pair makes sense. */
  durationMs: number | null;
  /** The recorder reported an end at or before the start. Said, never drawn. */
  invalid: boolean;
}

function ms(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The recorder's own start/end for an event, dug out of the mirrored payload. */
export function eventInterval(event: NormalizedVmsEvent): EventInterval {
  const raw = (event.raw || {}) as Record<string, unknown>;
  const startMs = ms(raw.started_at) ?? ms(event.occurred_at);
  const endMs = ms(raw.ended_at);
  const stateful = raw.stateful === true;

  // Stateful with no end = still running. A NON-stateful event (a motion pulse)
  // with no end is not "ongoing" — it is instantaneous, and calling it open would
  // pin every motion blip to the top of the screen forever.
  const open = stateful && endMs === null;

  if (startMs === null || endMs === null) {
    return { startMs, endMs, open, durationMs: null, invalid: false };
  }
  if (endMs < startMs) {
    // Seen on this estate: an end of 1970 against a start of today. Reporting
    // "-59960670631s" or drawing a backwards bar would be worse than saying the
    // pair cannot be trusted.
    return { startMs, endMs, open, durationMs: null, invalid: true };
  }
  return { startMs, endMs, open, durationMs: endMs - startMs, invalid: false };
}

/** "13h 22m" · "5m 04s" · "0.4s" — the unit an operator would say out loud. */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || durationMs < 0) return "—";
  const secs = durationMs / 1000;
  if (secs < 1) return `${secs.toFixed(1)}s`;
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long an open event has been running, as of `now`. */
export function openFor(event: NormalizedVmsEvent, now = Date.now()): number | null {
  const { open, startMs } = eventInterval(event);
  if (!open || startMs === null) return null;
  // A start in the FUTURE (a recorder whose clock is ahead) is not a negative
  // duration; it is zero elapsed so far.
  return Math.max(0, now - startMs);
}

/** What a row prints beside its time: how long it ran, or that it still is. */
export function durationLabel(event: NormalizedVmsEvent, now = Date.now()): string | null {
  const iv = eventInterval(event);
  if (iv.open) return `ongoing ${formatDuration(openFor(event, now) ?? 0)}`;
  if (iv.invalid) return "duration unreliable";
  if (iv.durationMs == null) return null;
  // A zero-length span is an instantaneous event (a motion pulse). Printing "0s"
  // reads as a measurement of nothing; the absence of a duration says it better.
  return iv.durationMs === 0 ? null : formatDuration(iv.durationMs);
}
