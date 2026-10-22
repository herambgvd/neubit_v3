"use client";

// useWallPlayback — the wall's DVR state: live ⇄ playback, the window the
// timeline shows, where the playhead is, and whether every tile plays back
// together (Sync).
//
// Modelled on the recorder console's own Live page (neubit_nvr
// `app/(console)/live/page.tsx`), which is the reference this wall is meant to
// match: one window, one anchor, one shared clock, and tiles that either show
// their live stream or the recording at that instant IN PLACE. Playback is not a
// separate screen or a modal here — it is a mode the wall enters.
//
// The controls are the Playback workspace's (SCRUM-337): its window arithmetic,
// speed ladder, frame step, stepped reverse and IN/OUT range come from
// playback/playbackModel, so the two surfaces answer every key and button the
// same way. What stays the wall's own is SYNC: off, only the focused tile plays
// back while the rest of the wall stays live (HikCentral's instant playback); on,
// the whole wall shows one instant.
//
// ── Why an anchor + a seq, and not just a timestamp ────────────────────────
// The node serves `[requested → end of that coverage span]`, so a playback
// session IS "the recording starting at an instant". A seek therefore means "every
// playing tile re-anchors at this instant". `seq` bumps on every seek so a tile
// can tell "seek again to where you already are" (a re-anchor after a gap, a
// retry) from "nothing changed" — the timestamp alone cannot say that. A SCRUB
// (frame step, a reverse step) is the other kind of move: an instant every tile
// shows without re-anchoring, with its own seq for the same reason.
//
// ── Why the playhead is NOT React state ───────────────────────────────────
// It moves 4+ times a second. Putting it in state re-renders the whole wall at
// that rate, and on a 64-tile grid that is the difference between a smooth wall
// and a stuttering one. It lives in a subscribable clock object instead: the
// master tile writes it, the transport bar and the follower tiles subscribe, and
// nothing else in the tree hears about it at all.
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_SPAN_S,
  FRAME_MS,
  INSTANT_REPLAY_MS,
  LIVE_EDGE_LAG_MS,
  REVERSE_TICK_MS,
  SYNC_MAX_TILES,
  clampSpeed,
  dayStart,
  dayWindow,
  followLive,
  followPage,
  liveWindow,
  maxSpeedFor,
  panWindow,
  reverseAllowed,
  stepSpeed,
  windowAt,
  zoomWindow,
  type Win,
} from "../playback/playbackModel";

/** The timeline window in epoch ms. */
export type WallWindow = Win;

/** The shared playhead — see `createClock`. `null` = live (no playhead). */
export interface WallClock {
  get: () => number | null;
  set: (v: number | null) => void;
  advance: (deltaMs: number) => void;
  sincePublished: () => number;
  subscribe: (fn: (ms: number | null) => void) => () => void;
}

export type WallMode = "live" | "playback";

/** The IN/OUT range an export or an evidence hold is made from. */
export interface WallSelection {
  inMs: number | null;
  outMs: number | null;
}

// ── the shared playhead ─────────────────────────────────────────────────────
// A plain subscribable value. The master tile publishes; the transport bar and
// the synced tiles subscribe. Deliberately outside React: see the header.
export function createClock(): WallClock {
  let ms: number | null = null;
  // When a TILE last published. `advance` deliberately does not touch it, so the
  // heartbeat below can tell "a camera is driving this" from "nobody is".
  let publishedAt = 0;
  const subs = new Set<(ms: number | null) => void>();
  const emit = () => subs.forEach((fn) => fn(ms));
  return {
    get: () => ms,
    // The master tile, or a seek.
    set(v: number | null) {
      ms = v;
      publishedAt = Date.now();
      emit();
    },
    // The heartbeat, carrying the clock over a camera that cannot.
    advance(deltaMs: number) {
      if (ms == null) return;
      ms += deltaMs;
      emit();
    },
    sincePublished: () => Date.now() - publishedAt,
    subscribe(fn: (ms: number | null) => void) {
      subs.add(fn);
      fn(ms);
      return () => subs.delete(fn);
    },
  };
}

export interface UseWallPlaybackOptions {
  /** Tiles with a camera — how many play back when Sync is on (up to
   *  SYNC_MAX_TILES), which is what the speed ceiling and reverse are limited by. */
  filledTiles?: number;
}

