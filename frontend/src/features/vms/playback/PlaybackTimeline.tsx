"use client";

// PlaybackTimeline — the investigation track under the grid (SCRUM-305).
//
// One master lane ("All cameras") over one lane per camera, as Milestone's
// two-track timeline and HikCentral's per-channel bars do, so an operator can see
// at a glance WHICH camera has footage at an instant instead of a single merged bar
// that hides a camera with a gap.
//
//   wheel            zoom around the cursor (30 s … 7 d)
//   shift + wheel    pan
//   drag             pan
//   shift + drag     select a range (IN / OUT)
//   click            seek the active tile's controller there
//   click a lane     also makes that camera the active tile
//
// The playhead is not React state: it follows the active controller's clock through
// a subscription that moves one element, several times a second.
import { useEffect, useMemo, useRef, useState } from "react";

import type { WallClock } from "../hooks/useWallPlayback";
import {
  TRIGGERS,
  clockText,
  fracToTime,
  ticksFor,
  timeToFrac,
  type Span,
  type TriggerKey,
  type Win,
} from "./playbackModel";

export interface TimelineLane {
  key: string;
  name: string;
  spans: Span[];
  /** Event instants on this camera (epoch ms). */
  events: number[];
  /** Bookmark instants on this camera (epoch ms), from its recorder. */
  bookmarks: number[];
  /** Motion-search hits on this camera. */
  hits: { s: number; e: number }[];
  active: boolean;
  independent: boolean;
  /** The recorder did not answer for this camera's coverage. */
  failed?: boolean;
}

export interface PlaybackTimelineProps {
  win: Win;
  lanes: TimelineLane[];
  clock: WallClock;
  inMs: number | null;
  outMs: number | null;
  /** Coverage colours shown; a hidden trigger's spans are not drawn. */
  triggers: ReadonlySet<TriggerKey>;
  showEvents: boolean;
  onSeek: (ms: number) => void;
  onActivate: (key: string) => void;
  onZoom: (factor: number, centerMs: number) => void;
  onPan: (deltaMs: number) => void;
  onSelect: (a: number, b: number) => void;
}

const LABEL_W = 136;
const DRAG_PX = 4;

type Drag =
  | { mode: "pending" | "pan"; x0: number; lastX: number; lane: string | null }
  | { mode: "select"; t0: number };

