// Pure pieces of the Playback workspace (SCRUM-304..306): the zoom ladder, tick
// placement, grid layouts, the speed ladder, coverage spans and the jumps between
// them. No React and no DOM, so every rule here is unit-tested on its own.
//
// The numbers follow what the professional VMS clients ship (Milestone Smart
// Client, Genetec Security Desk, Nx Witness, Avigilon ACC, HikCentral Pro) and the
// recorder console this VMS federates, so an operator moving between them finds
// the same controls in the same places.

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// ── timeline window ─────────────────────────────────────────────────────────

/** A timeline window in epoch ms. */
export interface Win {
  fromMs: number;
  toMs: number;
}

export interface ZoomLevel {
  label: string;
  seconds: number;
}

// 30 s finds a single frame's neighbourhood; 7 d finds which day it happened on.
// Milestone, Genetec and Avigilon all span seconds to days on one track.
export const ZOOM_LEVELS: readonly ZoomLevel[] = [
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3_600 },
  { label: "6h", seconds: 21_600 },
  { label: "24h", seconds: 86_400 },
  { label: "7d", seconds: 604_800 },
];

export const MIN_SPAN_MS = 30 * SECOND_MS;
export const MAX_SPAN_MS = 7 * DAY_MS;
export const DEFAULT_SPAN_S = 3_600;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A window of `seconds` centred on an instant. */
export function windowAt(centerMs: number, seconds: number): Win {
  const span = clamp(seconds * 1000, MIN_SPAN_MS, MAX_SPAN_MS);
  return { fromMs: centerMs - span / 2, toMs: centerMs + span / 2 };
}

/** The local calendar day containing `ms`, as a window. */
export function dayWindow(ms: number): Win {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  d.setDate(d.getDate() + 1); // DST-safe: the next local midnight, not +24 h
  return { fromMs: from, toMs: d.getTime() };
}

/** Zoom by `factor` (<1 in, >1 out) keeping `centerMs` under the same pixel. */
export function zoomWindow(win: Win, factor: number, centerMs?: number): Win {
  const span = win.toMs - win.fromMs;
  const next = clamp(span * factor, MIN_SPAN_MS, MAX_SPAN_MS);
  const c = centerMs ?? (win.fromMs + win.toMs) / 2;
  const ratio = span > 0 ? (c - win.fromMs) / span : 0.5;
  const fromMs = c - ratio * next;
  return { fromMs, toMs: fromMs + next };
}

/** Re-frame to a ladder span around `centerMs`. */
export function spanWindow(win: Win, seconds: number, centerMs?: number): Win {
  const c = centerMs ?? (win.fromMs + win.toMs) / 2;
  return windowAt(c, seconds);
}

export function panWindow(win: Win, deltaMs: number): Win {
  return { fromMs: win.fromMs + deltaMs, toMs: win.toMs + deltaMs };
}

/** The ladder entry nearest the window's span, for the zoom readout. */
export function nearestZoom(win: Win): ZoomLevel {
  const s = (win.toMs - win.fromMs) / 1000;
  let best = ZOOM_LEVELS[0];
  for (const z of ZOOM_LEVELS) {
    if (Math.abs(Math.log(z.seconds / s)) < Math.abs(Math.log(best.seconds / s))) best = z;
  }
  return best;
}

/** One step along the ladder from the current span (`dir` −1 = in, +1 = out). */
export function stepZoom(win: Win, dir: -1 | 1): number {
  const s = (win.toMs - win.fromMs) / 1000;
  if (dir > 0) return (ZOOM_LEVELS.find((z) => z.seconds > s * 1.01) ?? ZOOM_LEVELS.at(-1)!).seconds;
  const smaller = ZOOM_LEVELS.filter((z) => z.seconds < s * 0.99);
  return (smaller.at(-1) ?? ZOOM_LEVELS[0]).seconds;
}

