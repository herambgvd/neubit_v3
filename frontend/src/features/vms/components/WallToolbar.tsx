"use client";

// WallToolbar — the compact control-room top bar for the video wall. Left:
// rail toggle + wall identity (name, live-tile count, tour indicator). Right:
// layout picker, Tour (play/pause + interval), Saved, mute-all, fullscreen-wall,
// clear, refresh. Kept dense + icon-first so the wall keeps the viewport.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import Link from "next/link";

import LayoutPicker from "./LayoutPicker";
import { getLayout } from "../videoWall";

function IconBtn({ icon, title, onClick, active = false, spinning = false, danger = false }: any) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border transition ${
        active
          ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
          : danger
            ? "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(248,113,113,.5)] hover:bg-red-500/10 hover:text-[#f87171]"
            : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee]"
      }`}
    >
      <Icon icon={icon} className={`text-base ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}

// The three wall view modes (mockup: GRID / MAP / SPLIT). MAP overlays camera
// positions on a facility map; SPLIT shows grid + map side by side.
const VIEW_MODES = [
  { key: "grid", label: "GRID", icon: "heroicons-outline:squares-2x2" },
  { key: "map", label: "MAP", icon: "heroicons-outline:map" },
  { key: "split", label: "SPLIT", icon: "heroicons-outline:view-columns" },
];

// Global stream-quality profiles (mockup top-bar). Maps to the media profile the
// wall requests: eco/balanced favour the low-bandwidth sub-stream, high/turbo the
// full main-stream. "auto" defers to the per-tile grid heuristic (tileProfile).
export const QUALITY_LEVELS = [
  { key: "auto", label: "Auto", icon: "heroicons-outline:sparkles", profile: null },
  { key: "eco", label: "Eco", icon: "mdi:leaf", profile: "sub" },
  { key: "balanced", label: "Balanced", icon: "heroicons-outline:signal", profile: "sub" },
  { key: "high", label: "High", icon: "heroicons-outline:film", profile: "main" },
  { key: "turbo", label: "Turbo", icon: "heroicons-outline:bolt", profile: "main" },
];

export default function WallToolbar({
  railOpen,
  onToggleRail,
  layoutKey,
  onLayoutChange,
  liveCount,
  onlineCount,
  viewMode = "grid",
  onViewMode,
  quality = "auto",
  onQuality,
  playoutOpen,
  onTogglePlayout,
  alarmCount = 0,
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
}: any) {
  const layout = getLayout(layoutKey);
  const gridMode = viewMode !== "map"; // grid or split show the layout picker

  return (
    <div className="relative z-30 flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.7)] px-3 py-2 backdrop-blur-xs">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2">
        {/* Home — back to the metro launcher (the wall has no global header). */}
        <Link
          href="/home"
          title="Home"
          className="inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee]"
        >
          <Icon icon="heroicons-outline:home" className="text-base" />
        </Link>
        {/* Live mode tab (active) — matches the mockup's mode indicator. */}
        <span className="inline-flex h-[33px] items-center gap-1.5 rounded-[8px] border border-[rgba(34,211,238,.45)] bg-[rgba(34,211,238,.14)] px-2.5 text-[12px] font-semibold tracking-[.8px] text-[#67e8f9]">
          <Icon icon="heroicons-solid:signal" className="text-sm" />
          LIVE
        </span>
        <IconBtn
          icon={railOpen ? "heroicons-outline:chevron-double-left" : "heroicons-outline:chevron-double-right"}
          title={railOpen ? "Collapse camera rail" : "Expand camera rail"}
          onClick={onToggleRail}
        />
        <div className="flex min-w-0 items-center gap-2">
          <span
            title={`${liveCount} on wall · ${onlineCount} online`}
            className="rounded-[6px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-[#aec2e8]"
          >
            {liveCount}/{layout.capacity}
          </span>
          {tour?.active && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.12)] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#fbbf24]">
              <Icon icon="svg-spinners:180-ring" className="text-xs" />
              Tour {tour.index + 1}/{tour.pages.length}
            </span>
          )}
        </div>

        {/* GRID / MAP / SPLIT view segment (mockup) */}
        <div className="ml-1 hidden overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.22)] md:inline-flex">
          {VIEW_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onViewMode?.(m.key)}
              className={`inline-flex h-[29px] items-center gap-1.5 px-2.5 text-[11.5px] font-medium tracking-[1.1px] transition ${
                viewMode === m.key
                  ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                  : "text-[#aec2e8] hover:bg-[rgba(150,180,245,.06)] hover:text-[#67e8f9]"
              }`}
            >
              <Icon icon={m.icon} className="text-sm" />
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        <QualitySelect quality={quality} onQuality={onQuality} />

        <div className="mx-0.5 h-6 w-px bg-[rgba(150,180,245,.22)]" />

        {gridMode && <LayoutPicker layoutKey={layoutKey} onChange={onLayoutChange} />}

        {gridMode && <TourControl tour={tour} onStart={onStartTour} onStop={onStopTour} onInterval={onTourInterval} />}

        {patternControl}
        {savedControl}
        {onSaveGroup && gridMode && (
          <button
            type="button"
            title="Save the current wall as a reusable camera group"
            disabled={!canSaveGroup}
            onClick={onSaveGroup}
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] px-2.5 text-xs font-medium text-[#f2f6ff] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon="heroicons-outline:folder-plus" className="text-sm text-[#7e93bf]" />
            Save group
          </button>
        )}

        <div className="mx-0.5 h-6 w-px bg-[rgba(150,180,245,.22)]" />

        {gridMode && (
          <IconBtn
            icon={allMuted ? "heroicons-outline:speaker-x-mark" : "heroicons-outline:speaker-wave"}
            title={allMuted ? "Unmute wall" : "Mute wall"}
            active={!allMuted}
            onClick={onToggleMuteAll}
          />
        )}
        <IconBtn icon="heroicons-outline:arrows-pointing-out" title="Fullscreen wall" onClick={onFullscreen} />
        {gridMode && liveCount > 0 && (
          <IconBtn icon="heroicons-outline:trash" title="Clear wall" danger onClick={onClear} />
        )}
        <IconBtn icon="heroicons-outline:arrow-path" title="Refresh cameras" spinning={refreshing} onClick={onRefresh} />

        {/* PLAYBACK — the wall's DVR. It opens the transport dock, and from there
            a click on the timeline puts the recording in the tiles themselves.
            Named and iconed for what the operator is after (playback) rather than
            for the mechanism (a playout transport), which is why the old label
            read as a developer's word for a viewer's feature. */}
        <button
          type="button"
          title={playoutOpen ? "Close playback" : "Playback — scrub recordings on the wall"}
          onClick={onTogglePlayout}
          className={`inline-flex h-[33px] items-center gap-1.5 rounded-[8px] border px-2.5 text-xs font-medium transition ${
            playoutOpen
              ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
              : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee]"
          }`}
        >
          <Icon icon="heroicons-outline:play-circle" className="text-base" />
          Playback
        </button>

        {/* Alarm count chip (real count; hidden at zero) */}
        {alarmCount > 0 && (
          <span
            title={`${alarmCount} active alarm${alarmCount === 1 ? "" : "s"}`}
            className="inline-flex h-[33px] items-center gap-1.5 rounded-[8px] border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.12)] px-2.5 font-mono text-[11px] font-semibold text-[#f87171]"
          >
            <Icon icon="heroicons-outline:bell-alert" className="text-sm" />
            {alarmCount}
          </span>
        )}

        <Clock />
      </div>
    </div>
  );
}