export default function PlaybackTimeline({
  win,
  lanes,
  clock,
  inMs,
  outMs,
  triggers,
  showEvents,
  onSeek,
  onActivate,
  onZoom,
  onPan,
  onSelect,
}: Readonly<PlaybackTimelineProps>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const headLabelRef = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const dragRef = useRef<Drag | null>(null);

  // Track width, for tick density and pixel ↔ time.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    setWidth(el.clientWidth || 800);
    return () => ro.disconnect();
  }, []);

  // "Now" moves; the future tint and the live line follow it.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  // The playhead, outside React.
  const winRef = useRef(win);
  useEffect(() => {
    winRef.current = win;
  }, [win]);
  useEffect(
    () =>
      clock.subscribe((ms) => {
        const head = headRef.current;
        if (!head) return;
        if (ms == null) {
          head.style.display = "none";
          return;
        }
        const f = timeToFrac(winRef.current, ms);
        head.style.display = f < 0 || f > 1 ? "none" : "block";
        head.style.left = `${f * 100}%`;
        if (headLabelRef.current) headLabelRef.current.textContent = clockText(ms);
      }),
    [clock],
  );
  // Re-place it when the window moves under a paused playhead.
  useEffect(() => {
    const ms = clock.get();
    const head = headRef.current;
    if (!head || ms == null) return;
    const f = timeToFrac(win, ms);
    head.style.display = f < 0 || f > 1 ? "none" : "block";
    head.style.left = `${f * 100}%`;
  }, [win, clock]);

  const ticks = useMemo(() => ticksFor(win, width), [win, width]);
  const timeAtX = (x: number) => fracToTime(win, x / Math.max(1, width));
  const msPerPx = (win.toMs - win.fromMs) / Math.max(1, width);

  // Wheel: a non-passive listener, because the page must not scroll under a zoom.
  const zoomRef = useRef(onZoom);
  const panRef = useRef(onPan);
  useEffect(() => {
    zoomRef.current = onZoom;
    panRef.current = onPan;
  });
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const w = winRef.current;
      const at = fracToTime(w, (e.clientX - rect.left) / Math.max(1, rect.width));
      const span = w.toMs - w.fromMs;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = e.shiftKey ? e.deltaY : e.deltaX;
        panRef.current((d / Math.max(1, rect.width)) * span);
      } else {
        zoomRef.current(e.deltaY > 0 ? 1.25 : 0.8, at);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const localX = (e: React.PointerEvent) => e.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0);
  const laneAt = (e: React.PointerEvent): string | null =>
    (e.target as HTMLElement).closest<HTMLElement>("[data-lane]")?.dataset.lane ?? null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = localX(e);
    dragRef.current = e.shiftKey
      ? { mode: "select", t0: timeAtX(x) }
      : { mode: "pending", x0: x, lastX: x, lane: laneAt(e) };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const x = localX(e);
    setHoverX(x);
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "select") {
      onSelect(d.t0, timeAtX(x));
      return;
    }
    if (d.mode === "pending" && Math.abs(x - d.x0) < DRAG_PX) return;
    d.mode = "pan";
    onPan(-(x - d.lastX) * msPerPx);
    d.lastX = x;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.mode !== "pending") return;
    if (d.lane && d.lane !== "__all") onActivate(d.lane);
    onSeek(timeAtX(localX(e)));
  };

  const hoverMs = hoverX == null ? null : timeAtX(hoverX);
  const nowF = timeToFrac(win, now);
  const sel = inMs != null && outMs != null && outMs > inMs ? { a: inMs, b: outMs } : null;
  const allSpans = useMemo(() => lanes.flatMap((l) => l.spans), [lanes]);
  const allEvents = useMemo(() => lanes.flatMap((l) => l.events), [lanes]);
  const allBookmarks = useMemo(() => lanes.flatMap((l) => l.bookmarks), [lanes]);
  const allHits = useMemo(() => lanes.flatMap((l) => l.hits), [lanes]);
  // Sixteen lanes must not push the video off the screen.
  let laneH = "h-4";
  if (lanes.length > 9) laneH = "h-2";
  else if (lanes.length > 4) laneH = "h-3";

  return (
    <div className="select-none text-[11px] text-[#9db0d8]">
      <div className="flex">
        {/* Lane labels */}
        <div className="shrink-0 pr-2" style={{ width: LABEL_W }}>
          <div className="h-6" />
          <div className="flex h-4 items-center text-[10.5px] font-semibold uppercase tracking-wide text-[#f2f6ff]">
            All cameras
          </div>
          <div>
            {lanes.map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => onActivate(l.key)}
                title={l.failed ? `${l.name}: the recorder did not answer` : l.name}
                className={`mt-0.5 flex w-full items-center gap-1 truncate text-left ${laneH} ${
                  lanes.length > 9 ? "text-[9px] leading-none" : ""
                } ${
                  l.active ? "text-[#67e8f9]" : "hover:text-[#f2f6ff]"
                }`}
              >
                {l.independent && <span className="text-[9px] font-bold text-amber-300">IND</span>}
                {l.failed && <span className="text-[9px] text-amber-300">!</span>}
                <span className="truncate">{l.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Track */}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={-1}
          aria-label="Playback timeline"
          aria-valuemin={win.fromMs}
          aria-valuemax={win.toMs}
          aria-valuenow={clock.get() ?? win.fromMs}
          className="relative min-w-0 flex-1 cursor-crosshair touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHoverX(null)}
        >
          {/* Ruler */}
          <div className="relative h-6 border-b border-[rgba(160,150,245,.22)]">
            {ticks.map((t) => (
              <div
                key={t.t}
                className="absolute bottom-0 flex flex-col items-start"
                style={{ left: `${timeToFrac(win, t.t) * 100}%` }}
              >
                <span
                  className={`-translate-x-1/2 whitespace-nowrap tabular-nums ${
                    t.major ? "font-semibold text-[#f2f6ff]" : ""
                  }`}
                >
                  {t.label}
                </span>
                <span className={`w-px ${t.major ? "h-2 bg-[#f2f6ff]/60" : "h-1.5 bg-[#9db0d8]/50"}`} />
              </div>
            ))}
          </div>

          {/* Master lane */}
          <Lane
            laneKey="__all"
            spans={allSpans}
            events={showEvents ? allEvents : []}
            bookmarks={allBookmarks}
            hits={allHits}
            win={win}
            triggers={triggers}
            className="h-4"
          />
          {/* Per-camera lanes, row for row with their labels */}
          <div>
            {lanes.map((l) => (
              <Lane
                key={l.key}
                laneKey={l.key}
                spans={l.spans}
                events={showEvents ? l.events : []}
                bookmarks={l.bookmarks}
                hits={l.hits}
                win={win}
                triggers={triggers}
                active={l.active}
                className={`mt-0.5 ${laneH}`}
              />
            ))}
          </div>

          {/* The future: nothing is recorded there yet. */}
          {nowF < 1 && (
            <div
              className="pointer-events-none absolute bottom-0 top-6 bg-[repeating-linear-gradient(135deg,rgba(150,180,245,.06)_0_4px,transparent_4px_8px)]"
              style={{ left: `${Math.max(0, nowF) * 100}%`, right: 0 }}
            />
          )}
          {nowF >= 0 && nowF <= 1 && (
            <div
              className="pointer-events-none absolute bottom-0 top-6 w-px bg-red-400/70"
              style={{ left: `${nowF * 100}%` }}
              title="Now"
            />
          )}

          {/* IN / OUT selection */}
          {sel && (
            <div
              className="pointer-events-none absolute bottom-0 top-6 border-x border-amber-400 bg-amber-400/15"
              style={{
                left: `${Math.max(0, timeToFrac(win, sel.a)) * 100}%`,
                right: `${Math.max(0, 1 - timeToFrac(win, sel.b)) * 100}%`,
              }}
            />
          )}
          {inMs != null && !sel && (
            <div
              className="pointer-events-none absolute bottom-0 top-6 w-0.5 bg-amber-400"
              style={{ left: `${timeToFrac(win, inMs) * 100}%` }}
            />
          )}

          {/* Hover readout */}
          {hoverMs != null && (
            <div className="pointer-events-none absolute bottom-0 top-0" style={{ left: hoverX ?? 0 }}>
              <div className="absolute bottom-0 top-6 w-px bg-white/30" />
              <span className="absolute -top-5 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 tabular-nums text-white">
                {clockText(hoverMs)}
              </span>
            </div>
          )}

          {/* Playhead */}
          <div ref={headRef} className="pointer-events-none absolute bottom-0 top-0 hidden">
            <div className="absolute bottom-0 top-5 w-0.5 -translate-x-1/2 bg-[#22d3ee]" />
            <span
              ref={headLabelRef}
              className="absolute top-0 -translate-x-1/2 rounded bg-[#22d3ee] px-1 text-[10px] font-semibold tabular-nums text-[#04111f]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

interface LaneProps {
  laneKey: string;
  spans: Span[];
  events: number[];
  bookmarks: number[];
  hits: { s: number; e: number }[];
  win: Win;
  triggers: ReadonlySet<TriggerKey>;
  active?: boolean;
  className?: string;
}

function Lane({
  laneKey,
  spans,
  events,
  bookmarks,
  hits,
  win,
  triggers,
  active = false,
  className = "",
}: Readonly<LaneProps>) {
  return (
    <div
      data-lane={laneKey}
      className={`relative overflow-hidden rounded-[3px] ${
        active ? "bg-[rgba(34,211,238,.12)] ring-1 ring-inset ring-[rgba(34,211,238,.45)]" : "bg-[rgba(150,180,245,.06)]"
      } ${className}`}
    >
      {spans.map((sp) => {
        if (!triggers.has(sp.trigger) || sp.e < win.fromMs || sp.s > win.toMs) return null;
        const a = Math.max(0, timeToFrac(win, sp.s));
        const b = Math.min(1, timeToFrac(win, sp.e));
        return (
          <span
            key={`${sp.s}-${sp.trigger}`}
            className="pointer-events-none absolute bottom-0 top-0"
            style={{
              left: `${a * 100}%`,
              width: `max(1px, ${(b - a) * 100}%)`,
              background: TRIGGERS[sp.trigger].hex,
              opacity: 0.8,
            }}
          />
        );
      })}
      {hits.map((h) => {
        if (h.e < win.fromMs || h.s > win.toMs) return null;
        const a = Math.max(0, timeToFrac(win, h.s));
        const b = Math.min(1, timeToFrac(win, h.e));
        return (
          <span
            key={`hit-${h.s}`}
            className="pointer-events-none absolute bottom-0 top-0 border-x-2 border-[#4ade80] bg-[#4ade80]/25"
            style={{ left: `${a * 100}%`, width: `max(3px, ${(b - a) * 100}%)` }}
          />
        );
      })}
      {events.map((t) => {
        const f = timeToFrac(win, t);
        if (f < 0 || f > 1) return null;
        return (
          <span
            key={t}
            className="pointer-events-none absolute top-0 h-full w-0.5 bg-[#fde047]"
            style={{ left: `${f * 100}%` }}
          />
        );
      })}
      {bookmarks.map((t) => {
        const f = timeToFrac(win, t);
        if (f < 0 || f > 1) return null;
        return (
          <span
            key={`bm-${t}`}
            className="pointer-events-none absolute top-0 h-full w-1 -translate-x-1/2 rounded-sm bg-[#38bdf8]"
            style={{ left: `${f * 100}%` }}
          />
        );
      })}
    </div>
  );
}
