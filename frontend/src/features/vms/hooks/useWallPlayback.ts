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
// ── Why an anchor + a seq, and not just a timestamp ────────────────────────
// The node serves `[requested → end of that coverage span]`, so a playback
// session IS "the recording starting at an instant". A seek therefore means "every
// playing tile re-anchors at this instant". `seq` bumps on every seek so a tile
// can tell "seek again to where you already are" (a re-anchor after a gap, a
// retry) from "nothing changed" — the timestamp alone cannot say that.
//
// ── Why the playhead is NOT React state ───────────────────────────────────
// It moves 4+ times a second. Putting it in state re-renders the whole wall at
// that rate, and on a 64-tile grid that is the difference between a smooth wall
// and a stuttering one. It lives in a subscribable clock object instead: the
// master tile writes it, the transport bar and the follower tiles subscribe, and
// nothing else in the tree hears about it at all.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DAY_MS = 86_400_000;

// The timeline's range ladder, matching the recorder console's. A 24h track is
// useless for picking a five-second event; a 5m track is useless for finding
// which hour it was in. The operator needs both.
export const RANGES = [
  { label: "5m", seconds: 300 },
  { label: "30m", seconds: 1_800 },
  { label: "1h", seconds: 3_600 },
  { label: "3h", seconds: 10_800 },
  { label: "12h", seconds: 43_200 },
  { label: "1d", seconds: 86_400 },
];

export const DEFAULT_RANGE_SECONDS = 3_600;

// Speeds the transport offers. The browser decodes every frame at any rate, and
// with Sync on the rate applies to EVERY visible tile at once, so this ladder
// stops where a wall of decoders still keeps up rather than where <video> stops
// accepting the number.
export const SPEEDS = [0.5, 1, 2, 4];

export const dayStartMs = (atMs) => {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// A window of `seconds` centred on an instant, or — at a day or more — the whole
// calendar day that instant falls in. "Yesterday 14:00" should show yesterday,
// not a rolling 24h ending at 14:00.
export function makeWindow(atMs, seconds) {
  if (seconds >= 86_400) {
    const from = dayStartMs(atMs);
    return { fromMs: from, toMs: from + DAY_MS };
  }
  const half = (seconds * 1000) / 2;
  return { fromMs: atMs - half, toMs: atMs + half };
}

// ── the shared playhead ─────────────────────────────────────────────────────
// A plain subscribable value. The master tile publishes; the transport bar and
// the synced tiles subscribe. Deliberately outside React: see the header.
function createClock() {
  let ms = null;
  // When a TILE last published. `advance` deliberately does not touch it, so the
  // heartbeat below can tell "a camera is driving this" from "nobody is".
  let publishedAt = 0;
  const subs = new Set<any>();
  const emit = () => subs.forEach((fn) => fn(ms));
  return {
    get: () => ms,
    // The master tile, or a seek.
    set(v) {
      ms = v;
      publishedAt = Date.now();
      emit();
    },
    // The heartbeat, carrying the clock over a camera that cannot.
    advance(deltaMs) {
      if (ms == null) return;
      ms += deltaMs;
      emit();
    },
    sincePublished: () => Date.now() - publishedAt,
    subscribe(fn) {
      subs.add(fn);
      fn(ms);
      return () => subs.delete(fn);
    },
  };
}

export function useWallPlayback() {
  const [mode, setMode] = useState("live"); // "live" | "playback"
  const [sync, setSync] = useState(false);
  const [rangeSeconds, setRangeSeconds] = useState(DEFAULT_RANGE_SECONDS);
  const [win, setWin] = useState(() => makeWindow(Date.now(), DEFAULT_RANGE_SECONDS));
  // Where every playing tile's session begins. `seq` makes a repeat seek to the
  // same instant a real event (see the header).
  const [anchor, setAnchor] = useState<any>({ ms: null, seq: 0 });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  // One clock for the life of the component.
  const clockRef = useRef<any>(null);
  if (!clockRef.current) clockRef.current = createClock();
  const clock = clockRef.current;

  // Enter playback at an instant (from the timeline, a span step, a skip). Also
  // the seek: in playback this re-anchors, which is the only operation the node's
  // session model actually has.
  const playAt = useCallback(
    (atMs) => {
      const ms = Math.round(atMs);
      clock.set(ms);
      setAnchor((a) => ({ ms, seq: a.seq + 1 }));
      setPlaying(true);
      setMode("playback");
    },
    [clock],
  );

  const goLive = useCallback(() => {
    setMode("live");
    setSync(false);
    setAnchor({ ms: null, seq: 0 });
    clock.set(null);
    // A live wall is always "now", so put the window back where the operator can
    // see now — otherwise returning to live leaves the timeline parked in the past.
    setWin(makeWindow(Date.now(), rangeSeconds));
  }, [clock, rangeSeconds]);

  // Move the playhead by a signed number of seconds, inside the window.
  const skip = useCallback(
    (seconds) => {
      const base = clock.get();
      if (base == null) return;
      playAt(Math.max(win.fromMs, Math.min(base + seconds * 1000, win.toMs)));
    },
    [clock, playAt, win.fromMs, win.toMs],
  );

  // Re-frame the timeline around wherever the playhead is (or now, in live).
  const setRange = useCallback(
    (seconds) => {
      setRangeSeconds(seconds);
      setWin(makeWindow(clock.get() ?? Date.now(), seconds));
    },
    [clock],
  );

  // Jump to a calendar day (YYYY-MM-DD from a date input). At a day-wide range
  // that means the whole of that day; at a tighter one it keeps the TIME OF DAY
  // the operator is already looking at and moves it to the chosen date — which is
  // how an investigation actually runs ("same corridor, same 14:05, yesterday").
  // Never past now: a window into the future has no footage in it by definition.
  const pickDay = useCallback(
    (dayISO) => {
      const dayStart = new Date(`${dayISO}T00:00:00`).getTime();
      if (Number.isNaN(dayStart)) return;
      const base = clock.get() ?? Date.now();
      const at =
        rangeSeconds >= 86_400
          ? Math.min(dayStart, Date.now())
          : Math.min(dayStart + (base - dayStartMs(base)), Date.now());
      setWin(makeWindow(at, rangeSeconds));
      clock.set(at);
      // Only re-anchor if we are ALREADY in playback: picking a date while the
      // wall is live should re-frame the timeline, not silently take every tile
      // off its live stream.
      setAnchor((a) => (a.ms == null ? a : { ms: at, seq: a.seq + 1 }));
    },
    [clock, rangeSeconds],
  );

  // Pan the window a whole page at a time — the way to walk back through a day
  // once the range is tight enough to be useful.
  const pan = useCallback(
    (dir) => {
      setWin((w) => {
        const span = w.toMs - w.fromMs;
        return { fromMs: w.fromMs + dir * span, toMs: w.toMs + dir * span };
      });
    },
    [],
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
    if (mode !== "playback" || !playing) return undefined;
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
    () => ({ mode, sync, win, rangeSeconds, anchorMs: anchor.ms, anchorSeq: anchor.seq, playing, speed }),
    [mode, sync, win, rangeSeconds, anchor.ms, anchor.seq, playing, speed],
  );

  return {
    ...state,
    clock,
    isPlayback: mode === "playback",
    playAt,
    goLive,
    skip,
    setRange,
    pickDay,
    pan,
    setWin,
    setPlaying,
    setSpeed,
    toggleSync,
    togglePlaying: useCallback(() => setPlaying((p) => !p), []),
  };
}

export default useWallPlayback;
