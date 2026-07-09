"use client";

// Coverage strip — a 24-hour bar for a single camera-day showing which minutes
// have recordings. Ported from gvd_nvr's timeline concept (coverage only; full
// scrub playback lands in P4). Each recording paints a colored span across the
// bar proportional to its start/end within the day.
import { useMemo } from "react";
import { Icon } from "@iconify/react";

import { TRIGGER_PRESETS } from "../constants";

const DAY_MS = 24 * 60 * 60 * 1000;
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

// Trigger → a solid bar color (Tailwind bg-*). Falls back to the muted color.
const BAR_COLOR = {
  continuous: "bg-blue-500",
  schedule: "bg-indigo-500",
  motion: "bg-emerald-500",
  event: "bg-amber-500",
  manual: "bg-foreground/60",
};

export default function RecordingTimeline({ recordings = [], day }) {
  // The day window [00:00, 24:00) in epoch ms. `day` is a "YYYY-MM-DD" string;
  // when absent, use the first recording's date.
  const dayStart = useMemo(() => {
    const base = day
      ? new Date(`${day}T00:00:00`)
      : recordings[0]?.start_time
        ? new Date(recordings[0].start_time)
        : new Date();
    base.setHours(0, 0, 0, 0);
    return base.getTime();
  }, [day, recordings]);

  const spans = useMemo(() => {
    const out = [];
    for (const r of recordings) {
      if (!r.start_time) continue;
      const s = new Date(r.start_time).getTime();
      const e = r.end_time ? new Date(r.end_time).getTime() : s + (r.duration || 0) * 1000;
      // Clip to the day window.
      const left = Math.max(0, (s - dayStart) / DAY_MS);
      const right = Math.min(1, (e - dayStart) / DAY_MS);
      if (right <= 0 || left >= 1 || right <= left) continue;
      out.push({
        id: r.id,
        leftPct: left * 100,
        widthPct: Math.max(0.4, (right - left) * 100),
        trigger: r.trigger_type,
      });
    }
    return out;
  }, [recordings, dayStart]);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        <Icon icon="heroicons-outline:clock" className="text-sm" />
        Coverage
      </div>
      <div className="relative h-7 w-full overflow-hidden rounded-md border border-card-border bg-hover/40">
        {/* Hour gridlines */}
        {TICKS.slice(1, -1).map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 w-px bg-card-border/60"
            style={{ left: `${(h / 24) * 100}%` }}
          />
        ))}
        {/* Recording spans */}
        {spans.map((sp) => (
          <div
            key={sp.id}
            className={`absolute top-1 bottom-1 rounded-sm ${BAR_COLOR[sp.trigger] || "bg-muted"} opacity-90`}
            style={{ left: `${sp.leftPct}%`, width: `${sp.widthPct}%` }}
            title={TRIGGER_PRESETS[sp.trigger]?.label || sp.trigger}
          />
        ))}
        {spans.length === 0 && (
          <div className="flex h-full items-center justify-center text-[11px] text-muted">
            No coverage this day
          </div>
        )}
      </div>
      {/* Hour axis */}
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        {TICKS.map((h) => (
          <span key={h}>{String(h % 24).padStart(2, "0")}</span>
        ))}
      </div>
    </div>
  );
}