export function useWallPlayback({ filledTiles = 1 }: UseWallPlaybackOptions = {}) {
  const [mode, setMode] = useState<WallMode>("live");
  const [sync, setSync] = useState(false);
  const [win, setWin] = useState<Win>(() => liveWindow(Date.now(), DEFAULT_SPAN_S));
  // Where every playing tile's session begins, and the last scrub (see header).
  const [anchor, setAnchor] = useState<{ ms: number | null; seq: number }>({ ms: null, seq: 0 });
  const [scrub, setScrub] = useState<{ ms: number | null; seq: number }>({ ms: null, seq: 0 });
  const [playing, setPlaying] = useState(true);
  const [requestedSpeed, setRequestedSpeed] = useState(1);
  // The timeline follows the playhead (or, live, "now") until the operator moves
  // it by hand; any seek hands it back.
  const [follow, setFollow] = useState(true);
  const [sel, setSel] = useState<WallSelection>({ inMs: null, outMs: null });

  // One clock for the life of the component. A lazy useState initialiser gives
  // the same create-exactly-once guarantee as the `if (!ref.current)` idiom
  // without writing a ref during render.
  const [clock] = useState(createClock);

  // Every tile that plays back decodes every frame at the transport's rate, so the
  // ceiling is set by how many do: the focused one alone, or the wall up to its
  // Sync limit.
  const tiles = sync ? Math.min(Math.max(1, filledTiles), SYNC_MAX_TILES) : 1;
  const speed = clampSpeed(requestedSpeed, tiles);

  // Enter playback at an instant (from the timeline, a step, a skip). Also the
  // seek: in playback this re-anchors, which is the only operation the node's
  // session model actually has. Never past what the recorder has written.
  const playAt = useCallback(
    (atMs: number) => {
      const ms = Math.round(Math.min(atMs, Date.now() - LIVE_EDGE_LAG_MS));
      clock.set(ms);
      setAnchor((a) => ({ ms, seq: a.seq + 1 }));
      setPlaying(true);
      setMode("playback");
      setFollow(true);
    },
    [clock],
  );

  /** Show an instant without re-anchoring: a frame step, a reverse step. */
  const scrubTo = useCallback(
    (ms: number) => {
      clock.set(ms);
      setScrub((s) => ({ ms, seq: s.seq + 1 }));
    },
    [clock],
  );

  const goLive = useCallback(() => {
    setMode("live");
    setSync(false);
    setAnchor({ ms: null, seq: 0 });
    setScrub({ ms: null, seq: 0 });
    setRequestedSpeed(1);
    setPlaying(true);
    setFollow(true);
    clock.set(null);
    // A live wall is always "now", so put the window back where the operator can
    // see now — otherwise returning to live leaves the timeline parked in the past.
    setWin((w) => liveWindow(Date.now(), (w.toMs - w.fromMs) / 1000));
  }, [clock]);

  // Move the playhead by a signed number of seconds. From a live wall a step BACK
  // is an instant replay of that much — the arrow key every client honours.
  const skip = useCallback(
    (seconds: number) => {
      const base = clock.get() ?? (seconds < 0 ? Date.now() - LIVE_EDGE_LAG_MS : null);
      if (base != null) playAt(base + seconds * 1000);
    },
    [clock, playAt],
  );

  /** Play / pause. On a live wall, Play is "instant playback": the last half-minute. */
  const togglePlaying = useCallback(() => {
    if (mode !== "playback") {
      playAt(Date.now() - INSTANT_REPLAY_MS);
      return;
    }
    setPlaying((p) => !p);
  }, [mode, playAt]);

  const setSpeed = useCallback(
    (next: number) => {
      setRequestedSpeed(clampSpeed(next, tiles));
      setPlaying(true);
    },
    [tiles],
  );
  const stepSpeedBy = useCallback((dir: -1 | 1) => setSpeed(stepSpeed(speed, dir, tiles)), [setSpeed, speed, tiles]);
  // Reverse where the wall can (a small one); clampSpeed turns it forward otherwise.
  const toggleReverse = useCallback(() => setSpeed(speed < 0 ? 1 : -1), [setSpeed, speed]);

  /** One frame forward or back; pauses first, like every client's frame step. */
  const stepFrame = useCallback(
    (dir: -1 | 1) => {
      const at = clock.get();
      if (at == null) return;
      setPlaying(false);
      scrubTo(at + dir * FRAME_MS);
    },
    [clock, scrubTo],
  );

  // ── the timeline window ──────────────────────────────────────────────────
  const zoom = useCallback((factor: number, centerMs?: number) => setWin((w) => zoomWindow(w, factor, centerMs)), []);
  const pan = useCallback((deltaMs: number) => {
    setFollow(false);
    setWin((w) => panWindow(w, deltaMs));
  }, []);
  /** A rung of the zoom ladder, around the playhead — or, live, with now at the end. */
  const setSpan = useCallback(
    (seconds: number) => {
      const at = clock.get();
      setWin(at == null ? liveWindow(Date.now(), seconds) : windowAt(at, seconds));
    },
    [clock],
  );

  // Jump to a calendar day (YYYY-MM-DD). At a day-wide span that is the whole of
  // that day; at a tighter one it keeps the TIME OF DAY the operator is looking at
  // and moves it to the chosen date — "same corridor, same 14:05, yesterday".
  // Picking a day plays it, as the recorder console and the Playback page do.
  const pickDay = useCallback(
    (day: string) => {
      const start = dayStart(day);
      if (!Number.isFinite(start)) return;
      const seconds = (win.toMs - win.fromMs) / 1000;
      const base = clock.get() ?? Date.now();
      const target = seconds >= 86_400 ? start : Math.min(start + (base - dayWindow(base).fromMs), Date.now());
      setWin(seconds >= 86_400 ? dayWindow(start) : windowAt(target, seconds));
      playAt(target);
    },
    [win, clock, playAt],
  );

  // Turning Sync ON re-anchors the WHOLE wall at the current playhead.
  //
  // Without this, the tile that was already in playback keeps the session it has
  // been playing — it entered at an instant the wall has since moved past — while
  // every newly-joining tile mints at the anchor. The wall then starts out of step
  // by however long that tile had been playing; measured at sixteen seconds.
  //
  // Sync is a promise that every tile shows ONE instant. It has to make that true
  // at the moment it is pressed, not merely from then on.
  const toggleSync = useCallback(() => {
    if (!sync) {
      const at = clock.get();
      if (at != null) playAt(at);
    }
    setSync((s) => !s);
  }, [sync, clock, playAt]);

  // ── the IN / OUT range ───────────────────────────────────────────────────
  const markIn = useCallback(() => {
    const at = clock.get();
    if (at == null) return;
    setSel((s) => ({ inMs: at, outMs: s.outMs != null && s.outMs > at ? s.outMs : null }));
  }, [clock]);
  const markOut = useCallback(() => {
    const at = clock.get();
    if (at == null) return;
    setSel((s) => (s.inMs != null && at > s.inMs ? { ...s, outMs: at } : { inMs: s.inMs, outMs: null }));
  }, [clock]);
  const select = useCallback((a: number, b: number) => setSel({ inMs: Math.min(a, b), outMs: Math.max(a, b) }), []);
  const clearSel = useCallback(() => setSel({ inMs: null, outMs: null }), []);
  const hasSel = sel.inMs != null && sel.outMs != null && sel.outMs > sel.inMs;

  // ── the window follows ───────────────────────────────────────────────────
  // In playback, it pages with the playhead; live, it keeps "now" in view. Both
  // only until the operator drags the track; a seek hands it back.
  useEffect(() => {
    if (!follow || mode !== "playback") return undefined;
    return clock.subscribe((ms) => {
      if (ms != null) setWin((w) => followPage(w, ms));
    });
  }, [follow, mode, clock]);
  useEffect(() => {
    if (!follow || mode !== "live") return undefined;
    const id = setInterval(() => setWin((w) => followLive(w, Date.now())), 15_000);
    return () => clearInterval(id);
  }, [follow, mode]);

  // ── reverse: stepped, a frame each tick ──────────────────────────────────
  useEffect(() => {
    if (mode !== "playback" || !playing || speed >= 0) return undefined;
    const id = setInterval(() => {
      const at = clock.get();
      if (at != null) scrubTo(at + speed * REVERSE_TICK_MS);
    }, REVERSE_TICK_MS);
    return () => clearInterval(id);
  }, [mode, playing, speed, clock, scrubTo]);

  // ── the wall clock keeps time even when a camera cannot ──────────────────
  // The focused tile drives the playhead, which is right while it is playing —
  // and wrong the moment it cannot. Its recording ends, or it is the one camera
  // with a gap here, and the whole wall's clock stops: the transport freezes, the
  // timeline's playhead parks, and every other tile drifts with nothing telling
  // it so. Observed exactly that way — one tile hit the end of its span and the
  // other three ran on unattended.
  //
  // The timeline is TIME, not one camera's video. So when nothing has published
  // for a moment, this carries the clock forward itself at the transport's speed,
  // and stands down again the instant a tile starts publishing.
  useEffect(() => {
    if (mode !== "playback" || !playing || speed <= 0) return undefined;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      if (clock.sincePublished() < 1_500) return; // a tile is driving it
      clock.advance(dt * speed);
    }, 250);
    return () => clearInterval(id);
  }, [mode, playing, speed, clock]);

  const state = useMemo(
    () => ({
      mode,
      sync,
      win,
      anchorMs: anchor.ms,
      anchorSeq: anchor.seq,
      scrubMs: scrub.ms,
      scrubSeq: scrub.seq,
      playing,
      speed,
      follow,
      sel,
      hasSel,
      maxSpeed: maxSpeedFor(tiles),
      canReverse: reverseAllowed(tiles),
    }),
    [mode, sync, win, anchor, scrub, playing, speed, follow, sel, hasSel, tiles],
  );

  return {
    ...state,
    clock,
    isPlayback: mode === "playback",
    playAt,
    scrubTo,
    goLive,
    skip,
    togglePlaying,
    setPlaying,
    setSpeed,
    stepSpeedBy,
    toggleReverse,
    stepFrame,
    zoom,
    pan,
    setSpan,
    pickDay,
    setWin,
    toggleSync,
    setSync,
    markIn,
    markOut,
    select,
    clearSel,
  };
}

/** The wall DVR handle PlayoutBar / WallTile / Streaming share. */
export type WallPlayback = ReturnType<typeof useWallPlayback>;

export default useWallPlayback;
