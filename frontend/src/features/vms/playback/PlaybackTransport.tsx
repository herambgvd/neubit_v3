"use client";

// PlaybackTransport — the controls under the timeline (SCRUM-305/306).
//
// The set every professional client carries, in the order operators expect:
// previous/next recording and event, ±10 s, frame step, play/pause, speed (slow
// motion, fast, reverse), the date and time, live edge, the zoom ladder, and the
// IN/OUT range that feeds export. Everything acts on the ACTIVE tile's controller:
// the grid when the active tile is synced, that tile alone when it is independent.
import { useEffect, useRef } from "react";
import { Icon } from "@iconify/react";

import type { WallClock } from "../hooks/useWallPlayback";
import { ZOOM_LEVELS, clockText, durationText, localDay, nearestZoom, speedText, type Win } from "./playbackModel";

export interface PlaybackTransportProps {
  clock: WallClock;
  playing: boolean;
  speed: number;
  maxSpeed: number;
  canReverse: boolean;
  /** "Grid" or the independent tile's name. */
  target: string;
  win: Win;
  inMs: number | null;
  outMs: number | null;
  canExport: boolean;
  canProtect: boolean;
  onTogglePlay: () => void;
  onSkip: (seconds: number) => void;
  onFrame: (dir: -1 | 1) => void;
  onSpeedStep: (dir: -1 | 1) => void;
  onReverse: () => void;
  onPrevRecording: () => void;
  onNextRecording: () => void;
  onPrevEvent: () => void;
  onNextEvent: () => void;
  onLiveEdge: () => void;
  onSpan: (seconds: number) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onClearSel: () => void;
  onExport: () => void;
  onProtect: () => void;
}