// Live wall clock (HH:MM:SS, mono) — matches the mockup top-bar clock.
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const t = now.toLocaleTimeString("en-GB", { hour12: false });
  return (
    <span className="hidden items-center font-mono text-[12.5px] tabular-nums text-[#aec2e8] sm:inline-flex" title="Wall clock">
      {t}
    </span>
  );
}

// Quality selector — global stream-profile switch (Auto/Eco/Balanced/High/Turbo).
function QualitySelect({ quality, onQuality }: any) {
  return (
    <div className="hidden overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.22)] lg:inline-flex" title="Stream quality">
      {QUALITY_LEVELS.map((lvl) => (
        <button
          key={lvl.key}
          type="button"
          onClick={() => onQuality?.(lvl.key)}
          title={lvl.label}
          className={`inline-flex h-[27px] w-[29px] items-center justify-center transition ${
            quality === lvl.key
              ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
              : "text-[#aec2e8] hover:bg-[rgba(150,180,245,.06)] hover:text-[#67e8f9]"
          }`}
        >
          <Icon icon={lvl.icon} className="text-sm" />
        </button>
      ))}
    </div>
  );
}

// Tour: split button — play/stop + a popover for the dwell interval.
function TourControl({ tour, onStart, onStop, onInterval }: any) {
  const [open, setOpen] = useState(false);
  const ref = useRef<any>(null);

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
        className={`inline-flex h-8 items-center gap-1.5 rounded-l-[8px] border px-2.5 text-xs font-medium transition ${
          active
            ? "border-[rgba(251,191,36,.5)] bg-[rgba(251,191,36,.12)] text-[#fbbf24]"
            : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
        }`}
      >
        <Icon icon={active ? "heroicons-solid:stop" : "heroicons-solid:play"} className="text-sm" />
        {active ? "Stop" : "Tour"}
      </button>
      <button
        type="button"
        title="Tour interval"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 items-center rounded-r-[8px] border-y border-r px-1.5 text-xs transition ${
          active
            ? "border-[rgba(251,191,36,.5)] bg-[rgba(251,191,36,.12)] text-[#fbbf24]"
            : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
        }`}
      >
        <span className="font-mono tabular-nums">{seconds}s</span>
        <Icon icon="heroicons-mini:chevron-down" className="ml-0.5 text-sm" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-40 rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.93)] p-2 shadow-2xl backdrop-blur-xs">
          <p className="px-1 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">
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
                className={`rounded-md border px-1 py-1.5 font-mono text-[11px] font-medium tabular-nums transition ${
                  seconds === s
                    ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                    : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
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
