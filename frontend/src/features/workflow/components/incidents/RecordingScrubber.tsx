"use client";

// THE TRANSPORT UNDER THE RECORDING.
//
// The evidence tile played the minute around the event and stopped. An operator
// could not go back to watch the moment again, could not step to where the view
// actually changed, could not slow it down — on the one picture the whole case
// turns on.
//
// So: play/pause, ten seconds either way, a speed ladder, and a bar across the
// window with two things drawn on it that a plain slider would not carry —
//
//   * THE EVENT, marked, because the window is eight seconds of run-up and a
//     minute of aftermath and the operator needs to know which part is which;
//   * WHERE THE RECORDER ACTUALLY HAS FOOTAGE. On an estate that does not record
//     every camera continuously, a bar that hides the hole makes "nothing was
//     recorded" look exactly like "nothing happened". The covered stretches are
//     drawn solid; the rest is visibly empty.
//
// It drives the tile through the props that already exist — a seek is a new
// anchor, so there is no second playback path to keep in step.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

import type { PlaybackRange } from "@/features/vms/types";
import type { WallClock } from "@/features/vms/hooks/useWallPlayback";

export const SCRUB_SPEEDS = [0.5, 1, 2, 4] as const;

export interface RecordingScrubberProps {
  fromMs: number;
  toMs: number;
  /** The instant the alarm was raised from — the point of the whole window. */
  eventMs: number;
  /** Published by the tile itself, so the playhead is where the video is. */
  clock: WallClock;
  playing: boolean;
  speed: number;
  onSeek: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSpeedChange: (speed: number) => void;
  /** The recorder's own coverage for this window; empty until it answers. */
  ranges?: PlaybackRange[];
}

/** A range as a fraction of the window, clipped to it. `null` when it falls
 *  outside entirely — the recorder answers about a wider span than we asked. */
export function rangeBand(
  r: PlaybackRange,
  fromMs: number,
  toMs: number,
): { left: number; width: number } | null {
  const span = toMs - fromMs;
  if (span <= 0) return null;
  const start = new Date(r.start).getTime();
  if (!Number.isFinite(start)) return null;
  const end = start + (Number(r.duration) || 0) * 1000;
  const a = Math.max(start, fromMs);
  const b = Math.min(end, toMs);
  if (b <= a) return null;
  return { left: ((a - fromMs) / span) * 100, width: ((b - a) / span) * 100 };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** mm:ss from the start of the window — an operator reads "18 seconds in", not
 *  a wall-clock time they have to subtract in their head. */
export function offsetLabel(ms: number, fromMs: number): string {
  const s = Math.max(0, Math.round((ms - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function RecordingScrubber({
  fromMs,
  toMs,
  eventMs,
  clock,
  playing,
  speed,
  onSeek,
  onPlayingChange,
  onSpeedChange,
  ranges = [],
}: RecordingScrubberProps) {
  // The playhead comes FROM the tile, not from a timer of our own: two clocks
  // would drift apart and the bar would stop describing the picture.
  const [head, setHead] = useState<number | null>(() => clock.get());
  useEffect(() => clock.subscribe(setHead), [clock]);

  const span = Math.max(1, toMs - fromMs);
  const pct = (ms: number) => clamp(((ms - fromMs) / span) * 100, 0, 100);
  const at = head ?? fromMs;

  const seekTo = (ms: number) => onSeek(clamp(ms, fromMs, toMs));

  const bands = ranges.map((r) => rangeBand(r, fromMs, toMs)).filter(Boolean) as {
    left: number;
    width: number;
  }[];

  return (
    <div className="grid gap-1.5 px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => seekTo(at - 10_000)}
          title="Back ten seconds"
          aria-label="Back ten seconds"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-mini:chevron-double-left" className="text-xs" />
        </button>
        <button
          type="button"
          onClick={() => onPlayingChange(!playing)}
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-blue-500/40 bg-blue-500/10 text-blue-200 transition hover:bg-blue-500/20"
        >
          <Icon
            icon={playing ? "heroicons-outline:pause" : "heroicons-outline:play"}
            className="text-xs"
          />
        </button>
        <button
          type="button"
          onClick={() => seekTo(at + 10_000)}
          title="Forward ten seconds"
          aria-label="Forward ten seconds"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-mini:chevron-double-right" className="text-xs" />
        </button>

        <button
          type="button"
          onClick={() => seekTo(eventMs)}
          title="Back to the moment it fired"
          className="ml-1 inline-flex items-center gap-1 rounded-md border border-card-border px-1.5 py-0.5 text-[10.5px] text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:bolt" className="text-[11px]" /> Event
        </button>

        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted">
          {offsetLabel(at, fromMs)} / {offsetLabel(toMs, fromMs)}
        </span>

        <select
          aria-label="Playback speed"
          value={speed}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
          className="h-6 rounded-md border border-field bg-transparent px-1 text-[10.5px] text-foreground outline-hidden"
        >
          {SCRUB_SPEEDS.map((sp) => (
            <option key={sp} value={sp}>
              {sp}×
            </option>
          ))}
        </select>
      </div>

      {/* The bar. A range input carries the keyboard and the drag for free; the
          coverage, the event mark and the playhead are drawn under it. */}
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1.5 h-2 overflow-hidden rounded-full bg-hover">
          {bands.map((b, i) => (
            <span
              key={i}
              className="absolute inset-y-0 bg-blue-500/40"
              style={{ left: `${b.left}%`, width: `${b.width}%` }}
            />
          ))}
        </div>
        <span
          className="pointer-events-none absolute top-0 h-5 w-px bg-red-400"
          style={{ left: `${pct(eventMs)}%` }}
          title="When it fired"
          aria-hidden
        />
        <span
          className="pointer-events-none absolute top-0.5 h-4 w-[3px] rounded-full bg-blue-300"
          style={{ left: `calc(${pct(at)}% - 1.5px)` }}
          aria-hidden
        />
        <input
          type="range"
          min={fromMs}
          max={toMs}
          step={250}
          value={at}
          onChange={(e) => seekTo(Number(e.target.value))}
          aria-label="Seek the recording"
          className="absolute inset-0 h-5 w-full cursor-pointer opacity-0"
        />
      </div>

      {ranges.length > 0 && bands.length === 0 && (
        // Said plainly: the bar is empty because the recorder holds nothing here,
        // not because the bar failed to load.
        <span className="text-[10.5px] text-amber-400">
          The recorder holds no footage in this window.
        </span>
      )}
    </div>
  );
}
