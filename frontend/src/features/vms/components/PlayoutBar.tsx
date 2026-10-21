"use client";

// PlayoutBar — the wall's DVR dock (SCRUM-337): a timeline of every camera on the
// wall and the transport that drives the wall's playback.
//
// It does not PLAY anything. Playback happens in the tiles themselves (see
// TilePlayback) — this dock only says which instant the wall is at. That is the
// recorder console's shape too (neubit_nvr `app/(console)/live/page.tsx`): an
// operator scrubbing an incident wants the wall they already built, with its
// neighbouring cameras in place, not one camera in a dialog on top of it.
//
// The timeline and the transport are the Playback workspace's own
// (playback/PlaybackTimeline, PlaybackTransport), as Milestone's live view and its
// playback tab share one timeline: a lane per camera on the wall under an "All
// cameras" lane, with recordings coloured by trigger, events and bookmarks
// marked; wheel to zoom, drag to pan, click to seek, Shift+drag for an IN/OUT
// range; frame step, stepped reverse, the speed ladder, ±10 s, previous/next
// recording and event, and the same keys. What is the wall's own is above them:
// whether the wall is live or playing back, and SYNC — off, only the focused tile
// plays back while the rest stays live (HikCentral's instant playback); on, the
// whole wall shows one instant.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import PlaybackTimeline, { type TimelineLane } from "../playback/PlaybackTimeline";
import PlaybackTransport from "../playback/PlaybackTransport";
import {
  TRIGGER_KEYS,
  keyAction,
  localDay,
  nextEvent,
  nextRecording,
  prevEvent,
  prevRecording,
  snapToFootage,
  stepZoom,
  unionSpans,
  type KeyAction,
  type Span,
  type TriggerKey,
} from "../playback/playbackModel";
import { useGridData, useInvestigation } from "../playback/usePlaybackData";
import type { PlaybackCam } from "../playback/usePlaybackWorkspace";
import { createClock, type WallPlayback } from "../hooks/useWallPlayback";
import type { ExportRequest } from "./playbackTypes";
import type { EstateCamera } from "../types";

export type { WallPlayback };

/** Past this many cameras the wall's lanes would push the video off the screen:
 *  the dock then draws the focused camera's lane under an "All cameras" lane that
 *  still covers the whole wall. The Playback workspace stops at the same sixteen. */
export const MAX_LANES = 16;

const ALL_TRIGGERS: ReadonlySet<TriggerKey> = new Set(TRIGGER_KEYS);

/** A wall camera as the recorder addresses it — or null for one no recorder owns,
 *  which has no recorded footage to show here. */
export function playbackCamOf(c: EstateCamera): PlaybackCam | null {
  if (!c.federated || !c.node_id || !c.real_id) return null;
  return { key: c.id, nodeId: c.node_id, realId: c.real_id, name: c.name, recorder: c.node_name ?? "" };
}

/** The lanes the dock draws: every recorder camera on the wall, in tile order —
 *  or, past MAX_LANES, the focused one alone. */
export function wallLanes(
  cams: readonly PlaybackCam[],
  focusKey: string | null,
  data: { spans: Map<string, Span[]>; events: Map<string, number[]>; bookmarks: { camKey: string; at: number }[]; failed: Set<string> },
): TimelineLane[] {
  const shown = cams.length > MAX_LANES ? cams.filter((c) => c.key === focusKey) : cams;
  return shown.map((c) => ({
    key: c.key,
    name: c.name,
    spans: data.spans.get(c.key) ?? [],
    events: data.events.get(c.key) ?? [],
    bookmarks: data.bookmarks.filter((b) => b.camKey === c.key).map((b) => b.at),
    hits: [],
    active: c.key === focusKey,
    independent: false,
    failed: data.failed.has(c.key),
  }));
}

/** What the transport is driving, in the words its readout uses. */
export function targetText(pb: Pick<WallPlayback, "isPlayback" | "sync">, focusName: string | null): string {
  if (!pb.isPlayback) return "live";
  if (pb.sync) return "whole wall";
  return focusName ?? "focused tile";
}