/** Follow paging: when the playhead leaves the window, turn the page so it sits
 *  near the left edge again. Inside the window nothing moves, so the track does not
 *  scroll under an operator who is reading it. */
export function followPage(win: Win, atMs: number): Win {
  const span = win.toMs - win.fromMs;
  if (atMs >= win.fromMs && atMs <= win.toMs) return win;
  const fromMs = atMs - span * 0.1;
  return { fromMs, toMs: fromMs + span };
}

export const timeToFrac = (win: Win, t: number) => (t - win.fromMs) / (win.toMs - win.fromMs);
export const fracToTime = (win: Win, f: number) => win.fromMs + f * (win.toMs - win.fromMs);

// ── ticks ───────────────────────────────────────────────────────────────────

const TICK_STEPS_MS = [
  SECOND_MS, 5 * SECOND_MS, 10 * SECOND_MS, 30 * SECOND_MS,
  MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 30 * MINUTE_MS,
  HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS,
];

export interface Tick {
  t: number;
  label: string;
  /** A local midnight: drawn stronger and labelled with the date. */
  major: boolean;
}

/** Tick marks at least `minPx` apart, aligned to LOCAL clock time (an operator
 *  reads 14:00, not 14:00 UTC shifted by the zone). */
export function ticksFor(win: Win, widthPx: number, minPx = 80): Tick[] {
  const span = win.toMs - win.fromMs;
  if (span <= 0 || widthPx <= 0) return [];
  const step = TICK_STEPS_MS.find((s) => (s / span) * widthPx >= minPx) ?? DAY_MS;
  const base = dayWindow(win.fromMs).fromMs;
  const out: Tick[] = [];
  let t = base + Math.ceil((win.fromMs - base) / step) * step;
  for (let i = 0; t <= win.toMs && i < 500; i += 1, t += step) {
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    out.push({ t, label: tickLabel(t, step, midnight), major: midnight });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

function tickLabel(t: number, step: number, midnight: boolean): string {
  const d = new Date(t);
  if (midnight) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (step < MINUTE_MS) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── clock and calendar text ─────────────────────────────────────────────────

/** HH:mm:ss for the transport readout. */
export function clockText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "--:--:--";
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** YYYY-MM-DD of the LOCAL day (toISOString would roll near midnight in +zones). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a YYYY-MM-DD, or NaN. */
export const dayStart = (day: string) => new Date(`${day}T00:00:00`).getTime();

/** First and last YYYY-MM-DD of a month (0-based month). */
export function monthRange(year: number, month0: number): { from: string; to: string } {
  const last = new Date(year, month0 + 1, 0).getDate();
  return { from: `${year}-${pad(month0 + 1)}-01`, to: `${year}-${pad(month0 + 1)}-${pad(last)}` };
}

/** h:mm:ss / m:ss for a selection length. */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// ── layouts ─────────────────────────────────────────────────────────────────

// 1/4/9/16: the split-screens every NVR and VMS client offers. 16 is where synced
// playback stops being useful (HikCentral caps synchronous playback at 16 too)
// and where a recorder link is already carrying sixteen recorded streams.
export const LAYOUTS = [1, 4, 9, 16] as const;
export type Layout = (typeof LAYOUTS)[number];
export const MAX_TILES = 16;

export function gridDims(layout: Layout): { cols: number; rows: number } {
  const n = Math.round(Math.sqrt(layout));
  return { cols: n, rows: n };
}

/** The smallest layout that shows `count` tiles. */
export function layoutFor(count: number): Layout {
  return LAYOUTS.find((l) => l >= count) ?? 16;
}

// ── speed ───────────────────────────────────────────────────────────────────

// Slow motion for reading a plate, fast for scanning an hour. Negative = reverse.
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

/** The fastest forward rate a grid of `tiles` may run at. Every tile decodes every
 *  frame at that rate, so the ceiling falls as tiles are added (Verkada caps the same
 *  way: faster with fewer cameras). */
export function maxSpeedFor(tiles: number): number {
  if (tiles <= 1) return 16;
  if (tiles <= 4) return 8;
  return 4;
}

/** Reverse play re-opens every tile at each step (a browser cannot decode backwards
 *  and the recorder's stream cannot seek), so it is offered for a small grid only. */
export const REVERSE_MAX_TILES = 4;
export const reverseAllowed = (tiles: number) => tiles <= REVERSE_MAX_TILES;

/** A speed the grid can actually run, keeping its direction where it may. */
export function clampSpeed(speed: number, tiles: number): number {
  if (speed < 0 && !reverseAllowed(tiles)) return 1;
  const max = maxSpeedFor(tiles);
  const mag = Math.min(Math.abs(speed), max);
  return speed < 0 ? -mag : mag;
}

/** The next rung up or down the ladder from `speed` (reverse included). */
export function stepSpeed(speed: number, dir: -1 | 1, tiles: number): number {
  const max = maxSpeedFor(tiles);
  const reverse = reverseAllowed(tiles) ? SPEEDS.filter((s) => s >= 1 && s <= max).map((s) => -s).reverse() : [];
  const ladder = [...reverse, ...SPEEDS.filter((s) => s <= max)];
  const i = ladder.indexOf(speed);
  const at = i < 0 ? ladder.indexOf(1) : i;
  return ladder[clamp(at + dir, 0, ladder.length - 1)];
}

export function speedText(speed: number): string {
  const mag = Math.abs(speed);
  const body = mag < 1 ? `1/${Math.round(1 / mag)}` : String(mag);
  return `${speed < 0 ? "−" : ""}${body}×`;
}

// ── coverage ────────────────────────────────────────────────────────────────

/** How a recording span is coloured. The recorder's own console uses the same four. */
export type TriggerKey = "continuous" | "motion" | "alarm" | "manual";

export const TRIGGERS: Record<TriggerKey, { label: string; hex: string }> = {
  continuous: { label: "Continuous", hex: "#3b82f6" },
  motion: { label: "Motion", hex: "#22c55e" },
  alarm: { label: "Alarm / event", hex: "#f59e0b" },
  manual: { label: "Manual", hex: "#94a3b8" },
};
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as TriggerKey[];

/** The recorder's trigger_type → a colour bucket (schedule records continuously). */
export function triggerKey(t: string | null | undefined): TriggerKey {
  switch ((t || "").toLowerCase()) {
    case "motion":
      return "motion";
    case "alarm":
    case "event":
      return "alarm";
    case "manual":
      return "manual";
    default:
      return "continuous";
  }
}

export interface Span {
  s: number;
  e: number;
  trigger: TriggerKey;
}

interface RangeLike {
  start?: string | null;
  duration?: number | null;
  trigger_type?: string | null;
}

/** The recorder's `{start, duration(s), trigger_type}` ranges as sorted ms spans. */
export function spansFromRanges(ranges: readonly RangeLike[] | null | undefined): Span[] {
  const out: Span[] = [];
  for (const r of ranges ?? []) {
    if (!r?.start) continue;
    const s = new Date(r.start).getTime();
    if (!Number.isFinite(s)) continue;
    out.push({ s, e: s + Math.max(0, r.duration ?? 0) * 1000, trigger: triggerKey(r.trigger_type) });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Overlapping or touching spans fused, trigger ignored: "is there footage here". */
export function unionSpans(lists: readonly (readonly Span[])[]): { s: number; e: number }[] {
  const all = lists.flat().slice().sort((a, b) => a.s - b.s);
  const out: { s: number; e: number }[] = [];
  for (const sp of all) {
    const last = out.at(-1);
    if (last && sp.s <= last.e + 1_000) last.e = Math.max(last.e, sp.e);
    else out.push({ s: sp.s, e: sp.e });
  }
  return out;
}

// A jump lands just inside the next recording, and "previous" from within the
// first seconds of a recording means the one before it (a media player's ⏮).
const JUMP_EPS_MS = 1_000;
const PREV_GRACE_MS = 3_000;

/** Start of the first recording after the one the playhead is in. */
export function nextRecording(spans: readonly { s: number; e: number }[], t: number): number | null {
  const hit = spans.find((sp) => sp.s > t + JUMP_EPS_MS);
  return hit ? hit.s : null;
}

/** Start of the recording the playhead is in, or of the one before it. */
export function prevRecording(spans: readonly { s: number; e: number }[], t: number): number | null {
  let best: number | null = null;
  for (const sp of spans) if (sp.s < t - PREV_GRACE_MS) best = sp.s;
  return best;
}

/** The first event time after `t`. */
export function nextEvent(times: readonly number[], t: number): number | null {
  let best: number | null = null;
  for (const m of times) if (m > t + JUMP_EPS_MS && (best == null || m < best)) best = m;
  return best;
}

/** The last event time before `t`. */
export function prevEvent(times: readonly number[], t: number): number | null {
  let best: number | null = null;
  for (const m of times) if (m < t - PREV_GRACE_MS && (best == null || m > best)) best = m;
  return best;
}

/** Where to start when there is no playhead yet: the start of the last recording
 *  that begins inside the window, else the window's start. */
export function defaultStart(spans: readonly { s: number; e: number }[], win: Win): number {
  const inside = spans.filter((sp) => sp.e > win.fromMs && sp.s < win.toMs);
  if (!inside.length) return win.fromMs;
  return Math.max(win.fromMs, inside[0].s);
}

// The recorder serves the file still being written about this far behind real time.
export const LIVE_EDGE_LAG_MS = 8_000;

/** Coverage + event queries are keyed on the window rounded out to this grain, so a
 *  wheel-zoom or a drag does not refetch on every pixel. */
export function queryWindow(win: Win): Win {
  const span = win.toMs - win.fromMs;
  let grain = DAY_MS;
  if (span <= HOUR_MS) grain = 5 * MINUTE_MS;
  else if (span <= DAY_MS) grain = HOUR_MS;
  return {
    fromMs: Math.floor(win.fromMs / grain) * grain,
    toMs: Math.ceil(win.toMs / grain) * grain,
  };
}

// ── keyboard ────────────────────────────────────────────────────────────────

/** What a key does in the workspace. */
export type KeyAction =
  | "play"
  | "prevEvent"
  | "nextEvent"
  | "back5"
  | "fwd5"
  | "back60"
  | "fwd60"
  | "frameBack"
  | "frameFwd"
  | "faster"
  | "slower"
  | "markIn"
  | "markOut"
  | "zoomIn"
  | "zoomOut"
  | "firstRecording"
  | "liveEdge"
  | "clearRange";

const PLAIN_KEYS: Record<string, KeyAction> = {
  " ": "play",
  ",": "frameBack",
  ".": "frameFwd",
  PageUp: "faster",
  PageDown: "slower",
  "[": "markIn",
  "]": "markOut",
  "+": "zoomIn",
  "=": "zoomIn",
  "-": "zoomOut",
  Home: "firstRecording",
  End: "liveEdge",
  Escape: "clearRange",
};

/** The keys the clients share (Avigilon, Verkada, Nx): Space, arrows with Shift for a
 *  bigger step and Alt for events, , . for frames, PgUp/PgDn for speed, [ ] for the
 *  range, +/- for zoom, Home/End for the first recording and the live edge. */
export function keyAction(key: string, mods: { alt?: boolean; shift?: boolean } = {}): KeyAction | null {
  if (key === "ArrowLeft") {
    if (mods.alt) return "prevEvent";
    return mods.shift ? "back60" : "back5";
  }
  if (key === "ArrowRight") {
    if (mods.alt) return "nextEvent";
    return mods.shift ? "fwd60" : "fwd5";
  }
  return PLAIN_KEYS[key] ?? null;
}
