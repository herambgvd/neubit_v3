"use client";

// WallToolbar — the compact control-room top bar for the video wall. Left:
// rail toggle + wall identity (name, live-tile count, tour indicator). Right:
// layout picker, Tour (play/pause + interval), Saved, mute-all, fullscreen-wall,
// clear, refresh. Kept dense + icon-first so the wall keeps the viewport.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import Link from "next/link";

import LayoutPicker from "./LayoutPicker";
import HostLoadChip from "./HostLoadChip";
import { getLayout } from "../videoWall";

interface IconBtnProps {
  icon: string;
  title: string;
  onClick?: () => void;
  active?: boolean;
  spinning?: boolean;
  danger?: boolean;
}

/** A toolbar button's skin. Precedence, not exclusivity: a `danger` button that
 *  is currently ACTIVE reads as active — the state it is in outranks the harm it
 *  could do, because the operator can see it is engaged. */
function iconBtnSkin(active: boolean, danger: boolean): string {
  if (active) return "border-nb-teal/50 bg-nb-teal/15 text-nb-tealb";
  if (danger) {
    return "border-nb-mist/22 text-nb-soft hover:border-nb-crit/50 hover:bg-red-500/10 hover:text-nb-crit";
  }
  return "border-nb-mist/22 text-nb-soft hover:border-nb-teal/60 hover:text-nb-teal";
}

function IconBtn({ icon, title, onClick, active = false, spinning = false, danger = false }: Readonly<IconBtnProps>) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border transition ${iconBtnSkin(active, danger)}`}
    >
      <Icon icon={icon} className={`text-base ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}

// The three wall view modes (mockup: GRID / MAP / SPLIT). MAP overlays camera
// positions on a facility map; SPLIT shows grid + map side by side.
/** The wall's view mode — GRID / MAP / SPLIT (see VIEW_MODES). */
export type WallViewMode = "grid" | "map" | "split";

// Icons with a title, not words: this row sits above a live wall and every
// character in it is width a tile does not get. The title carries the wording
// for a hover and for a screen reader, and `aria-pressed` says which is on.
const VIEW_MODES: { key: WallViewMode; title: string; icon: string }[] = [
  { key: "grid", title: "Grid — camera tiles", icon: "heroicons-outline:squares-2x2" },
  { key: "map", title: "Map — cameras on the floor plan", icon: "heroicons-outline:map" },
  { key: "split", title: "Split — grid and map side by side", icon: "heroicons-outline:view-columns" },
];

// Global stream-quality profiles (mockup top-bar). Maps to the media profile the
// wall requests: eco/balanced favour the low-bandwidth sub-stream, high/turbo the
// full main-stream. "auto" defers to the per-tile grid heuristic (tileProfile).
export interface QualityLevel {
  key: string;
  label: string;
  icon: string;
  /** The media profile this level requests; null = per-tile heuristic. */
  profile: "main" | "sub" | null;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { key: "auto", label: "Auto", icon: "heroicons-outline:sparkles", profile: null },
  { key: "eco", label: "Eco", icon: "mdi:leaf", profile: "sub" },
  { key: "balanced", label: "Balanced", icon: "heroicons-outline:signal", profile: "sub" },
  { key: "high", label: "High", icon: "heroicons-outline:film", profile: "main" },
  { key: "turbo", label: "Turbo", icon: "heroicons-outline:bolt", profile: "main" },
];

/** The wall tour: pages of camera ids cycled through the layout on an interval. */
export interface WallTourState {
  active: boolean;
  pages: string[][];
  index: number;
  seconds: number;
}

/** The toolbar of a live view on another monitor (SCRUM-336): it names its
 *  screen and can close it, where the main wall has its way Home. */
export interface WallToolbarScreen {
  label: string;
  onClose: () => void;
}