/** Keys that need nothing on screen to mean something, taken from the shared map.
 *  Escape only clears a range when there is one: otherwise it is the wall's (leave
 *  a spotlight, leave full screen). */
function wantsKey(e: KeyboardEvent, hasSel: boolean): KeyAction | null {
  // The window or the document itself when nothing on the page has focus.
  const el = e.target instanceof HTMLElement ? e.target : null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return null;
  if (el?.closest('[role="dialog"]')) return null;
  if (e.ctrlKey || e.metaKey) return null;
  const action = keyAction(e.key, { alt: e.altKey, shift: e.shiftKey });
  if (action === "clearRange" && !hasSel) return null;
  return action;
}

export interface PlayoutBarProps {
  /** The cameras on the wall, in tile order. */
  cameras: readonly EstateCamera[];
  /** The focused tile's camera id — whose lane is active, and what plays alone. */
  focusCameraId: string | null;
  /** A lane was picked: focus that camera's tile. */
  onFocusCamera: (cameraId: string) => void;
  pb: WallPlayback;
  /** Export the IN/OUT range of the focused camera. */
  onExport: (req: ExportRequest) => void;
  onClose?: () => void;
}

export default function PlayoutBar({ cameras, focusCameraId, onFocusCamera, pb, onExport, onClose }: Readonly<PlayoutBarProps>) {
  const cams = useMemo(
    () => cameras.map(playbackCamOf).filter((c): c is PlaybackCam => c !== null),
    [cameras],
  );
  const focusCam = cams.find((c) => c.key === focusCameraId) ?? null;

  const { spansByKey, eventsByKey, bookmarks, coverageFailed } = useGridData(cams, pb.win);
  const inv = useInvestigation({ cams, activeCam: focusCam, clock: pb.clock, sel: pb.sel, hasSel: pb.hasSel, win: pb.win });

  // What the transport's jumps run over: the whole wall with Sync, else the
  // focused tile — the cameras actually playing back.
  const driven = useMemo(() => {
    if (pb.sync) return cams;
    return focusCam ? [focusCam] : [];
  }, [pb.sync, cams, focusCam]);
  const drivenSpans = useMemo(() => unionSpans(driven.map((c) => spansByKey.get(c.key) ?? [])), [driven, spansByKey]);
  const drivenEvents = useMemo(() => driven.flatMap((c) => eventsByKey.get(c.key) ?? []), [driven, eventsByKey]);

  const lanes = wallLanes(cams, focusCameraId, {
    spans: spansByKey,
    events: eventsByKey,
    bookmarks,
    failed: coverageFailed,
  });
  const master = useMemo(
    () =>
      cams.length > MAX_LANES
        ? {
            spans: cams.flatMap((c) => spansByKey.get(c.key) ?? []),
            events: cams.flatMap((c) => eventsByKey.get(c.key) ?? []),
            bookmarks: bookmarks.map((b) => b.at),
            hits: [],
          }
        : undefined,
    [cams, spansByKey, eventsByKey, bookmarks],
  );

  const atNow = () => pb.clock.get() ?? Date.now();
  const jump = (to: number | null) => {
    if (to != null) pb.playAt(to);
  };
  const seek = (ms: number) => pb.playAt(snapToFootage(ms, drivenSpans));

  // The readout's clock: the playhead in playback, the wall clock while live.
  const [liveClock] = useState(createClock);
  useEffect(() => {
    if (pb.isPlayback) return undefined;
    const tick = () => liveClock.set(Date.now());
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [pb.isPlayback, liveClock]);

  const exportSel = () => {
    if (!focusCam || pb.sel.inMs == null || pb.sel.outMs == null) return;
    onExport({
      from: new Date(pb.sel.inMs).toISOString(),
      to: new Date(pb.sel.outMs).toISOString(),
      nodeId: focusCam.nodeId,
      cameraId: focusCam.realId,
      cameraName: focusCam.name,
    });
  };

  // ── keyboard: the Playback workspace's keys, while the dock is open ─────────
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const actions: Record<KeyAction, () => void> = {
      play: pb.togglePlaying,
      prevEvent: () => jump(prevEvent(drivenEvents, atNow())),
      nextEvent: () => jump(nextEvent(drivenEvents, atNow())),
      back5: () => pb.skip(-5),
      fwd5: () => pb.skip(5),
      back60: () => pb.skip(-60),
      fwd60: () => pb.skip(60),
      frameBack: () => pb.stepFrame(-1),
      frameFwd: () => pb.stepFrame(1),
      faster: () => pb.stepSpeedBy(1),
      slower: () => pb.stepSpeedBy(-1),
      markIn: pb.markIn,
      markOut: pb.markOut,
      zoomIn: () => pb.setSpan(stepZoom(pb.win, -1)),
      zoomOut: () => pb.setSpan(stepZoom(pb.win, 1)),
      firstRecording: () => jump(drivenSpans[0]?.s ?? null),
      liveEdge: pb.goLive,
      clearRange: pb.clearSel,
    };
    keysRef.current = (e: KeyboardEvent) => {
      const action = cams.length ? wantsKey(e, pb.hasSel) : null;
      if (!action) return;
      e.preventDefault();
      actions[action]();
    };
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return (
    <div className="shrink-0 space-y-1.5 border-t border-nb-mist/22 bg-nb-surface2/82 px-3 pb-2 pt-1.5 backdrop-blur-xs">
      <WallStrip
        pb={pb}
        focusName={focusCam?.name ?? null}
        focusRecorder={focusCam?.recorder ?? null}
        hasRecorderCams={cams.length > 0}
        onClose={onClose}
      />

      {cams.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-nb-dim2">
          Playback is from the recorders — put a recorder&apos;s camera on the wall to play its footage back.
        </p>
      ) : (
        <>
          <PlaybackTimeline
            win={pb.win}
            lanes={lanes}
            master={master}
            clock={pb.clock}
            inMs={pb.sel.inMs}
            outMs={pb.sel.outMs}
            triggers={ALL_TRIGGERS}
            showEvents
            onSeek={seek}
            onActivate={onFocusCamera}
            onZoom={pb.zoom}
            onPan={pb.pan}
            onSelect={pb.select}
          />
          <PlaybackTransport
            clock={pb.isPlayback ? pb.clock : liveClock}
            playing={pb.isPlayback && pb.playing}
            speed={pb.speed}
            maxSpeed={pb.maxSpeed}
            canReverse={pb.canReverse}
            target={targetText(pb, focusCam?.name ?? null)}
            win={pb.win}
            inMs={pb.sel.inMs}
            outMs={pb.sel.outMs}
            canExport={!!focusCam && pb.hasSel}
            canProtect={pb.hasSel}
            onProtect={() => void inv.protectSel()}
            onTogglePlay={pb.togglePlaying}
            onSkip={pb.skip}
            onFrame={pb.stepFrame}
            onSpeedStep={pb.stepSpeedBy}
            onReverse={pb.toggleReverse}
            onPrevRecording={() => jump(prevRecording(drivenSpans, atNow()))}
            onNextRecording={() => jump(nextRecording(drivenSpans, atNow()))}
            onPrevEvent={() => jump(prevEvent(drivenEvents, atNow()))}
            onNextEvent={() => jump(nextEvent(drivenEvents, atNow()))}
            onLiveEdge={pb.goLive}
            liveTitle="Back to live — every tile returns to its live stream (End)"
            onSpan={pb.setSpan}
            onMarkIn={pb.markIn}
            onMarkOut={pb.markOut}
            onClearSel={pb.clearSel}
            onExport={exportSel}
          />
        </>
      )}
    </div>
  );
}

