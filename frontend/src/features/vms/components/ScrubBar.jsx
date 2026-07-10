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
//   windowStart / windowEnd     — epoch ms, the visible track range
//   current                     — epoch ms, the playhead
//   onSeek(ms)                  — click/drag (or click a marker) to a timestamp
//   onBookmarkClick(bm)         — click a bookmark flag → seek + open its popover
import { useCallback, useMemo, useRef, useState } from "react";

import { SEVERITY_PRESETS } from "../constants";
import { eventTypeLabel } from "../eventLib";

const HOUR_MS = 3_600_000;

// Coverage-block color by trigger, falling back to the neutral accent.
const BLOCK_COLOR = {
  continuous: "bg-blue-500/70",
  schedule: "bg-indigo-500/70",
  motion: "bg-emerald-500/70",
  event: "bg-amber-500/70",
  manual: "bg-foreground/40",
};

// Marker tick color by severity (falls back to info blue).
const MARKER_FILL = {
  critical: SEVERITY_PRESETS.critical.fill,
  warning: SEVERITY_PRESETS.warning.fill,
  info: SEVERITY_PRESETS.info.fill,
};

function hhmmss(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export default function ScrubBar({
  coverage = [],
  markers = [],
  bookmarks = [],
  locks = [],
  windowStart,
  windowEnd,
  current,
  onSeek,
  onBookmarkClick,
  disabled = false,
}) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(null); // { pct, ms }
  const [markerHover, setMarkerHover] = useState(null); // { leftPct, label, time }
  const [bmHover, setBmHover] = useState(null); // { leftPct, title, time }

  const span = Math.max(1, windowEnd - windowStart);

  // How many hour gridlines fit — cap the labels so they don't crowd.
  const hours = useMemo(() => {
    const out = [];
    const startHour = Math.ceil(windowStart / HOUR_MS) * HOUR_MS;
    const step = span > 12 * HOUR_MS ? 3 * HOUR_MS : span > 4 * HOUR_MS ? 2 * HOUR_MS : HOUR_MS;
    for (let t = startHour; t <= windowEnd; t += step) out.push(t);
    return out;
  }, [windowStart, windowEnd, span]);

  const blocks = useMemo(() => {
    const out = [];
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
        trigger: c.trigger || c.trigger_type || "continuous",
      });
    }
    return out;
  }, [coverage, windowStart, span]);

  // Event markers → ticks positioned by time, colored by severity.
  const markerTicks = useMemo(() => {
    const out = [];
    for (const m of markers) {
      const t = m?.t ? new Date(m.t).getTime() : null;
      if (t == null || Number.isNaN(t)) continue;
      const pos = (t - windowStart) / span;
      if (pos < 0 || pos > 1) continue;
      out.push({
        key: m.event_id || `${m.t}-${m.event_type}`,
        leftPct: pos * 100,
        ms: t,
        fill: MARKER_FILL[m.severity] || MARKER_FILL.info,
        label: eventTypeLabel(m.event_type),
        severity: m.severity,
      });
    }
    return out;
  }, [markers, windowStart, span]);

  // Evidence-lock bands — a shaded amber span per active hold overlapping window.
  const lockBands = useMemo(() => {
    const out = [];
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
    const out = [];
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

  const posToMs = useCallback(
    (clientX) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect?.width) return null;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(windowStart + pct * span);
    },
    [windowStart, span],
  );

  const emit = useCallback(
    (clientX) => {
      if (disabled) return;
      const ms = posToMs(clientX);
      if (ms != null) onSeek?.(ms);
    },
    [disabled, posToMs, onSeek],
  );

  const onDown = (e) => {
    if (disabled) return;
    setDragging(true);
    emit(e.clientX);
    const move = (ev) => emit(ev.clientX);
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onMove = (e) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHover({ pct, ms: windowStart + pct * span });
  };

  const currentPct =
    current != null ? Math.max(0, Math.min(100, ((current - windowStart) / span) * 100)) : null;

  return (
    <div className="select-none">
      <div
        ref={trackRef}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className={`relative h-14 w-full overflow-hidden rounded-lg border border-card-border bg-hover/40 ${
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        }`}
      >
        {/* Hour gridlines */}
        {hours.map((t) => (
          <div
            key={t}
            className="absolute bottom-0 top-0 w-px bg-card-border/50"
            style={{ left: `${((t - windowStart) / span) * 100}%` }}
          >
            <span className="absolute left-1 top-0.5 text-[9px] text-muted">
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

        {/* Coverage blocks */}
        {blocks.map((b) => (
          <div
            key={b.key}
            className={`absolute bottom-2 top-6 rounded-sm ${BLOCK_COLOR[b.trigger] || "bg-blue-500/70"}`}
            style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
          />
        ))}

        {blocks.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted">
            No coverage in this window
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
                className="pointer-events-none absolute bottom-1.5 z-[14] h-1 rounded-sm bg-sky-400/60"
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
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 drop-shadow">
                <path d="M5 2a1 1 0 00-1 1v14a1 1 0 002 0v-4.586l1.293 1.293a1 1 0 001.414 0l1.586-1.586a1 1 0 011.414 0L14 13.414A1 1 0 0016 12.7V4.3a1 1 0 00-.553-.894L14 2.7V3a1 1 0 01-1.447.894l-1.106-.553a1 1 0 00-.894 0L9.447 3.894A1 1 0 018 3V2H5z" />
              </svg>
            </button>
          </div>
        ))}

        {/* Bookmark hover tooltip (title + time) */}
        {bmHover && (
          <div
            className="pointer-events-none absolute -bottom-6 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-sky-900/90 px-1.5 py-0.5 text-[10px] text-sky-100"
            style={{ left: `${bmHover.leftPct}%` }}
          >
            {bmHover.title} · {bmHover.time}
          </div>
        )}

        {/* Marker hover tooltip (event type + time) */}
        {markerHover && (
          <div
            className="pointer-events-none absolute -top-6 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-[10px] text-white"
            style={{ left: `${markerHover.leftPct}%` }}
          >
            {markerHover.label} · {markerHover.time}
          </div>
        )}

        {/* Hover indicator + time bubble */}
        {hover && !dragging && (
          <>
            <div
              className="pointer-events-none absolute bottom-0 top-5 w-px bg-foreground/40"
              style={{ left: `${hover.pct * 100}%` }}
            />
            <div
              className="pointer-events-none absolute -top-0.5 z-20 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[10px] text-white"
              style={{ left: `${hover.pct * 100}%` }}
            >
              {hhmmss(hover.ms)}
            </div>
          </>
        )}

        {/* Playhead */}
        {currentPct != null && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-red-500"
            style={{ left: `${currentPct}%` }}
          >
            <div
              className={`absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-red-500 shadow ${
                dragging ? "scale-125" : ""
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