export default function PlaybackTransport(p: Readonly<PlaybackTransportProps>) {
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const dayRef = useRef<HTMLSpanElement | null>(null);

  // The readout follows the clock without re-rendering the bar.
  useEffect(
    () =>
      p.clock.subscribe((ms) => {
        if (timeRef.current) timeRef.current.textContent = clockText(ms);
        if (dayRef.current) dayRef.current.textContent = ms == null ? "" : localDay(ms);
      }),
    [p.clock],
  );

  const zoomNow = nearestZoom(p.win);
  const hasSel = p.inMs != null && p.outMs != null && p.outMs > p.inMs;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
      {/* Navigation */}
      <div className="flex items-center gap-0.5">
        <Btn icon="heroicons-solid:backward" title="Previous recording (Home)" onClick={p.onPrevRecording} />
        <Btn icon="heroicons-outline:flag" flip title="Previous event (Alt+←)" onClick={p.onPrevEvent} />
        <Btn label="−10s" title="Back 10 seconds (Shift+←)" onClick={() => p.onSkip(-10)} />
        <Btn icon="heroicons-solid:chevron-left" title="Previous frame (,)" onClick={() => p.onFrame(-1)} />
        <button
          type="button"
          onClick={p.onTogglePlay}
          title="Play / pause (Space)"
          aria-label={p.playing ? "Pause" : "Play"}
          className="mx-1 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#22d3ee] text-[#04111f] transition hover:bg-[#67e8f9]"
        >
          <Icon icon={p.playing ? "heroicons-solid:pause" : "heroicons-solid:play"} className="text-lg" />
        </button>
        <Btn icon="heroicons-solid:chevron-right" title="Next frame (.)" onClick={() => p.onFrame(1)} />
        <Btn label="+10s" title="Forward 10 seconds (Shift+→)" onClick={() => p.onSkip(10)} />
        <Btn icon="heroicons-outline:flag" title="Next event (Alt+→)" onClick={p.onNextEvent} />
        <Btn icon="heroicons-solid:forward" title="Next recording" onClick={p.onNextRecording} />
      </div>

      {/* Speed */}
      <div className="flex items-center gap-0.5 rounded-lg border border-[rgba(160,150,245,.22)] px-1">
        <Btn
          icon="heroicons-solid:arrow-uturn-left"
          title={p.canReverse ? "Reverse play" : "Reverse play works with up to 4 cameras"}
          on={p.speed < 0}
          disabled={!p.canReverse}
          onClick={p.onReverse}
        />
        <Btn icon="heroicons-solid:minus" title="Slower (PgDn)" onClick={() => p.onSpeedStep(-1)} />
        <span
          className={`w-12 text-center text-[12px] font-semibold tabular-nums ${
            p.speed === 1 ? "text-[#f2f6ff]" : "text-[#67e8f9]"
          }`}
          title={`Up to ${p.maxSpeed}× with this many tiles`}
        >
          {speedText(p.speed)}
        </span>
        <Btn icon="heroicons-solid:plus" title="Faster (PgUp)" onClick={() => p.onSpeedStep(1)} />
      </div>

      {/* Date and time */}
      <div className="flex flex-col items-center leading-tight">
        <span ref={timeRef} className="text-[15px] font-semibold tabular-nums text-[#f2f6ff]">
          --:--:--
        </span>
        <span className="text-[10px] tabular-nums text-[#9db0d8]">
          <span ref={dayRef} /> · {p.target}
        </span>
      </div>

      <button
        type="button"
        onClick={p.onLiveEdge}
        title="Jump to the live edge (End)"
        className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 px-2 py-1 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/10"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> LIVE
      </button>

      {/* Zoom ladder */}
      <div className="flex items-center gap-0.5">
        {ZOOM_LEVELS.map((z) => (
          <button
            key={z.label}
            type="button"
            onClick={() => p.onSpan(z.seconds)}
            className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums transition ${
              z.label === zoomNow.label
                ? "bg-[rgba(34,211,238,.15)] font-semibold text-[#67e8f9]"
                : "text-[#9db0d8] hover:text-[#f2f6ff]"
            }`}
          >
            {z.label}
          </button>
        ))}
      </div>

      {/* IN / OUT → export */}
      <div className="flex items-center gap-0.5 border-l border-[rgba(160,150,245,.22)] pl-2">
        <Btn label="IN" title="Mark in ([)" onClick={p.onMarkIn} />
        <Btn label="OUT" title="Mark out (])" onClick={p.onMarkOut} />
        {hasSel && (
          <span className="mx-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] tabular-nums text-amber-300">
            {clockText(p.inMs)}–{clockText(p.outMs)} ({durationText((p.outMs ?? 0) - (p.inMs ?? 0))})
          </span>
        )}
        <Btn
          icon="heroicons-outline:shield-check"
          title={
            hasSel
              ? "Protect the marked range on every camera in the grid (evidence hold — retention will not delete it)"
              : "Mark IN and OUT to protect a range"
          }
          disabled={!hasSel || !p.canProtect}
          onClick={p.onProtect}
        />
        <Btn
          icon="heroicons-outline:arrow-down-tray"
          title={hasSel ? "Export the marked range of the active camera" : "Mark IN and OUT (or Shift+drag the timeline) to export"}
          disabled={!hasSel || !p.canExport}
          onClick={p.onExport}
        />
        {(p.inMs != null || p.outMs != null) && (
          <Btn icon="heroicons-outline:x-mark" title="Clear the range" onClick={p.onClearSel} />
        )}
      </div>
    </div>
  );
}

interface BtnProps {
  icon?: string;
  label?: string;
  title: string;
  on?: boolean;
  flip?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function Btn({ icon, label, title, on = false, flip = false, disabled = false, onClick }: Readonly<BtnProps>) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on || undefined}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 transition hover:bg-[rgba(150,180,245,.08)] disabled:pointer-events-none disabled:opacity-40 ${
        on ? "text-[#67e8f9]" : "text-[#9db0d8] hover:text-[#f2f6ff]"
      }`}
    >
      {label ? (
        <span className="text-[11px] font-semibold tabular-nums">{label}</span>
      ) : (
        <Icon icon={icon ?? ""} className={`text-[15px] ${flip ? "-scale-x-100" : ""}`} />
      )}
    </button>
  );
}
