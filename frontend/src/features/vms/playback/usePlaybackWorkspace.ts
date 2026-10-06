"use client";

// usePlaybackWorkspace — the state of the Playback workspace (SCRUM-304..306).
//
// ── Controllers: one synced group, any number of independent tiles ─────────
// Every professional client plays a grid against ONE master time and lets a single
// tile break away when the investigation needs two moments side by side (Milestone's
// "independent playback", Nx's Sync toggle). That is modelled as CONTROLLERS: the
// synced group is one, and each independent tile is its own. A controller is an
// anchor (where its sessions begin), play/pause, a speed and a clock. The timeline
// and transport always drive the controller of the ACTIVE tile, so the same buttons
// mean "the grid" or "this tile" depending on what the operator clicked last.
//
// The clock is the subscribable object from useWallPlayback, not React state: it
// moves several times a second and only the playhead and the readout need it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createClock, type WallClock } from "../hooks/useWallPlayback";
import type { PlaybackStream } from "../types";
import {
  DEFAULT_SPAN_S,
  LIVE_EDGE_LAG_MS,
  MAX_TILES,
  clampSpeed,
  dayStart,
  reverseAllowed,
  dayWindow,
  followPage,
  layoutFor,
  maxSpeedFor,
  panWindow,
  spanWindow,
  stepSpeed,
  windowAt,
  zoomWindow,
  type Layout,
  type Win,
} from "./playbackModel";

/** A camera in the workspace, addressed on the recorder that owns it. */
export interface PlaybackCam {
  key: string;
  nodeId: string;
  realId: string;
  name: string;
  recorder: string;
}

export const SYNC_ID = "sync";

export interface Controller {
  id: string;
  /** Where this controller's sessions begin; null = nothing anchored yet. */
  anchorMs: number | null;
  anchorSeq: number;
  playing: boolean;
  /** Signed: negative is reverse. */
  speed: number;
  clock: WallClock;
  /** A frame step / reverse step: an instant every tile shows without re-anchoring. */
  scrubMs: number | null;
  scrubSeq: number;
}

function newController(id: string, at: number | null, playing = true, speed = 1): Controller {
  const clock = createClock();
  if (at != null) clock.set(at);
  return { id, anchorMs: at, anchorSeq: at == null ? 0 : 1, playing, speed, clock, scrubMs: null, scrubSeq: 0 };
}

// Reverse play has no native decoder support in a browser, and the recorder's
// progressive stream cannot seek, so it is stepped: every REVERSE_TICK_MS the
// controller moves back by speed × tick and every tile opens a window at that instant
// and shows its first frame. It is how the recorder's own console reverses too.
const REVERSE_TICK_MS = 1_000;
// One video frame at 25 fps, the frame step when the stream's rate is unknown.
export const FRAME_MS = 40;

export interface Selection {
  inMs: number | null;
  outMs: number | null;
}

