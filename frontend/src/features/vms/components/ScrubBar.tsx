"use client";

// ScrubBar — the recorded-playback timeline. A 24-hour (or windowed) track that
// paints coverage blocks (recorded spans) solid and leaves gaps dimmed, with a
// draggable playhead. Click / drag anywhere → seek to that timestamp. Ported
// from gvd_nvr's TimelinePlayer timeline, reskinned to v3 tokens.
//
//   coverage: [{ start, end }]  — ISO strings, the recorded spans
//   markers:  [{ t, event_type, severity, event_id }] — VmsEvent ticks (P5-C)
//   bookmarks:[{ id, start_ts, end_ts?, title, note?, tags[] }] — G3 bookmarks
//   locks:    [{ id, start_ts, end_ts, reason?, case_ref?, is_active }] — G3 evidence
//   motionHits:[{ start, end?, score? }] — G4 forensic-motion-search hit intervals
//   windowStart / windowEnd     — epoch ms, the visible track range
//   current                     — epoch ms, the playhead
//   onSeek(ms)                  — click/drag (or click a marker) to a timestamp
//   onBookmarkClick(bm)         — click a bookmark flag → seek + open its popover
//   selectionStart/End          — epoch ms, an OPTIONAL clip-extract selection band
//                                 (mark-in/out); both null → off (default, so the
//                                 standalone PlaybackPlayer stays unaffected)
import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { presetFor } from "../constants";
import { eventTypeLabel, sevPreset } from "../eventLib";
import type { BookmarkPublic, EvidenceLockPublic, MotionHit, TimelineMarker } from "../types";
import type { CoverageSpan } from "./playbackTypes";

/** Where a key press should move the playhead, or null for a key this slider does
 *  not claim — so the browser keeps Tab, and a shortcut somewhere above still fires.
 *
 *  A nudge is 1% of the VISIBLE window and a page is 10%, not a fixed number of
 *  seconds: the same key has to do something sensible whether the operator is
 *  looking at an hour or at a week, and a fixed step is imperceptible on one and
 *  wild on the other.
 *
 *  Out here rather than inside the handler because this is the whole behaviour of
 *  keyboard seeking, and it is worth being able to test it without a DOM. */
export function seekTarget(
  key: string,
  { windowStart, span, current }: { windowStart: number; span: number; current: number },
): number | null {
  const step = span / 100;
  const windowEnd = windowStart + span;
  const MOVES: Record<string, number> = {
    ArrowLeft: current - step,
    ArrowRight: current + step,
    PageUp: current - step * 10,
    PageDown: current + step * 10,
    Home: windowStart,
    End: windowEnd,
  };
  const target = MOVES[key];
  if (target === undefined) return null;
  // Clamped, so holding an arrow at either end stops there instead of seeking
  // past the footage the window is showing.
  return Math.max(windowStart, Math.min(windowEnd, target));
}

const HOUR_MS = 3_600_000;

// ── Shared timeline palette (single source of truth) ─────────────────────────
// One color map drives BOTH the coverage bars here AND the legend swatches in
// UnifiedPlayback, so the two never drift. Keyed by the CTOCAM/Lumina event-type
// buckets the operator filters on: Normal / Motion / IO / PIR / AI / Alarm /
// Manual / ANR. Each entry carries a Tailwind class (bar/checkbox fills, which
// respect dark tokens) and a raw hex (SVG marker fills, inline styles).
//
// Trigger_type → legend bucket mapping (backend coverage `trigger_type`):
//   continuous → Normal · motion → Motion · event → Alarm · manual → Manual.
// IO / PIR / AI / ANR have no coverage trigger of their own — they surface via
// event MARKERS' event_type (see legendKeyForEventType) — so their coverage bars
// only appear if a backend ever tags a span with that trigger.
export const TIMELINE_PALETTE = {
  Normal: { cls: "bg-blue-500/70", hex: "#3b82f6", label: "Normal" },
  Motion: { cls: "bg-[rgba(34,211,238,.7)]", hex: "#22d3ee", label: "Motion" },
  IO: { cls: "bg-cyan-500/70", hex: "#06b6d4", label: "IO" },
  PIR: { cls: "bg-violet-500/70", hex: "#8b5cf6", label: "PIR" },
  AI: { cls: "bg-fuchsia-500/70", hex: "#d946ef", label: "AI" },
  Alarm: { cls: "bg-amber-500/70", hex: "#f59e0b", label: "Alarm" },
  Manual: { cls: "bg-foreground/40", hex: "#94a3b8", label: "Manual" },
  ANR: { cls: "bg-indigo-500/70", hex: "#6366f1", label: "ANR" },
};