interface WallStripProps {
  pb: WallPlayback;
  focusName: string | null;
  focusRecorder: string | null;
  hasRecorderCams: boolean;
  onClose?: () => void;
}

/** The wall's own row: live or playing back, SYNC, the focused camera, the day,
 *  and the way to put the dock away. */
function WallStrip({ pb, focusName, focusRecorder, hasRecorderCams, onClose }: Readonly<WallStripProps>) {
  // The last day the picker offers. Kept in state and ticked, not read in render:
  // a wall left open past midnight must offer the new day.
  const [today, setToday] = useState(() => localDay(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setToday(localDay(Date.now())), 60_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-1.5">
      <ModeBadge playback={pb.isPlayback} />

      {/* SYNC — every filled tile plays this instant, together. Off, only the
          focused tile goes to playback and the rest of the wall stays live, which
          is what you want when you are checking one camera against what the
          others are showing NOW. */}
      <button
        type="button"
        onClick={pb.toggleSync}
        disabled={!pb.isPlayback}
        aria-pressed={pb.sync}
        title={
          pb.sync
            ? "Sync on — every camera on the wall plays this instant"
            : "Sync — play every camera on the wall at this instant"
        }
        className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] border px-2 text-[11px] font-semibold tracking-[.6px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
          pb.sync
            ? "border-nb-teal/50 bg-nb-teal/15 text-nb-tealb"
            : "border-nb-mist/22 text-nb-soft hover:border-nb-teal/60 hover:text-nb-teal"
        }`}
      >
        <Icon icon="heroicons-outline:squares-2x2" className="text-sm" />
        SYNC
      </button>

      <FocusLabel name={focusName} recorder={focusRecorder} playback={pb.isPlayback} hasRecorderCams={hasRecorderCams} />

      {/* DATE. The native picker brings the platform's own calendar, keyboard
          entry and locale; `max` stops a future day that cannot hold footage. */}
      <label
        title="Play back another day"
        className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] border border-nb-mist/22 px-2 text-nb-soft transition focus-within:border-nb-teal/60 hover:border-nb-teal/60"
      >
        <Icon icon="heroicons-outline:calendar-days" className="text-sm text-nb-dim2" />
        <input
          type="date"
          aria-label="Day"
          value={localDay((pb.win.fromMs + pb.win.toMs) / 2)}
          max={today}
          onChange={(e) => e.target.value && pb.pickDay(e.target.value)}
          className="w-[112px] bg-transparent font-mono text-[11px] tabular-nums text-emerald-100 outline-none"
        />
      </label>

      <button
        type="button"
        onClick={onClose}
        title="Hide playback"
        aria-label="Hide playback"
        className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] border border-nb-mist/22 text-nb-soft transition hover:border-nb-crit/50 hover:text-nb-crit"
      >
        <Icon icon="heroicons-outline:x-mark" className="text-sm" />
      </button>
    </div>
  );
}

function ModeBadge({ playback }: Readonly<{ playback: boolean }>) {
  if (playback) {
    return (
      <span className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] border border-nb-teal/50 bg-nb-teal/14 px-2 text-[11px] font-semibold tracking-[.6px] text-nb-tealb">
        <Icon icon="heroicons:play-circle" className="text-sm" />
        PLAYBACK
      </span>
    );
  }
  return (
    <span className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] border border-nb-crit/50 bg-nb-crit/14 px-2 text-[11px] font-semibold tracking-[.6px] text-nb-crit">
      <span className="h-1.5 w-1.5 rounded-full bg-nb-crit" />LIVE
    </span>
  );
}

/** Which camera the transport is bound to, or what to do to start. */
function FocusLabel({
  name,
  recorder,
  playback,
  hasRecorderCams,
}: Readonly<{ name: string | null; recorder: string | null; playback: boolean; hasRecorderCams: boolean }>) {
  if (!hasRecorderCams) return <span className="min-w-0 flex-1" />;
  if (!name) {
    return (
      <span className="min-w-0 flex-1 truncate text-[11px] text-nb-dim2">
        Click a tile to bind the transport to its camera
      </span>
    );
  }
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-nb-soft">
      <Icon icon="heroicons-solid:video-camera" className="mr-1 inline text-sm text-nb-teal" />
      {name}
      {recorder && <span className="ml-1.5 text-nb-dim2">· {recorder}</span>}
      {!playback && (
        <span className="ml-2 text-nb-dim2">Click the timeline, or press Play for the last 30 s</span>
      )}
    </span>
  );
}