export interface WallToolbarProps {
  railOpen: boolean;
  onToggleRail: () => void;
  layoutKey: string;
  onLayoutChange: (key: string) => void;
  liveCount: number;
  onlineCount: number;
  viewMode?: WallViewMode;
  onViewMode?: (mode: WallViewMode) => void;
  quality?: string;
  onQuality?: (key: string) => void;
  playoutOpen?: boolean;
  onTogglePlayout?: () => void;
  alarmCount?: number;
  tour?: WallTourState | null;
  onStartTour?: () => void;
  onStopTour?: () => void;
  onTourInterval?: (seconds: number) => void;
  /** <PatternPickerMenu/> element (server-persisted rotations). */
  patternControl?: ReactNode;
  /** <SavedLayoutsMenu/> element (localStorage static layouts). */
  savedControl?: ReactNode;
  /** Capture the current wall as a server GROUP (inline). */
  onSaveGroup?: () => void;
  /** Gate: at least one camera on the wall. */
  canSaveGroup?: boolean;
  allMuted?: boolean;
  onToggleMuteAll?: () => void;
  onFullscreen?: () => void;
  /** The document is full screen — the button then leaves it. */
  fullscreen?: boolean;
  /** <LiveScreensMenu/> — the other monitors of this station. */
  screensControl?: ReactNode;
  /** Set on a live screen's own window. */
  screen?: WallToolbarScreen | null;
  onClear?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

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
  onSaveGroup, // capture the current wall as a server GROUP (inline)
  canSaveGroup, // gate: at least one camera on the wall
  allMuted,
  onToggleMuteAll,
  onFullscreen,
  fullscreen = false,
  screensControl,
  screen = null,
  onClear,
  onRefresh,
  refreshing,
}: Readonly<WallToolbarProps>) {
  const layout = getLayout(layoutKey);
  const gridMode = viewMode !== "map"; // grid or split show the layout picker

  return (
    <div className="relative z-30 flex flex-wrap items-center justify-between gap-2 border-b border-nb-mist/22 bg-nb-surface2/70 px-3 py-2 backdrop-blur-xs">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2">
        {screen ? (
          <ScreenIdentity screen={screen} />
        ) : (
          // Home — back to the metro launcher (the wall has no global header).
          <Link
            href="/home"
            title="Home"
            className="inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border border-nb-mist/22 text-nb-soft transition hover:border-nb-teal/60 hover:text-nb-teal"
          >
            <Icon icon="heroicons-outline:home" className="text-base" />
          </Link>
        )}
        {/* Live mode tab (active) — matches the mockup's mode indicator. */}
        <span className="inline-flex h-[33px] items-center gap-1.5 rounded-[8px] border border-nb-teal/45 bg-nb-teal/14 px-2.5 text-[12px] font-semibold tracking-[.8px] text-nb-tealb">
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
            className="rounded-[6px] border border-nb-mist/22 bg-nb-mist/4 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-nb-soft"
          >
            {liveCount}/{layout.capacity}
          </span>
          {tour?.active && (
            <span className="inline-flex items-center gap-1 rounded-full border border-nb-warn/40 bg-nb-warn/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-nb-warn">
              <Icon icon="svg-spinners:180-ring" className="text-xs" />
              Tour {tour.index + 1}/{tour.pages.length}
            </span>
          )}
        </div>

        {/* GRID / MAP / SPLIT view segment (mockup) */}
        <div className="ml-1 hidden overflow-hidden rounded-[9px] border border-nb-mist/22 md:inline-flex">
          {VIEW_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              title={m.title}
              aria-label={m.title}
              aria-pressed={viewMode === m.key}
              onClick={() => onViewMode?.(m.key)}
              className={`inline-flex h-[29px] w-[31px] items-center justify-center transition ${
                viewMode === m.key
                  ? "bg-nb-teal/15 text-nb-tealb"
                  : "text-nb-soft hover:bg-nb-mist/6 hover:text-nb-tealb"
              }`}
            >
              <Icon icon={m.icon} className="text-sm" />
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        {/* Host load FIRST in the control row: it is a reading, not a control,
            and it belongs beside the thing an operator changes because of it —
            the stream quality. */}
        <HostLoadChip />

        <QualitySelect quality={quality} onQuality={onQuality} />

        <div className="mx-0.5 h-6 w-px bg-nb-mist/22" />

        {gridMode && <LayoutPicker layoutKey={layoutKey} onChange={onLayoutChange} />}

        {gridMode && <TourControl tour={tour} onStart={onStartTour} onStop={onStopTour} onInterval={onTourInterval} />}

        {patternControl}
        {savedControl}
        {onSaveGroup && gridMode && (
          <button
            type="button"
            title="Save the current wall as a reusable group"
            aria-label="Save the current wall as a reusable group"
            disabled={!canSaveGroup}
            onClick={onSaveGroup}
            className="inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border border-nb-mist/22 bg-nb-mist/4 text-nb-soft transition hover:border-nb-teal/50 hover:text-nb-tealb disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon="heroicons-outline:folder-plus" className="text-base" />
          </button>
        )}

        <div className="mx-0.5 h-6 w-px bg-nb-mist/22" />

        {gridMode && (
          <IconBtn
            icon={allMuted ? "heroicons-outline:speaker-x-mark" : "heroicons-outline:speaker-wave"}
            title={allMuted ? "Unmute wall" : "Mute wall"}
            active={!allMuted}
            onClick={onToggleMuteAll}
          />
        )}
        {/* A live screen does not open more screens. */}
        {!screen && screensControl}
        <IconBtn
          icon={fullscreen ? "heroicons-outline:arrows-pointing-in" : "heroicons-outline:arrows-pointing-out"}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen — video only, controls on mouse move"}
          active={fullscreen}
          onClick={onFullscreen}
        />
        {gridMode && liveCount > 0 && (
          <IconBtn icon="heroicons-outline:trash" title="Clear wall" danger onClick={onClear} />
        )}
        <IconBtn icon="heroicons-outline:arrow-path" title="Refresh cameras" spinning={refreshing} onClick={onRefresh} />

        {/* PLAYBACK — the wall's DVR. It opens the transport dock, and from there
            a click on the timeline puts the recording in the tiles themselves.
            An icon like every other control in this row: it is a toggle, and the
            lit state says it is open more directly than a word beside it did.
            The title carries the wording for a hover and for a screen reader. */}
        <IconBtn
          icon="heroicons:play-circle"
          title={playoutOpen ? "Close playback" : "Playback — scrub recordings on the wall"}
          active={playoutOpen}
          onClick={onTogglePlayout}
        />

        {/* Alarm count chip (real count; hidden at zero) */}
        {alarmCount > 0 && (
          <span
            title={`${alarmCount} active alarm${alarmCount === 1 ? "" : "s"}`}
            className="inline-flex h-[33px] items-center gap-1.5 rounded-[8px] border border-nb-crit/50 bg-nb-crit/12 px-2.5 font-mono text-[11px] font-semibold text-nb-crit"
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

// Which monitor this is, and the way to close it — in place of Home on a live
// screen's window, which has no console behind it to go home to.
function ScreenIdentity({ screen }: Readonly<{ screen: WallToolbarScreen }>) {
  return (
    <>
      <button
        type="button"
        title="Close this screen"
        aria-label="Close this screen"
        onClick={screen.onClose}
        className="inline-flex h-[33px] w-[33px] items-center justify-center rounded-[8px] border border-nb-mist/22 text-nb-soft transition hover:border-nb-crit/50 hover:bg-red-500/10 hover:text-nb-crit"
      >
        <Icon icon="heroicons-outline:x-mark" className="text-base" />
      </button>
      <span
        title="This monitor's own live view"
        className="inline-flex h-[33px] min-w-0 max-w-[14rem] items-center gap-1.5 rounded-[8px] border border-nb-mist/22 bg-nb-mist/4 px-2.5 text-[12px] font-medium text-nb-soft"
      >
        <Icon icon="heroicons-outline:computer-desktop" className="shrink-0 text-sm text-nb-faint" />
        <span className="truncate">{screen.label}</span>
      </span>
    </>
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
    <span className="hidden items-center font-mono text-[12.5px] tabular-nums text-nb-soft sm:inline-flex" title="Wall clock">
      {t}
    </span>
  );
}

// Quality selector — global stream-profile switch (Auto/Eco/Balanced/High/Turbo).
function QualitySelect({ quality, onQuality }: Readonly<{ quality: string; onQuality?: (key: string) => void }>) {
  return (
    <div className="hidden overflow-hidden rounded-[9px] border border-nb-mist/22 lg:inline-flex" title="Stream quality">
      {QUALITY_LEVELS.map((lvl) => (
        <button
          key={lvl.key}
          type="button"
          onClick={() => onQuality?.(lvl.key)}
          title={lvl.label}
          className={`inline-flex h-[27px] w-[29px] items-center justify-center transition ${
            quality === lvl.key
              ? "bg-nb-teal/15 text-nb-tealb"
              : "text-nb-soft hover:bg-nb-mist/6 hover:text-nb-tealb"
          }`}
        >
          <Icon icon={lvl.icon} className="text-sm" />
        </button>
      ))}
    </div>
  );
}

// Tour: split button — play/stop + a popover for the dwell interval.
interface TourControlProps {
  tour?: WallTourState | null;
  onStart?: () => void;
  onStop?: () => void;
  onInterval?: (seconds: number) => void;
}

function TourControl({ tour, onStart, onStop, onInterval }: Readonly<TourControlProps>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node | null) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = tour?.active;
  const seconds = tour?.seconds ?? 10;

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        title={active ? "Stop the tour" : "Start a tour — cycle the wall through pages of cameras"}
        aria-label={active ? "Stop the tour" : "Start a tour"}
        onClick={active ? onStop : onStart}
        className={`inline-flex h-8 w-[31px] items-center justify-center rounded-l-[8px] border transition ${
          active
            ? "border-nb-warn/50 bg-nb-warn/12 text-nb-warn"
            : "border-nb-mist/22 text-nb-soft hover:border-nb-teal/50 hover:text-nb-tealb"
        }`}
      >
        <Icon icon={active ? "heroicons-solid:stop" : "heroicons-solid:play"} className="text-sm" />
      </button>
      <button
        type="button"
        title="Tour interval"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 items-center rounded-r-[8px] border-y border-r px-1.5 text-xs transition ${
          active
            ? "border-nb-warn/50 bg-nb-warn/12 text-nb-warn"
            : "border-nb-mist/22 text-nb-soft hover:border-nb-teal/50 hover:text-nb-tealb"
        }`}
      >
        <span className="font-mono tabular-nums">{seconds}s</span>
        <Icon icon="heroicons-mini:chevron-down" className="ml-0.5 text-sm" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-40 rounded-[13px] border border-nb-haze/22 bg-nb-surface2/93 p-2 shadow-2xl backdrop-blur-xs">
          <p className="px-1 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">
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
                    ? "border-nb-teal/50 bg-nb-teal/15 text-nb-tealb"
                    : "border-nb-mist/22 text-nb-soft hover:border-nb-teal/50 hover:text-nb-tealb"
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