/** One of the 8 legend buckets. */
export type LegendType = keyof typeof TIMELINE_PALETTE;

// The 8 legend buckets, in the reference NVR's order.
export const LEGEND_TYPES: readonly LegendType[] = ["Normal", "Motion", "IO", "PIR", "AI", "Alarm", "Manual", "ANR"];

// Coverage `trigger_type` (backend model) → legend bucket.
export const TRIGGER_TO_LEGEND = {
  continuous: "Normal",
  schedule: "Normal",
  motion: "Motion",
  event: "Alarm",
  manual: "Manual",
} satisfies Record<string, LegendType>;
export const triggerToLegend = (t: string | null | undefined): LegendType =>
  presetFor(TRIGGER_TO_LEGEND, t, "Normal");

// Event-marker `event_type` (free-form string) → legend bucket, by keyword. Used
// both to color/plot markers and to honor the event-type filter for markers.
export const legendKeyForEventType = (et: string | null | undefined = ""): LegendType => {
  const s = String(et).toLowerCase();
  // Order matters + the 2-letter tokens "ai"/"io" MUST be word-boundary matched —
  // a bare `includes("io")` wrongly catches motion/intrusion/audio (all contain "io"),
  // and `includes("ai")` catches main/email/detail. Check specific buckets first.
  if (s.includes("motion")) return "Motion";
  if (s.includes("pir")) return "PIR";
  if (s.includes("anr") || s.includes("backfill")) return "ANR";
  if (
    /\bai\b/.test(s) || s.includes("analytic") || s.includes("detect") ||
    s.includes("intrusion") || s.includes("line cross") || s.includes("tripwire") ||
    s.includes("face") || s.includes("object") || s.includes("people") || s.includes("person")
  )
    return "AI";
  if (/\bio\b/.test(s) || s.includes("i/o") || s.includes("input") || s.includes("relay") || s.includes("digital"))
    return "IO";
  if (s.includes("manual")) return "Manual";
  if (s.includes("alarm") || s.includes("tamper") || s.includes("event")) return "Alarm";
  return "Alarm"; // an unrecognized event is an "event" → Alarm bucket
};

// Coverage-block color by trigger, mapped through the shared palette so bars and
// legend swatches always agree. An unknown trigger lands on the neutral Normal accent.
const blockColor = (trigger: string): string => TIMELINE_PALETTE[triggerToLegend(trigger)].cls;

