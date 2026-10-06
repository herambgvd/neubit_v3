"use client";

// PlaybackWorkspace — VMS → Playback, rebuilt to the industry baseline
// (SCRUM-304..306). Benchmarked against Milestone Smart Client, Genetec Security
// Desk, Nx Witness, Avigilon ACC, HikCentral Pro and Dahua DSS:
//
//   • rail       recorder › camera tree (a click adds the camera, up to 16), the
//                calendar marked from the recorder's own index, the stream choice
//   • grid       1/4/9/16; click a tile to make it active, double-click to maximise;
//                each tile follows the grid or plays independently
//   • timeline   master lane + one lane per camera, coloured by what triggered the
//                recording, event marks, zoom 30 s … 7 d, drag to pan
//   • transport  prev/next recording and event, ±10 s, frame step, speed with
//                slow motion and reverse, live edge, IN/OUT → export
//
// Every tile plays through TilePlayback — the recorder's fMP4 with its own t=0,
// continuing across gaps and codec changes, falling back to the recorder's
// conversion for a codec the browser cannot decode — so the grid shows what the
// recorder holds rather than what an HLS player could make of it.
//
// Deep link: ?camera=<recorder-side id>[&t=<iso>] opens that camera at that instant
// (alarm "watch the recording", the event list's Play).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { PickerGroup } from "../components/PlaybackChannelPicker";
import MotionSearchModal from "../components/MotionSearchModal";
import type { ExportRequest } from "../components/playbackTypes";
import type { FederatedCamera } from "../types";
import PlaybackInvestigation from "./PlaybackInvestigation";
import PlaybackRail from "./PlaybackRail";
import PlaybackTileView from "./PlaybackTileView";
import PlaybackTimeline, { type TimelineLane } from "./PlaybackTimeline";
import PlaybackTransport from "./PlaybackTransport";
import {
  LAYOUTS,
  TRIGGERS,
  TRIGGER_KEYS,
  gridDims,
  keyAction,
  localDay,
  nextEvent,
  nextRecording,
  prevEvent,
  prevRecording,
  stepZoom,
  unionSpans,
  windowAt,
  type KeyAction,
  type Layout,
  type TriggerKey,
} from "./playbackModel";
import { motionFrom, useGridData, useInvestigation, useRecordingDays } from "./usePlaybackData";
import { SYNC_ID, usePlaybackWorkspace, type PlaybackCam } from "./usePlaybackWorkspace";

const camKey = (c: FederatedCamera) => `fed:${c.node_id}:${typeof c.real_id === "string" ? c.real_id : c.id}`;

function toCam(c: FederatedCamera): PlaybackCam {
  const realId = typeof c.real_id === "string" ? c.real_id : c.id;
  return { key: camKey(c), nodeId: String(c.node_id), realId, name: c.name, recorder: c.node_name || "recorder" };
}

export interface PlaybackWorkspaceProps {
  onExport: (req: ExportRequest) => void;
}

