"use client";

// PlaybackRail — the left rail of the Playback workspace: the recorder › camera
// tree, the calendar marked from the recorder's own index, the recorded stream, and
// the keys. A click on a camera adds it to the grid at once; there is no separate
// Search step, as in every VMS client.
import { Icon } from "@iconify/react";

import PlaybackCalendar from "../components/PlaybackCalendar";
import PlaybackChannelPicker, { type PickerGroup } from "../components/PlaybackChannelPicker";
import type { PlaybackStream } from "../types";
import { MAX_TILES } from "./playbackModel";

export const STREAMS: { value: PlaybackStream; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "The recorder plays the main stream when this browser can decode it" },
  { value: "main", label: "Main", hint: "Full resolution" },
  { value: "sub", label: "Sub", hint: "Lighter on the link: for a full grid over a slow line" },
];

export interface PlaybackRailProps {
  groups: PickerGroup[];
  checkedKeys: Set<string>;
  onToggle: (key: string) => void;
  loading: boolean;
  error: string | null;
  capNote: boolean;
  calView: { year: number; month: number };
  selectedDay: string;
  footageDays: Set<number>;
  eventDays: Set<number>;
  onSelectDay: (day: string) => void;
  onPage: (dir: -1 | 1) => void;
  /** The camera the calendar is marked for. */
  markedFor: { name: string; recorder: string } | null;
  daysFailed: boolean;
  stream: PlaybackStream;
  onStream: (s: PlaybackStream) => void;
}

export default function PlaybackRail(p: Readonly<PlaybackRailProps>) {
  const count = p.checkedKeys.size;
  return (
    <aside className="flex w-72 shrink-0 flex-col rounded-xl border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.55)]">
      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[#9db0d8]">Cameras</p>
          <span className={`text-[11px] tabular-nums ${count >= MAX_TILES ? "text-amber-300" : "text-[#9db0d8]"}`}>
            {count}/{MAX_TILES}
          </span>
        </div>
        <PlaybackChannelPicker
          groups={p.groups}
          checkedKeys={p.checkedKeys}
          onToggle={p.onToggle}
          max={MAX_TILES}
          loading={p.loading}
          error={p.error}
        />
        {p.capNote && (
          <p className="mt-1 text-[10.5px] text-amber-300">Sixteen cameras is the most one playback can sync.</p>
        )}

        <div className="mt-4">
          <PlaybackCalendar
            viewYear={p.calView.year}
            viewMonth={p.calView.month}
            selected={p.selectedDay}
            footageDays={p.footageDays}
            eventDays={p.eventDays}
            onSelectDay={p.onSelectDay}
            onPrevMonth={() => p.onPage(-1)}
            onNextMonth={() => p.onPage(1)}
          />
          <p className="mt-1 px-1 text-[10.5px] text-[#9db0d8]">
            {p.markedFor
              ? `Marked for ${p.markedFor.name}: bar = footage, dot = events.`
              : "Add a camera to see which days hold footage."}
          </p>
          {p.daysFailed && p.markedFor && (
            <p className="mt-1 px-1 text-[10.5px] leading-relaxed text-amber-200">
              {p.markedFor.recorder} did not answer for footage days: the calendar is unmarked, not empty.
            </p>
          )}
        </div>

        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[#9db0d8]">Stream</p>
          <div className="flex gap-1">
            {STREAMS.map((s) => (
              <button
                key={s.value}
                type="button"
                title={s.hint}
                aria-pressed={p.stream === s.value}
                onClick={() => p.onStream(s.value)}
                className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] transition ${
                  p.stream === s.value
                    ? "bg-foreground font-medium text-background"
                    : "text-[#9db0d8] hover:bg-[rgba(150,180,245,.07)] hover:text-[#67e8f9]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-[rgba(160,150,245,.18)] p-2 text-[10.5px] leading-relaxed text-[#9db0d8]">
          <p className="mb-1 font-semibold uppercase tracking-wide">
            <Icon icon="heroicons-outline:command-line" className="mr-1 inline text-[12px]" />
            Keys
          </p>
          Space play · ←/→ 5 s · Shift 1 min · , . frame · Alt+←/→ event · PgUp/PgDn speed · [ ] in/out · +/− zoom ·
          End live
        </div>
      </div>
    </aside>
  );
}
