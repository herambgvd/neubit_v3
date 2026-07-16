"use client";

// WallToolbar — the compact control-room top bar for the video wall. Left:
// rail toggle + wall identity (name, live-tile count, tour indicator). Right:
// layout picker, Tour (play/pause + interval), Saved, mute-all, fullscreen-wall,
// clear, refresh. Kept dense + icon-first so the wall keeps the viewport.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import LayoutPicker from "./LayoutPicker";
import { getLayout } from "../videoWall";

function IconBtn({ icon, title, onClick, active = false, spinning = false, danger = false }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${
        active
          ? "border-blue-500 bg-blue-500/10 text-blue-500"
          : danger
            ? "border-card-border text-muted hover:bg-red-500/10 hover:text-red-500"
            : "border-card-border text-muted hover:bg-hover hover:text-foreground"
      }`}
    >
      <Icon icon={icon} className={`text-base ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}

export default function WallToolbar({
  railOpen,
  onToggleRail,
  layoutKey,
  onLayoutChange,
  liveCount,
  onlineCount,
  tour,
  onStartTour,
  onStopTour,
  onTourInterval,
  patternControl, // <PatternPickerMenu/> element (server-persisted rotations)
  savedControl, // <SavedLayoutsMenu/> element (localStorage static layouts)
  onSaveGroup, // capture the current wall as a server Camera Group (inline)
  canSaveGroup, // gate: at least one camera on the wall
  allMuted,
  onToggleMuteAll,
  onFullscreen,
  onClear,
  onRefresh,
  refreshing,
}) {
  const layout = getLayout(layoutKey);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border bg-card px-3 py-2">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2">
        <IconBtn
          icon={railOpen ? "heroicons-outline:chevron-double-left" : "heroicons-outline:chevron-double-right"}
          title={railOpen ? "Collapse camera rail" : "Expand camera rail"}
          onClick={onToggleRail}
        />
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon="heroicons-solid:signal" className="text-base text-blue-500" />
          <span className="text-sm font-semibold text-foreground">Video Wall</span>
          <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted">
            {liveCount}/{layout.capacity}
          </span>
          <span className="hidden items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-emerald-500 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {onlineCount} online
          </span>
          <span className="hidden items-center gap-1 text-[10px] font-medium tabular-nums text-muted sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            {liveCount} on wall
          </span>
          {tour?.active && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-500">
              <Icon icon="svg-spinners:180-ring" className="text-xs" />
              Tour {tour.index + 1}/{tour.pages.length}
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        <LayoutPicker layoutKey={layoutKey} onChange={onLayoutChange} />

        <TourControl tour={tour} onStart={onStartTour} onStop={onStopTour} onInterval={onTourInterval} />

        {patternControl}
        {savedControl}
        {onSaveGroup && (
          <button
            type="button"
            title="Save the current wall as a reusable camera group"
            disabled={!canSaveGroup}
            onClick={onSaveGroup}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-card-border bg-card px-2.5 text-xs font-medium text-foreground transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon="heroicons-outline:folder-plus" className="text-sm text-muted" />
            Save group
          </button>
        )}

        <div className="mx-0.5 h-6 w-px bg-card-border" />

        <IconBtn
          icon={allMuted ? "heroicons-outline:speaker-x-mark" : "heroicons-outline:speaker-wave"}
          title={allMuted ? "Unmute wall" : "Mute wall"}
          active={!allMuted}
          onClick={onToggleMuteAll}
        />
        <IconBtn icon="heroicons-outline:arrows-pointing-out" title="Fullscreen wall" onClick={onFullscreen} />
        {liveCount > 0 && (
          <IconBtn icon="heroicons-outline:trash" title="Clear wall" danger onClick={onClear} />
        )}
        <IconBtn icon="heroicons-outline:arrow-path" title="Refresh cameras" spinning={refreshing} onClick={onRefresh} />
      </div>
    </div>
  );
}

// Tour: split button — play/stop + a popover for the dwell interval.
function TourControl({ tour, onStart, onStop, onInterval }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = tour?.active;
  const seconds = tour?.seconds ?? 10;

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={active ? onStop : onStart}
        className={`inline-flex h-8 items-center gap-1.5 rounded-l-lg border px-2.5 text-xs font-medium transition ${
          active
            ? "border-amber-500 bg-amber-500/10 text-amber-500"
            : "border-card-border text-muted hover:bg-hover hover:text-foreground"
        }`}
      >
        <Icon icon={active ? "heroicons-solid:stop" : "heroicons-solid:play"} className="text-sm" />
        {active ? "Stop" : "Tour"}
      </button>
      <button
        type="button"
        title="Tour interval"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 items-center rounded-r-lg border-y border-r px-1.5 text-xs transition ${
          active
            ? "border-amber-500 bg-amber-500/10 text-amber-500"
            : "border-card-border text-muted hover:bg-hover hover:text-foreground"
        }`}
      >
        <span className="tabular-nums">{seconds}s</span>
        <Icon icon="heroicons-mini:chevron-down" className="ml-0.5 text-sm" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-40 rounded-lg border border-card-border bg-card p-2 shadow-2xl">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Dwell per page
          </p>
          <div className="grid grid-cols-4 gap-1">
            {[5, 10, 15, 30].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  onInterval?.(s);
                  setOpen(false);
                }}
                className={`rounded-md border px-1 py-1.5 text-[11px] font-medium tabular-nums transition ${
                  seconds === s
                    ? "border-blue-500 bg-blue-500/10 text-blue-500"
                    : "border-card-border text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {s}s
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