export default function PlaybackWorkspace({ onExport }: Readonly<PlaybackWorkspaceProps>) {
  const ws = usePlaybackWorkspace();
  const {
    cams, layout, activeKey, active, win, sel, sync, indep, ctlFor, playAt, setPlaying,
  } = ws;

  const [maximised, setMaximised] = useState<string | null>(null);
  const [audioKey, setAudioKey] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<Set<TriggerKey>>(() => new Set(TRIGGER_KEYS));
  const [showEvents, setShowEvents] = useState(true);
  const [capNote, setCapNote] = useState(false);
  // The calendar shows the month the timeline is in, unless the operator pages it.
  const [calPage, setCalPage] = useState<{ year: number; month: number } | null>(null);
  const winDay = new Date((win.fromMs + win.toMs) / 2);
  const calView = calPage ?? { year: winDay.getFullYear(), month: winDay.getMonth() };
  const pageCal = (dir: -1 | 1) => {
    const m = calView.month + dir;
    setCalPage({ year: calView.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 });
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [motionOpen, setMotionOpen] = useState(false);

  // ── the estate's cameras ─────────────────────────────────────────────────
  const fedCamsQ = useQuery({
    queryKey: ["vms-federation-cameras", "playback-picker"],
    queryFn: () => vms.federation.cameras(),
    staleTime: 60_000,
  });
  const fedCameras = useMemo(() => fedCamsQ.data?.items ?? [], [fedCamsQ.data]);
  const camByKey = useMemo(() => new Map(fedCameras.map((c) => [camKey(c), toCam(c)])), [fedCameras]);

  const pickerGroups = useMemo<PickerGroup[]>(() => {
    const byNode = new Map<string, PickerGroup>();
    for (const c of fedCameras) {
      const id = String(c.node_id);
      let g = byNode.get(id);
      if (!g) {
        g = { key: `node:${id}`, label: c.node_name || "recorder", icon: "heroicons-outline:server-stack", rows: [] };
        byNode.set(id, g);
      }
      g.rows.push({ key: camKey(c), name: c.name, status: c.status });
    }
    const groups = [...byNode.values()];
    groups.sort((a, b) => a.label.localeCompare(b.label));
    for (const g of groups) g.rows.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  }, [fedCameras]);

  const checkedKeys = useMemo(() => new Set(cams.map((c) => c.key)), [cams]);
  const toggleCam = (key: string) => {
    if (checkedKeys.has(key)) {
      ws.removeCam(key);
      return;
    }
    const cam = camByKey.get(key);
    if (cam) setCapNote(!ws.addCam(cam));
  };

  // ── deep link ────────────────────────────────────────────────────────────
  // An id no recorder owns is SAID, not shown as an empty workspace that looks like
  // nobody picked a camera.
  const [deepLinkId] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("camera"),
  );
  const deepLinkMiss =
    deepLinkId && !fedCamsQ.isLoading && !fedCameras.some((c) => c.id === deepLinkId || c.real_id === deepLinkId)
      ? deepLinkId
      : null;
  const deepDone = useRef(false);
  useEffect(() => {
    if (deepDone.current || fedCamsQ.isLoading || !deepLinkId) return;
    deepDone.current = true;
    const hit = fedCameras.find((c) => c.id === deepLinkId || c.real_id === deepLinkId);
    if (!hit) return;
    const params = new URLSearchParams(window.location.search);
    const cam = toCam(hit);
    ws.addCam(cam);
    const t = new Date(params.get("t") ?? "").getTime();
    if (Number.isFinite(t)) {
      ws.setWin(windowAt(t, 3_600));
      playAt(t - 10_000, SYNC_ID); // a little before the moment, as Milestone opens it
    }
  }, [fedCamsQ.isLoading, fedCameras, deepLinkId, ws, playAt]);

  // ── coverage, events and bookmarks, per camera, over the visible window ──
  const { spansByKey, eventsByKey, events, bookmarks, bookmarksFailed, coverageFailed } = useGridData(cams, win);
  const activeCam = ws.activeCam;
  const inv = useInvestigation({ cams, activeCam, clock: active.clock, sel, hasSel: ws.hasSel, win });
  const { motion, setMotion } = inv;

  const lanes: TimelineLane[] = cams.map((c) => ({
    key: c.key,
    name: c.name,
    spans: spansByKey.get(c.key) ?? [],
    events: eventsByKey.get(c.key) ?? [],
    bookmarks: bookmarks.filter((b) => b.camKey === c.key).map((b) => b.at),
    hits: motion?.camKey === c.key ? motion.hits : [],
    active: c.key === activeKey,
    independent: !!indep[c.key],
    failed: coverageFailed.has(c.key),
  }));

  // The cameras the active controller drives: the whole synced grid, or one tile.
  const driven = useMemo(
    () => (active.id === SYNC_ID ? cams.filter((c) => !indep[c.key]) : cams.filter((c) => c.key === active.id)),
    [active.id, cams, indep],
  );
  const drivenSpans = useMemo(() => unionSpans(driven.map((c) => spansByKey.get(c.key) ?? [])), [driven, spansByKey]);
  const drivenEvents = useMemo(() => driven.flatMap((c) => eventsByKey.get(c.key) ?? []), [driven, eventsByKey]);

  const jump = (to: number | null) => {
    if (to != null) playAt(to);
  };
  const atNow = () => active.clock.get() ?? win.fromMs;

  // A controller's lead tile found nothing ahead: go to its next recording rather
  // than sit on a stopped clock, and stop when there is none.
  const onReachedEnd = useCallback(
    (ctlId: string, atMs: number) => {
      const own = ctlId === SYNC_ID ? cams.filter((c) => !indep[c.key]) : cams.filter((c) => c.key === ctlId);
      const next = nextRecording(unionSpans(own.map((c) => spansByKey.get(c.key) ?? [])), atMs);
      if (next != null) playAt(next, ctlId);
      else if (ctlId === active.id) setPlaying(false);
    },
    [cams, indep, spansByKey, playAt, active.id, setPlaying],
  );

  // ── calendar ─────────────────────────────────────────────────────────────
  const days = useRecordingDays(activeCam, calView);

  // ── export ───────────────────────────────────────────────────────────────
  const canExport = !!activeCam && ws.hasSel;
  const exportSel = () => {
    if (!activeCam || sel.inMs == null || sel.outMs == null) return;
    onExport({
      from: new Date(sel.inMs).toISOString(),
      to: new Date(sel.outMs).toISOString(),
      nodeId: activeCam.nodeId,
      cameraId: activeCam.realId,
      cameraName: activeCam.name,
    });
  };

  // ── fullscreen ───────────────────────────────────────────────────────────
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else rootRef.current?.requestFullscreen?.();
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  // The keys the clients share (Avigilon, Verkada, Nx): Space, arrows, Shift for
  // bigger steps, Alt for events, , . for frames, PgUp/PgDn for speed, [ ] for the
  // range, +/- for zoom, Home/End for the first recording and the live edge.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const actions: Record<KeyAction, () => void> = {
      play: ws.togglePlaying,
      prevEvent: () => jump(prevEvent(drivenEvents, atNow())),
      nextEvent: () => jump(nextEvent(drivenEvents, atNow())),
      back5: () => ws.skip(-5),
      fwd5: () => ws.skip(5),
      back60: () => ws.skip(-60),
      fwd60: () => ws.skip(60),
      frameBack: () => ws.stepFrame(-1),
      frameFwd: () => ws.stepFrame(1),
      faster: () => ws.stepSpeedBy(1),
      slower: () => ws.stepSpeedBy(-1),
      markIn: ws.markIn,
      markOut: ws.markOut,
      zoomIn: () => ws.setSpan(stepZoom(win, -1)),
      zoomOut: () => ws.setSpan(stepZoom(win, 1)),
      firstRecording: () => jump(drivenSpans[0]?.s ?? null),
      liveEdge: ws.goLiveEdge,
      clearRange: ws.clearSel,
    };
    keysRef.current = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const action = cams.length ? keyAction(e.key, { alt: e.altKey, shift: e.shiftKey }) : null;
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

  // ── grid ─────────────────────────────────────────────────────────────────
  const shown = maximised ? cams.filter((c) => c.key === maximised) : cams;
  const dims = gridDims(maximised ? 1 : layout);
  // Each controller needs exactly one tile publishing its clock: the active tile
  // when it is in the synced grid, else the first synced tile.
  const syncMaster =
    (activeKey && !indep[activeKey] && cams.some((c) => c.key === activeKey) ? activeKey : null) ??
    cams.find((c) => !indep[c.key])?.key ??
    null;

  const toggleTrigger = (t: TriggerKey) =>
    setTriggers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const target = active.id === SYNC_ID ? "grid" : `${ws.activeCam?.name ?? "tile"} (independent)`;

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full gap-3 p-3 text-[#f2f6ff] [transform:translateZ(0)]"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {!fullscreen && (
        <PlaybackRail
          groups={pickerGroups}
          checkedKeys={checkedKeys}
          onToggle={toggleCam}
          loading={fedCamsQ.isLoading}
          error={fedCamsQ.error ? apiError(fedCamsQ.error, "Could not reach the recorders") : null}
          capNote={capNote}
          calView={calView}
          selectedDay={localDay((win.fromMs + win.toMs) / 2)}
          footageDays={days.footageDays}
          eventDays={days.eventDays}
          onSelectDay={(day) => {
            setCalPage(null);
            ws.pickDay(day);
          }}
          onPage={pageCal}
          markedFor={activeCam}
          daysFailed={days.failed}
          stream={ws.stream}
          onStream={ws.setStream}
        />
      )}

      {/* ── Grid + timeline ───────────────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.55)]">
        <GridHeader
          camCount={cams.length}
          target={target}
          layout={layout}
          maximised={!!maximised}
          panelOpen={panelOpen}
          fullscreen={fullscreen}
          onPanel={() => setPanelOpen((o) => !o)}
          onLayout={(l) => {
            ws.setLayout(l);
            setMaximised(null);
          }}
          onFullscreen={toggleFullscreen}
          onClear={() => {
            ws.clearAll();
            setMaximised(null);
          }}
        />

        <div className="min-h-0 flex-1 p-2">
          {cams.length === 0 ? (
            <EmptyGrid missingId={deepLinkMiss} />
          ) : (
            <div
              className="grid h-full min-h-0 gap-1.5"
              style={{
                gridTemplateColumns: `repeat(${dims.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${dims.rows}, minmax(0, 1fr))`,
              }}
            >
              {shown.map((c) => {
                const ctl = ctlFor(c.key);
                const independent = !!indep[c.key];
                return (
                  <PlaybackTileView
                    key={c.key}
                    cam={c}
                    ctl={ctl}
                    master={independent || c.key === syncMaster}
                    active={c.key === activeKey}
                    independent={independent}
                    stream={ws.stream}
                    rateMax={ws.maxSpeed}
                    audio={audioKey === c.key}
                    compact={!maximised && layout >= 9}
                    maximised={maximised === c.key}
                    onActivate={ws.setActiveKey}
                    onRemove={(k) => {
                      ws.removeCam(k);
                      if (maximised === k) setMaximised(null);
                    }}
                    onToggleIndependent={ws.toggleIndependent}
                    onToggleAudio={(k) => setAudioKey((a) => (a === k ? null : k))}
                    onToggleMaximise={(k) => setMaximised((m) => (m === k ? null : k))}
                    onReachedEnd={onReachedEnd}
                  />
                );
              })}
              {/* The layout's free panes, so the grid reads as a split screen. */}
              {!maximised &&
                Array.from({ length: Math.max(0, layout - shown.length) }, (_, i) => (
                  <div
                    key={`empty-${i}`}
                    className="flex items-center justify-center rounded-lg border border-dashed border-[rgba(160,150,245,.18)] text-[11px] text-[#9db0d8]/60"
                  >
                    Tick a camera to add it
                  </div>
                ))}
            </div>
          )}
        </div>

        {cams.length > 0 && (
          <div className="shrink-0 space-y-2 border-t border-[rgba(160,150,245,.22)] px-3 pb-2 pt-1">
            <PlaybackTimeline
              win={win}
              lanes={lanes}
              clock={active.clock}
              inMs={sel.inMs}
              outMs={sel.outMs}
              triggers={triggers}
              showEvents={showEvents}
              onSeek={(ms) => playAt(ms)}
              onActivate={ws.setActiveKey}
              onZoom={ws.zoom}
              onPan={ws.pan}
              onSelect={ws.setRange}
            />

            <TimelineLegend
              triggers={triggers}
              onToggle={toggleTrigger}
              showEvents={showEvents}
              onToggleEvents={() => setShowEvents((v) => !v)}
            />

            <PlaybackTransport
              clock={active.clock}
              playing={active.playing}
              speed={active.speed}
              maxSpeed={ws.maxSpeed}
              canReverse={ws.canReverse}
              target={target}
              win={win}
              inMs={sel.inMs}
              outMs={sel.outMs}
              canExport={canExport}
              canProtect={ws.hasSel && cams.length > 0}
              onProtect={() => void inv.protectSel()}
              onTogglePlay={ws.togglePlaying}
              onSkip={ws.skip}
              onFrame={ws.stepFrame}
              onSpeedStep={ws.stepSpeedBy}
              onReverse={() => ws.setSpeed(active.speed < 0 ? 1 : -1)}
              onPrevRecording={() => jump(prevRecording(drivenSpans, atNow()))}
              onNextRecording={() => jump(nextRecording(drivenSpans, atNow()))}
              onPrevEvent={() => jump(prevEvent(drivenEvents, atNow()))}
              onNextEvent={() => jump(nextEvent(drivenEvents, atNow()))}
              onLiveEdge={ws.goLiveEdge}
              onSpan={ws.setSpan}
              onMarkIn={ws.markIn}
              onMarkOut={ws.markOut}
              onClearSel={ws.clearSel}
              onExport={exportSel}
            />
            {sync.anchorMs == null && (
              <p className="text-center text-[11px] text-[#9db0d8]">Click the timeline to start playback.</p>
            )}
          </div>
        )}
      </div>

      {panelOpen && !fullscreen && cams.length > 0 && (
        <PlaybackInvestigation
          clock={active.clock}
          activeCamName={activeCam?.name ?? null}
          events={events}
          bookmarks={bookmarks}
          bookmarksFailed={bookmarksFailed}
          motion={motion}
          exportsList={inv.exportsList}
          canExportAll={!!inv.selIso}
          selectionText={inv.selectionText}
          onSeek={(ms, key) => {
            if (key) ws.setActiveKey(key);
            playAt(ms, key ? ctlFor(key).id : undefined);
          }}
          onAddBookmark={inv.addBookmark}
          onDeleteBookmark={(b) => void inv.deleteBookmark(b)}
          onMotionSearch={() => setMotionOpen(true)}
          onClearMotion={() => setMotion(null)}
          onExportAll={() => void inv.exportAll()}
          onDownload={(x) => void inv.downloadExport(x)}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {motionOpen && activeCam && (
        <MotionSearchModal
          open
          onClose={() => setMotionOpen(false)}
          nodeId={activeCam.nodeId}
          cameraId={activeCam.realId}
          cameraName={activeCam.name}
          seedFrom={inv.motionSeed.from}
          seedTo={inv.motionSeed.to}
          onResults={(r) => setMotion(motionFrom(activeCam, r))}
          onSeekHit={(iso) => playAt(new Date(iso).getTime() - 2_000)}
        />
      )}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface TimelineLegendProps {
  triggers: ReadonlySet<TriggerKey>;
  onToggle: (t: TriggerKey) => void;
  showEvents: boolean;
  onToggleEvents: () => void;
}

/** The colour key under the timeline; it doubles as the filter, the way Milestone's
 *  legend does. */
function TimelineLegend({ triggers, onToggle, showEvents, onToggleEvents }: Readonly<TimelineLegendProps>) {
  const skin = (on: boolean) => (on ? "text-[#f2f6ff]" : "text-[#9db0d8] line-through opacity-50");
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px]">
      {TRIGGER_KEYS.map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={triggers.has(t)}
          onClick={() => onToggle(t)}
          className={`inline-flex items-center gap-1.5 ${skin(triggers.has(t))}`}
        >
          <span className="h-2.5 w-3.5 rounded-sm" style={{ background: TRIGGERS[t].hex }} />
          <span>{TRIGGERS[t].label}</span>
        </button>
      ))}
      <button
        type="button"
        aria-pressed={showEvents}
        onClick={onToggleEvents}
        className={`inline-flex items-center gap-1.5 ${skin(showEvents)}`}
      >
        <span className="h-2.5 w-0.5 bg-[#fde047]" />
        <span>Events</span>
      </button>
      <span className="inline-flex items-center gap-1.5 text-[#38bdf8]">
        <span className="h-2.5 w-1 rounded-sm bg-[#38bdf8]" />
        <span>Bookmarks</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-[#9db0d8]">
        <span className="h-2.5 w-px bg-red-400" />
        <span>Now</span>
      </span>
    </div>
  );
}