export function usePlaybackWorkspace() {
  const [cams, setCams] = useState<PlaybackCam[]>([]);
  const [layout, setLayout] = useState<Layout>(4);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [stream, setStream] = useState<PlaybackStream>("auto");
  const [win, setWin] = useState<Win>(() => windowAt(Date.now() - DEFAULT_SPAN_S * 500, DEFAULT_SPAN_S));
  // The timeline follows the playhead while playing until the operator moves the
  // track by hand; any seek hands it back.
  const [follow, setFollow] = useState(true);
  const [sel, setSel] = useState<Selection>({ inMs: null, outMs: null });

  const [sync, setSync] = useState<Controller>(() => newController(SYNC_ID, null));
  const [indep, setIndep] = useState<Record<string, Controller>>({});

  const ctlFor = useCallback((key: string | null): Controller => (key && indep[key]) || sync, [indep, sync]);
  const active = ctlFor(activeKey);
  const tileCount = cams.length;

  // ── controller updates ────────────────────────────────────────────────────
  const patchCtl = useCallback((id: string, fn: (c: Controller) => Partial<Controller>) => {
    if (id === SYNC_ID) setSync((c) => ({ ...c, ...fn(c) }));
    else setIndep((m) => (m[id] ? { ...m, [id]: { ...m[id], ...fn(m[id]) } } : m));
  }, []);

  /** Seek the active controller (or `id`) to an instant: every tile it drives re-opens there. */
  const playAt = useCallback(
    (ms: number, id: string = active.id) => {
      const at = Math.round(Math.min(ms, Date.now() - LIVE_EDGE_LAG_MS));
      const ctl = id === SYNC_ID ? sync : indep[id];
      ctl?.clock.set(at);
      patchCtl(id, (c) => ({ anchorMs: at, anchorSeq: c.anchorSeq + 1 }));
      setFollow(true);
    },
    [active.id, sync, indep, patchCtl],
  );

  /** Show an instant without re-anchoring (frame step, reverse step). */
  const scrubTo = useCallback(
    (ms: number, id: string = active.id) => {
      const ctl = id === SYNC_ID ? sync : indep[id];
      ctl?.clock.set(ms);
      patchCtl(id, (c) => ({ scrubMs: ms, scrubSeq: c.scrubSeq + 1 }));
    },
    [active.id, sync, indep, patchCtl],
  );

  const setPlaying = useCallback(
    (playing: boolean) => {
      patchCtl(active.id, () => ({ playing }));
      if (playing) setFollow(true);
    },
    [active.id, patchCtl],
  );
  const togglePlaying = useCallback(() => setPlaying(!active.playing), [setPlaying, active.playing]);

  const setSpeed = useCallback(
    (speed: number) => patchCtl(active.id, () => ({ speed: clampSpeed(speed, Math.max(1, tileCount)), playing: true })),
    [active.id, patchCtl, tileCount],
  );
  const stepSpeedBy = useCallback(
    (dir: -1 | 1) => setSpeed(stepSpeed(active.speed, dir, Math.max(1, tileCount))),
    [setSpeed, active.speed, tileCount],
  );

  const skip = useCallback(
    (seconds: number) => {
      const at = active.clock.get();
      if (at != null) playAt(at + seconds * 1000);
    },
    [active.clock, playAt],
  );

  /** One frame forward or back; pauses first, like every client's frame step. */
  const stepFrame = useCallback(
    (dir: -1 | 1) => {
      const at = active.clock.get();
      if (at == null) return;
      patchCtl(active.id, () => ({ playing: false }));
      scrubTo(at + dir * FRAME_MS);
    },
    [active.clock, active.id, patchCtl, scrubTo],
  );

  const goLiveEdge = useCallback(() => {
    const at = Date.now() - LIVE_EDGE_LAG_MS - 2_000;
    playAt(at);
    patchCtl(active.id, () => ({ playing: true, speed: 1 }));
    setWin((w) => followPage(spanWindow(w, (w.toMs - w.fromMs) / 1000, at - (w.toMs - w.fromMs) * 0.35), at));
  }, [playAt, patchCtl, active.id]);

  // ── tiles ────────────────────────────────────────────────────────────────
  // A grid that grew past what its speed allows slows down rather than stalls.
  const clampAllSpeeds = useCallback((n: number) => {
    setSync((c) => ({ ...c, speed: clampSpeed(c.speed, n) }));
    setIndep((m) => {
      const out: Record<string, Controller> = {};
      for (const [k, c] of Object.entries(m)) out[k] = { ...c, speed: clampSpeed(c.speed, n) };
      return out;
    });
  }, []);

  const addCam = useCallback(
    (cam: PlaybackCam): boolean => {
      if (cams.some((c) => c.key === cam.key)) {
        setActiveKey(cam.key);
        return true;
      }
      if (cams.length >= MAX_TILES) return false;
      const next = [...cams, cam];
      setCams(next);
      setActiveKey(cam.key);
      setLayout((l) => (l >= next.length ? l : layoutFor(next.length)));
      // The first camera starts the grid at the playhead, or — with nothing anchored
      // yet — at the start of the window, which the recorder clamps forward to its
      // first footage there.
      if (sync.anchorMs == null) playAt(sync.clock.get() ?? win.fromMs, SYNC_ID);
      clampAllSpeeds(next.length);
      return true;
    },
    [cams, sync.anchorMs, sync.clock, win.fromMs, playAt, clampAllSpeeds],
  );

  const removeCam = useCallback(
    (key: string) => {
      setCams((cs) => cs.filter((c) => c.key !== key));
      setIndep(({ [key]: _gone, ...rest }) => rest);
      setActiveKey((a) => (a === key ? (cams.find((c) => c.key !== key)?.key ?? null) : a));
    },
    [cams],
  );

  const clearAll = useCallback(() => {
    setCams([]);
    setIndep({});
    setActiveKey(null);
    setSel({ inMs: null, outMs: null });
  }, []);

  /** Break a tile away from the grid's time, or bring it back to it. Coming back
   *  re-syncs the grid at the grid's own time (Milestone's "re-sync"): a tile that
   *  rejoined at the instant it left would play minutes away from its neighbours. */
  const toggleIndependent = useCallback(
    (key: string) => {
      if (indep[key]) {
        setIndep(({ [key]: _back, ...rest }) => rest);
        const at = sync.clock.get();
        if (at != null) playAt(at, SYNC_ID);
      } else {
        // It starts where the grid is, then goes its own way.
        setIndep((m) => ({ ...m, [key]: newController(key, sync.clock.get(), sync.playing, sync.speed) }));
      }
      setActiveKey(key);
    },
    [indep, sync.clock, sync.playing, sync.speed, playAt],
  );

  // ── timeline window ──────────────────────────────────────────────────────
  const zoom = useCallback((factor: number, centerMs?: number) => setWin((w) => zoomWindow(w, factor, centerMs)), []);
  const setSpan = useCallback(
    (seconds: number) => setWin((w) => spanWindow(w, seconds, active.clock.get() ?? undefined)),
    [active.clock],
  );
  const pan = useCallback((deltaMs: number) => {
    setFollow(false);
    setWin((w) => panWindow(w, deltaMs));
  }, []);

  /** A calendar day: frame the day at the current span (all of it at 24 h or more)
   *  and start at that day's first footage, keeping the time of day otherwise. */
  const pickDay = useCallback(
    (day: string) => {
      const start = dayStart(day);
      if (!Number.isFinite(start)) return;
      const span = (win.toMs - win.fromMs) / 1000;
      const at = active.clock.get();
      const timeOfDay = at == null ? 0 : at - dayWindow(at).fromMs;
      const target = span >= 86_400 ? start : Math.min(start + timeOfDay, Date.now());
      setWin(span >= 86_400 ? dayWindow(start) : windowAt(target, span));
      playAt(span >= 86_400 ? start : target);
    },
    [win, active.clock, playAt],
  );

  // Follow paging while playing.
  useEffect(() => {
    if (!follow) return undefined;
    return active.clock.subscribe((ms) => {
      if (ms == null) return;
      setWin((w) => followPage(w, ms));
    });
  }, [follow, active.clock]);

  // Reverse play: step every controller that is playing backwards. The interval is
  // keyed on WHICH controllers reverse, not on their state, so the scrubs it makes
  // (each one a state change) do not restart it; it reads the rest through a ref.
  const ctlsRef = useRef<Controller[]>([]);
  const scrubRef = useRef(scrubTo);
  useEffect(() => {
    ctlsRef.current = [sync, ...Object.values(indep)];
    scrubRef.current = scrubTo;
  });
  const reversingKey = useMemo(
    () =>
      [sync, ...Object.values(indep)]
        .filter((c) => c.playing && c.speed < 0)
        .map((c) => c.id)
        .join(","),
    [sync, indep],
  );
  useEffect(() => {
    if (!reversingKey) return undefined;
    const id = setInterval(() => {
      for (const c of ctlsRef.current) {
        if (!c.playing || c.speed >= 0) continue;
        const at = c.clock.get();
        if (at != null) scrubRef.current(at + c.speed * REVERSE_TICK_MS, c.id);
      }
    }, REVERSE_TICK_MS);
    return () => clearInterval(id);
  }, [reversingKey]);

  // The clock keeps time even when no camera can: a lead tile still opening, or in
  // a gap, would otherwise freeze the playhead while the other tiles play on. When
  // nothing has published for a moment the controller carries its own clock at its
  // speed, and stands down the instant a tile publishes again (useWallPlayback's
  // heartbeat, per controller).
  const playingKey = useMemo(
    () =>
      [sync, ...Object.values(indep)]
        .filter((c) => c.playing && c.speed > 0 && c.anchorMs != null)
        .map((c) => `${c.id}:${c.speed}`)
        .join(","),
    [sync, indep],
  );
  useEffect(() => {
    if (!playingKey) return undefined;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      for (const c of ctlsRef.current) {
        if (!c.playing || c.speed <= 0 || c.clock.sincePublished() < 1_500) continue;
        c.clock.advance(dt * c.speed);
      }
    }, 250);
    return () => clearInterval(id);
  }, [playingKey]);

  // ── IN / OUT ─────────────────────────────────────────────────────────────
  const markIn = useCallback(() => {
    const at = active.clock.get();
    if (at == null) return;
    setSel((s) => ({ inMs: at, outMs: s.outMs != null && s.outMs > at ? s.outMs : null }));
  }, [active.clock]);
  const markOut = useCallback(() => {
    const at = active.clock.get();
    if (at == null) return;
    setSel((s) => (s.inMs != null && at > s.inMs ? { ...s, outMs: at } : { inMs: s.inMs, outMs: null }));
  }, [active.clock]);
  const setRange = useCallback((a: number, b: number) => setSel({ inMs: Math.min(a, b), outMs: Math.max(a, b) }), []);
  const clearSel = useCallback(() => setSel({ inMs: null, outMs: null }), []);
  const hasSel = sel.inMs != null && sel.outMs != null && sel.outMs > sel.inMs;

  return {
    cams,
    layout,
    setLayout,
    activeKey,
    setActiveKey,
    activeCam: cams.find((c) => c.key === activeKey) ?? null,
    stream,
    setStream,
    win,
    setWin,
    follow,
    sel,
    hasSel,
    sync,
    indep,
    active,
    ctlFor,
    maxSpeed: maxSpeedFor(Math.max(1, tileCount)),
    canReverse: reverseAllowed(Math.max(1, tileCount)),
    addCam,
    removeCam,
    clearAll,
    toggleIndependent,
    playAt,
    scrubTo,
    setPlaying,
    togglePlaying,
    setSpeed,
    stepSpeedBy,
    skip,
    stepFrame,
    goLiveEdge,
    zoom,
    setSpan,
    pan,
    pickDay,
    markIn,
    markOut,
    setRange,
    clearSel,
  };
}

export type PlaybackWorkspace = ReturnType<typeof usePlaybackWorkspace>;
