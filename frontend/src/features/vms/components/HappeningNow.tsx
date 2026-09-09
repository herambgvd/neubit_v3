"use client";

// WHAT IS TRUE RIGHT NOW, above everything that merely happened.
//
// A stateful event with no `ended_at` has not finished: a camera that went
// unreachable at 22:38 is STILL unreachable, and the feed was showing that as an
// ordinary row in yesterday's group — a thirteen-hour outage rendered exactly
// like a motion blip, thirty rows down.
//
// So the open ones lead, with the time they have been running ticking beside
// them. Longest first, because the oldest unresolved thing is usually the worst
// one, not the newest.
//
// This is a SUMMARY, not a second feed: each entry is one line, it puts the
// event on the monitor canvas when clicked, and the same event stays in the feed
// below in the day it began. An operator who scrolls should find it where it
// happened, not only where it is pinned.
import { Icon } from "@iconify/react";

import { sevPreset, typePreset, eventTypeLabel, fmtTime, type NormalizedVmsEvent } from "../eventLib";
import { formatDuration, openFor } from "../eventState";
import { useTicker } from "../hooks/useTicker";

export interface HappeningNowProps {
  events: NormalizedVmsEvent[];
  selectedId?: string | null;
  onSelect?: (event: NormalizedVmsEvent) => void;
  /** Names a camera from the estate; the row falls back to the event's title. */
  cameraName?: (id: string | null | undefined) => string | null;
}

export default function HappeningNow({
  events,
  selectedId = null,
  onSelect,
  cameraName,
}: HappeningNowProps) {
  // A second is the right grain: these durations are read, not measured, and a
  // minute-long tick makes "just started" sit at 0 for a minute.
  const now = useTicker(1_000, events.length > 0);

  if (!events.length) return null;

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-orange-500/30 bg-orange-500/[0.06]">
      <header className="flex items-center gap-2 border-b border-orange-500/20 px-3 py-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-500 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
        </span>
        <span className="text-[12px] font-semibold text-foreground">Happening now</span>
        <span className="rounded-sm bg-orange-500/15 px-1.5 py-0.5 font-mono text-[10px] text-orange-300">
          {events.length}
        </span>
        <span className="ml-auto text-[10.5px] text-muted">
          still open — the recorder has not reported an end
        </span>
      </header>

      <div className="divide-y divide-orange-500/10">
        {events.map((e) => {
          const key = e.event_id || e.id || "";
          const sp = sevPreset(e.severity);
          const tp = typePreset(e.event_type);
          const elapsed = openFor(e, now);
          const selected = !!selectedId && selectedId === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect?.(e)}
              aria-pressed={selected}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition ${
                selected ? "bg-orange-500/10" : "hover:bg-orange-500/[0.08]"
              }`}
            >
              <Icon icon={tp.icon} className={`shrink-0 text-sm ${sp.text}`} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12.5px] font-medium text-foreground">
                    {cameraName?.(e.camera_id) || e.title || "camera"}
                  </span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>
                    {eventTypeLabel(e.event_type)}
                  </span>
                </span>
                <span className="block truncate font-mono text-[10.5px] text-muted">
                  since {fmtTime(e.occurred_at)}
                </span>
              </span>
              {/* The number that makes this band worth having: how long it has
                  been true, counting up while the operator looks at it. */}
              <span className="shrink-0 font-mono text-[13px] tabular-nums text-orange-300">
                {formatDuration(elapsed)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