function hhmmss(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

// ── the painted items, positioned as % of the track ─────────────────────────
interface Block {
  key: string;
  leftPct: number;
  widthPct: number;
  trigger: string;
}
interface MarkerTick {
  key: string;
  leftPct: number;
  ms: number;
  fill: string;
  label: string;
  severity: string;
}
interface LockBand {
  key: string;
  leftPct: number;
  widthPct: number;
  label: string;
}
interface BookmarkFlag {
  key: string;
  bm: BookmarkPublic;
  leftPct: number;
  widthPct: number;
  ms: number;
  title: string;
}
interface MotionBand {
  key: string;
  ms: number;
  leftPct: number;
  widthPct: number;
  label: string;
}

export interface ScrubBarProps {
  coverage?: CoverageSpan[];
  markers?: TimelineMarker[];
  bookmarks?: BookmarkPublic[];
  locks?: EvidenceLockPublic[];
  motionHits?: MotionHit[];
  /** Epoch ms — the visible track range. */
  windowStart: number;
  windowEnd: number;
  /** Epoch ms — the playhead. */
  current?: number | null;
  onSeek?: (ms: number) => void;
  onBookmarkClick?: (bm: BookmarkPublic) => void;
  /** Epoch ms — an OPTIONAL clip-extract selection band; both null → off. */
  selectionStart?: number | null;
  selectionEnd?: number | null;
  disabled?: boolean;
}

export default function ScrubBar({
  coverage = [],
  markers = [],
  bookmarks = [],
  locks = [],
  motionHits = [],
  windowStart,
  windowEnd,
  current,
  onSeek,
  onBookmarkClick,
  selectionStart = null,
  selectionEnd = null,
  disabled = false,
}: ScrubBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<{ pct: number; ms: number } | null>(null);
  const [markerHover, setMarkerHover] = useState<{ leftPct: number; label: string; time: string } | null>(null);
  const [bmHover, setBmHover] = useState<{ leftPct: number; title: string; time: string } | null>(null);
  const [hitHover, setHitHover] = useState<{ leftPct: number; label: string } | null>(null); // G4 motion hit

  const span = Math.max(1, windowEnd - windowStart);

  // How many hour gridlines fit — cap the labels so they don't crowd.
  // Snap ticks to LOCAL hour boundaries (not UTC): the labels render in local time,
  // so aligning on UTC hours makes them land at :30 in half-hour-offset zones (e.g.
  // IST +5:30 → "00:30, 03:30…"). Ceil windowStart up to the next local :00.
  const hours = useMemo(() => {
    const out: number[] = [];
    const d0 = new Date(windowStart);
    d0.setMinutes(0, 0, 0);
    if (d0.getTime() < windowStart) d0.setHours(d0.getHours() + 1);
    const stepH = span > 12 * HOUR_MS ? 3 : span > 4 * HOUR_MS ? 2 : 1;
    for (let t = d0.getTime(); t <= windowEnd; ) {
      out.push(t);
      const d = new Date(t);
      d.setHours(d.getHours() + stepH); // local-hour step (DST-safe)
      t = d.getTime();
    }
    return out;
  }, [windowStart, windowEnd, span]);

  const blocks = useMemo(() => {
    const out: Block[] = [];
    for (const c of coverage) {
      if (!c?.start) continue;
      const s = new Date(c.start).getTime();
      const e = c.end ? new Date(c.end).getTime() : s;
      const left = Math.max(0, (s - windowStart) / span);
      const right = Math.min(1, (e - windowStart) / span);
      if (right <= 0 || left >= 1 || right <= left) continue;
      out.push({
        key: `${c.start}-${c.end}`,
        leftPct: left * 100,
        widthPct: Math.max(0.3, (right - left) * 100),
        trigger: c.trigger_type || "continuous",
      });
    }
    return out;
  }, [coverage, windowStart, span]);

  // Event markers → ticks positioned by time, colored by severity.
  const markerTicks = useMemo(() => {
    const out: MarkerTick[] = [];
    for (const m of markers) {
      const t = m?.t ? new Date(m.t).getTime() : null;
      if (t == null || Number.isNaN(t)) continue;
      const pos = (t - windowStart) / span;
      if (pos < 0 || pos > 1) continue;
      out.push({
        key: m.event_id || `${m.t}-${m.event_type}`,
        leftPct: pos * 100,
        ms: t,
        fill: sevPreset(m.severity).fill,
        label: eventTypeLabel(m.event_type),
        severity: m.severity,
      });
    }
    return out;
  }, [markers, windowStart, span]);

  // Evidence-lock bands — a shaded amber span per active hold overlapping window.
  const lockBands = useMemo(() => {
    const out: LockBand[] = [];
    for (const l of locks) {
      const s = l?.start_ts ? new Date(l.start_ts).getTime() : null;
      const e = l?.end_ts ? new Date(l.end_ts).getTime() : null;
      if (s == null || e == null) continue;
      const left = Math.max(0, (s - windowStart) / span);
      const right = Math.min(1, (e - windowStart) / span);
      if (right <= 0 || left >= 1 || right <= left) continue;
      out.push({
        key: l.id || `${l.start_ts}-${l.end_ts}`,
        leftPct: left * 100,
        widthPct: Math.max(0.4, (right - left) * 100),
        label: l.case_ref ? `Evidence · ${l.case_ref}` : "Evidence hold",
      });
    }
    return out;
  }, [locks, windowStart, span]);

  // Bookmark flags — a pin at start_ts (point) plus a faint underline for ranges.
  const bookmarkFlags = useMemo(() => {
    const out: BookmarkFlag[] = [];
    for (const b of bookmarks) {
      const s = b?.start_ts ? new Date(b.start_ts).getTime() : null;
      if (s == null || Number.isNaN(s)) continue;
      const pos = (s - windowStart) / span;
      if (pos < 0 || pos > 1) continue;
      const e = b.end_ts ? new Date(b.end_ts).getTime() : null;
      const rightPct =
        e != null ? Math.min(1, (e - windowStart) / span) * 100 : null;
      out.push({
        key: b.id || `${b.start_ts}-${b.title}`,
        bm: b,
        leftPct: pos * 100,
        widthPct: rightPct != null ? Math.max(0.4, rightPct - pos * 100) : 0,
        ms: s,
        title: b.title,
      });
    }
    return out;
  }, [bookmarks, windowStart, span]);

  // G4 forensic motion-search hits — fuchsia intervals plotted along the track,
  // distinct from coverage/bookmarks/locks. A point hit (no end) gets a min width.
  const motionBands = useMemo(() => {
    const out: MotionBand[] = [];
    for (let i = 0; i < motionHits.length; i += 1) {
      const h = motionHits[i];
      const s = h?.start ? new Date(h.start).getTime() : null;
      if (s == null || Number.isNaN(s)) continue;
      const e = h.end ? new Date(h.end).getTime() : s;
      const left = Math.max(0, (s - windowStart) / span);
      const right = Math.min(1, (Math.max(e, s) - windowStart) / span);
      if (right <= 0 || left >= 1) continue;
      out.push({
        key: `${h.start}-${i}`,
        ms: s,
        leftPct: left * 100,
        widthPct: Math.max(0.5, (right - left) * 100),
        label: typeof h.score === "number" ? `Motion · ${(h.score * 100).toFixed(0)}%` : "Motion hit",
      });
    }
    return out;
  }, [motionHits, windowStart, span]);

  // Clip-extract selection band (mark-in / mark-out). Renders as an amber highlight
  // spanning [min,max] of the two marks (echoing the evidence-lock band styling), so
  // the operator SEES the section they're about to extract. Off unless both marks set.
  const selectionBand = useMemo(() => {
    if (selectionStart == null || selectionEnd == null) return null;
    const s = Math.min(selectionStart, selectionEnd);
    const e = Math.max(selectionStart, selectionEnd);
    const left = Math.max(0, (s - windowStart) / span);
    const right = Math.min(1, (e - windowStart) / span);
    if (right <= left) return null;
    return { leftPct: left * 100, widthPct: Math.max(0.4, (right - left) * 100) };
  }, [selectionStart, selectionEnd, windowStart, span]);

  const posToMs = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect?.width) return null;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(windowStart + pct * span);
    },
    [windowStart, span],
  );

  const emit = useCallback(
    (clientX: number) => {
      if (disabled) return;
      const ms = posToMs(clientX);
      if (ms != null) onSeek?.(ms);
    },
    [disabled, posToMs, onSeek],
  );

  const onDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    setDragging(true);
    emit(e.clientX);
    const move = (ev: MouseEvent) => emit(ev.clientX);
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHover({ pct, ms: windowStart + pct * span });
  };

  const currentPct =
    current != null ? Math.max(0, Math.min(100, ((current - windowStart) / span) * 100)) : null;

  return (
    <div className="select-none">
      {/* A SLIDER, and it can be driven from the keyboard.
          
          It was a div with mouse handlers: seeking a recording — the single most
          used control on a playback screen — existed only for a pointer. The ARIA
          slider role plus arrow keys is the standard answer, and the values are
          real ones (the window's own timestamps), so a screen reader announces
          where in the recording the playhead is rather than a bare percentage. */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Seek within the recording"
        aria-valuemin={windowStart}
        aria-valuemax={windowStart + span}
        aria-valuenow={current ?? windowStart}
        aria-disabled={disabled || undefined}
        onKeyDown={(e) => {
          if (disabled || current == null) return;
          const target = seekTarget(e.key, { windowStart, span, current });
          if (target == null) return;
          e.preventDefault();
          onSeek?.(target);
        }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className={`relative h-14 w-full overflow-hidden rounded-[10px] border border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.5)] ${
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        }`}
      >
        {/* Hour gridlines */}
        {hours.map((t) => (
          <div
            key={t}
            className="absolute bottom-0 top-0 w-px bg-[rgba(150,180,245,.18)]"
            style={{ left: `${((t - windowStart) / span) * 100}%` }}
          >
            <span className="absolute left-1 top-0.5 font-mono text-[9px] text-[#7e93bf]">
              {new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          </div>
        ))}

        {/* Evidence-lock bands — a shaded amber legal-hold span behind coverage */}
        {lockBands.map((l) => (
          <div
            key={l.key}
            title={l.label}
            className="absolute bottom-0 top-0 z-[5] border-x border-amber-500/50 bg-amber-500/15"
            style={{ left: `${l.leftPct}%`, width: `${l.widthPct}%` }}
          >
            <span className="absolute right-0.5 top-0.5 text-amber-400/90">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                <path
                  fillRule="evenodd"
                  d="M10 1a4 4 0 00-4 4v2H5a2 2 0 00-2 2v7a2 2 0 002 2h10a2 2 0 002-2v-7a2 2 0 00-2-2h-1V5a4 4 0 00-4-4zm2 6V5a2 2 0 10-4 0v2h4z"
                  clipRule="evenodd"
                />
              </svg>
            </span>
          </div>
        ))}

        {/* Clip-extract selection band (mark-in/out) — an amber highlight over the
            section to be extracted, with in/out edge handles. Behind coverage bars. */}
        {selectionBand && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-[6] border-x-2 border-amber-400 bg-amber-400/20"
            style={{ left: `${selectionBand.leftPct}%`, width: `${selectionBand.widthPct}%` }}
          />
        )}

        {/* Coverage blocks */}
        {blocks.map((b) => (
          <div
            key={b.key}
            className={`absolute bottom-2 top-6 rounded-xs ${blockColor(b.trigger)}`}
            style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
          />
        ))}

        {blocks.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-[#7e93bf]">
            No coverage in this window
          </div>
        )}

        {/* G4 forensic motion-search hits — fuchsia intervals; click seeks. */}
        {motionBands.map((h) => (
          <div
            key={h.key}
            role="button"
            tabIndex={-1}
            title={`${h.label} · ${hhmmss(h.ms)}`}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!disabled) onSeek?.(h.ms);
            }}
            onMouseEnter={() => setHitHover({ leftPct: h.leftPct, label: `${h.label} · ${hhmmss(h.ms)}` })}
            onMouseLeave={() => setHitHover(null)}
            className="absolute bottom-0.5 top-0.5 z-[13] cursor-pointer rounded-xs border border-fuchsia-400/70 bg-fuchsia-500/40 ring-1 ring-fuchsia-400/40 hover:bg-fuchsia-500/60"
            style={{ left: `${h.leftPct}%`, width: `${h.widthPct}%` }}
          />
        ))}

        {/* Motion-hit hover tooltip */}
        {hitHover && (
          <div
            className="pointer-events-none absolute -top-6 z-20 -translate-x-1/2 whitespace-nowrap rounded-sm bg-fuchsia-900/90 px-1.5 py-0.5 text-[10px] text-fuchsia-100"
            style={{ left: `${hitHover.leftPct}%` }}
          >
            {hitHover.label}
          </div>
        )}

        {/* Event markers — a tick per VmsEvent, colored by severity. Click seeks. */}
        {markerTicks.map((m) => (
          <div
            key={m.key}
            role="button"
            tabIndex={-1}
            title={`${m.label} · ${hhmmss(m.ms)}`}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!disabled) onSeek?.(m.ms);
            }}
            onMouseEnter={() =>
              setMarkerHover({ leftPct: m.leftPct, label: m.label, time: hhmmss(m.ms) })
            }
            onMouseLeave={() => setMarkerHover(null)}
            className="absolute top-1 z-[15] -translate-x-1/2 cursor-pointer"
            style={{ left: `${m.leftPct}%` }}
          >
            {/* Diamond tick */}
            <span
              className="block h-2.5 w-2.5 rotate-45 rounded-[2px] ring-1 ring-black/30"
              style={{ backgroundColor: m.fill }}
            />
            {/* Thin stem down into the track */}
            <span
              className="absolute left-1/2 top-2 h-8 w-px -translate-x-1/2 opacity-50"
              style={{ backgroundColor: m.fill }}
            />
          </div>
        ))}

        {/* Bookmark flags — a sky-blue pin at start_ts; a range gets a thin bar. */}
        {bookmarkFlags.map((f) => (
          <div key={f.key}>
            {f.widthPct > 0 && (
              <div
                className="pointer-events-none absolute bottom-1.5 z-[14] h-1 rounded-xs bg-sky-400/60"
                style={{ left: `${f.leftPct}%`, width: `${f.widthPct}%` }}
              />
            )}
            <button
              type="button"
              title={`${f.title} · ${hhmmss(f.ms)}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                if (disabled) return;
                onSeek?.(f.ms);
                onBookmarkClick?.(f.bm);
              }}
              onMouseEnter={() =>
                setBmHover({ leftPct: f.leftPct, title: f.title, time: hhmmss(f.ms) })
              }
              onMouseLeave={() => setBmHover(null)}
              className="absolute -bottom-0.5 z-[16] -translate-x-1/2 cursor-pointer text-sky-400 hover:text-sky-300"
              style={{ left: `${f.leftPct}%` }}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 drop-shadow-sm">
                <path d="M5 2a1 1 0 00-1 1v14a1 1 0 002 0v-4.586l1.293 1.293a1 1 0 001.414 0l1.586-1.586a1 1 0 011.414 0L14 13.414A1 1 0 0016 12.7V4.3a1 1 0 00-.553-.894L14 2.7V3a1 1 0 01-1.447.894l-1.106-.553a1 1 0 00-.894 0L9.447 3.894A1 1 0 018 3V2H5z" />
              </svg>
            </button>
          </div>
        ))}

        {/* Bookmark hover tooltip (title + time) */}
        {bmHover && (
          <div
            className="pointer-events-none absolute -bottom-6 z-20 -translate-x-1/2 whitespace-nowrap rounded-sm bg-sky-900/90 px-1.5 py-0.5 text-[10px] text-sky-100"
            style={{ left: `${bmHover.leftPct}%` }}
          >
            {bmHover.title} · {bmHover.time}
          </div>
        )}

        {/* Marker hover tooltip (event type + time) */}
        {markerHover && (
          <div
            className="pointer-events-none absolute -top-6 z-20 -translate-x-1/2 whitespace-nowrap rounded-sm bg-black/85 px-1.5 py-0.5 text-[10px] text-white"
            style={{ left: `${markerHover.leftPct}%` }}
          >
            {markerHover.label} · {markerHover.time}
          </div>
        )}

        {/* Hover indicator + time bubble */}
        {hover && !dragging && (
          <>
            <div
              className="pointer-events-none absolute bottom-0 top-5 w-px bg-[rgba(150,180,245,.4)]"
              style={{ left: `${hover.pct * 100}%` }}
            />
            <div
              className="pointer-events-none absolute -top-0.5 z-20 -translate-x-1/2 rounded-sm bg-black/80 px-1.5 py-0.5 text-[10px] text-white"
              style={{ left: `${hover.pct * 100}%` }}
            >
              {hhmmss(hover.ms)}
            </div>
          </>
        )}

        {/* Playhead */}
        {currentPct != null && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-[#22d3ee] shadow-[0_0_7px_rgba(34,211,238,.8)]"
            style={{ left: `${currentPct}%` }}
          >
            <div
              className={`absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-[#22d3ee] shadow-[0_0_6px_rgba(34,211,238,.9)] ${
                dragging ? "scale-125" : ""
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