interface GridHeaderProps {
  camCount: number;
  target: string;
  layout: Layout;
  maximised: boolean;
  panelOpen: boolean;
  fullscreen: boolean;
  onPanel: () => void;
  onLayout: (l: Layout) => void;
  onFullscreen: () => void;
  onClear: () => void;
}

/** The bar over the grid: what is loaded and what drives it, the investigation
 *  panel, the 1/4/9/16 split, full screen, clear. */
function GridHeader(p: Readonly<GridHeaderProps>) {
  const on = "bg-[rgba(34,211,238,.15)] text-[#67e8f9]";
  const off = "text-[#9db0d8] hover:text-[#f2f6ff]";
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(160,150,245,.22)] px-3 py-1.5">
      <Icon icon="heroicons-outline:film" className="text-sm text-[#9db0d8]" />
      <span className="text-[13px] font-medium">Playback</span>
      <span className="text-[11px] text-[#9db0d8]">
        {p.camCount ? `${plural(p.camCount, "camera")} · ${p.target}` : "no cameras"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          aria-pressed={p.panelOpen}
          onClick={p.onPanel}
          title="Events, bookmarks, motion search and exports"
          className={`mr-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition ${p.panelOpen ? on : off}`}
        >
          <Icon icon="heroicons-outline:magnifying-glass-circle" className="text-sm" />
          <span>Investigate</span>
        </button>
        {LAYOUTS.map((l) => {
          const fits = l >= p.camCount;
          const current = p.layout === l && !p.maximised;
          return (
            <button
              key={l}
              type="button"
              disabled={!fits}
              title={fits ? plural(l, "tile") : `${p.camCount} cameras do not fit ${l}`}
              aria-pressed={current}
              onClick={() => p.onLayout(l)}
              className={`h-7 w-7 rounded-md text-[11px] font-semibold tabular-nums transition disabled:opacity-30 ${current ? on : off}`}
            >
              {l}
            </button>
          );
        })}
        <button
          type="button"
          title={p.fullscreen ? "Exit full screen" : "Full screen"}
          aria-label={p.fullscreen ? "Exit full screen" : "Full screen"}
          onClick={p.onFullscreen}
          className={`ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md ${off}`}
        >
          <Icon icon={p.fullscreen ? "heroicons-outline:arrows-pointing-in" : "heroicons-outline:arrows-pointing-out"} />
        </button>
        {p.camCount > 0 && (
          <button type="button" onClick={p.onClear} className="ml-1 text-[12px] text-[#9db0d8] hover:text-[#67e8f9]">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** The grid before a camera is picked, or when a deep link names one nobody owns. */
function EmptyGrid({ missingId }: Readonly<{ missingId: string | null }>) {
  if (missingId) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-[#9db0d8]">
        <Icon icon="heroicons:exclamation-triangle" className="mb-3 text-5xl text-red-400/70" />
        <p className="font-medium text-[#f2f6ff]">That camera is not in this estate</p>
        <p className="mt-1 max-w-md text-sm">
          No recorder here owns camera {missingId}. It may have been removed, or belong to a recorder this account
          cannot see.
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-[#9db0d8]">
      <Icon icon="heroicons-outline:play-circle" className="mb-3 text-5xl opacity-40" />
      <p className="font-medium text-[#f2f6ff]">Pick cameras to play back</p>
      <p className="mt-1 max-w-md text-sm">
        Tick cameras on the left: up to 16 play in sync. Pick a day on the calendar, then click the timeline to jump.
      </p>
    </div>
  );
}
