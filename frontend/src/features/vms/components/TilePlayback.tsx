"use client";

// TilePlayback — the RECORDED surface of a wall tile.
//
// It is the exact counterpart of LivePlayer: same cell, same chrome around it,
// same size — the tile does not open anything, it just shows the recording
// instead of the live stream. That is the whole point of playing back on the wall
// rather than in a dialog: the operator keeps the geometry, the neighbours and
// the context they built the wall for.
//
// ── One anchor, many tiles ─────────────────────────────────────────────────
// Every tile in playback mints its OWN session from the SAME anchor instant
// (`/vms/federation/.../playback`), so a wall of cameras starts together by
// construction rather than by correction. After that the FOCUSED tile publishes
// its position to the shared clock and every other tile follows it.
//
// ── What a synced wall is actually limited by ──────────────────────────────
// Not CPU — bandwidth, and specifically bandwidth AT STARTUP. The node serves a
// recorded window as a progressive fMP4 from MediaMTX's playback server, and it
// serves it as fast as the link allows: measured on this appliance, ONE tile
// pulls ~137 MB in ten seconds (~15x realtime) for a 4MP camera.
//
// Seven of those at once do not share politely. Measured, again on this
// appliance, seven concurrent windows over ten seconds:
//
//     70 MB · 42 MB · 37 MB · 27 MB · 11 MB · 2.7 MB · 0.1 MB
//
// The first few saturate the link and the last are starved to a standstill. That
// is the whole "Sync makes tiles blink and say Playback failed" report: the
// starved tiles never receive enough bytes to decode a first frame, a fixed
// stall timer calls that a failure, and the ones in between get just enough to
// start and then run dry.
//
// So this component's job is not only to show a recording — it is to be a good
// citizen on a shared link. Three rules follow, and they are why the code below
// looks the way it does:
//
//   1. Ask for a BOUNDED window (CHUNK_MAX_MS), not "everything the timeline is
//      showing". A tile that asked for 30 minutes will try to buffer 30 minutes,
//      at the expense of every other tile on the wall.
//   2. Hold a connectGate slot until this tile is genuinely COMFORTABLE (a few
//      seconds buffered), not merely until its first frame. The wall then fills
//      in orderly waves instead of every tile fighting for the same link.
//   3. Never call a slow stream a broken one. Starvation is a spinner and a wait;
//      only a stream that has delivered NOTHING for a long time is a failure.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { vms } from "../api";
import { acquireSlot, releaseSlot } from "../lib/connectGate";

// ── keeping step WITHOUT seeking ───────────────────────────────────────────
// A seek is not free on a progressive fMP4: the browser tears down and refills
// the decode pipeline, and the picture goes black for a moment. Correcting every
// half-second of drift with a seek is therefore a tile that blinks continuously —
// which is exactly what a wall of independent decoders will do, because they
// always drift a little.
//
// So small drift is corrected the way media players have always done it: nudge
// the PLAYBACK RATE a few percent and let the picture catch up or fall back
// smoothly, invisibly, with no seek at all. A hard correction is kept for drift
// large enough that nudging would take minutes to absorb.
const DRIFT_S = 0.6; // below this: already in step, do nothing
const NUDGE = 0.06; // ±6% — fast enough to absorb a second, too small to see
const RESYNC_S = 3.0; // beyond this: a hard correction is warranted
// …and even then, not on the strength of a single reading. The clock jumps when
// the master opens its next window, and treating one such tick as drift would
// seek every tile on the wall for something that corrects itself.
const HARD_TICKS = 3;
// A follower whose own footage begins AFTER the shared clock waits rather than
// chases. This is the margin at which "we are ahead of the wall" becomes real.
const AHEAD_S = 1.0;
// Nothing is corrected for this long after a window opens. A stream that has not
// finished buffering its first seconds is not drifting, it is loading, and
// seeking it only makes it slower.
const SETTLE_MS = 2_500;
// A follower that must RE-MINT to catch up may do so at most this often — a
// wall of tiles all re-minting on every drift tick would hammer the recorder.
const REMINT_COOLDOWN_MS = 8_000;
// …and it must OVERSHOOT, not aim at where the wall is now.
//
// Minting is not instant: a slot, a request, a fetch, a first keyframe. Ask for
// the instant the wall is at and, by the time a frame appears, the wall has moved
// on by exactly that latency — so the tile arrives already behind, is judged to
// be drifting, re-mints, and arrives behind again. That is a tile re-requesting a
// window every cooldown and playing about a second of each, which is precisely
// what the wall showed on the widest camera on it.
//
// So a catch-up mint asks for where the wall WILL BE. Overshooting is free: a
// tile whose footage starts after the wall already knows how to hold at its first
// frame and join when the wall arrives (the "ahead" branch below). Undershooting
// is the loop. The lead is measured rather than guessed — cameras and links
// differ, and one fixed number would be wrong for most of them.
const LEAD_MIN_MS = 1_500;
const LEAD_MAX_MS = 8_000;
// Skew at which the operator is told, rather than left to believe a wall shows
// one instant when it does not.
const SKEW_WARN_S = 1.5;
// The decoder ceiling. playbackRate does not skip work: at 8x a 1080p25 stream is
// 200fps of decode per tile, and Sync applies the rate to every visible tile at
// once. Above this the transport steps the clock instead (see PlayoutBar).
const RATE_MAX = 4;

// ── how much footage to ask for at a time ──────────────────────────────────
// The ceiling exists for two reasons. The starvation measured above — what a tile
// ASKS for is what it will try to download, at line rate, competing with every
// other tile — and the MEDIA TOKEN, which the node mints with `exp = iat + 300s`.
// A window longer than the token outlives its own authorisation, so any refetch
// the browser makes late in a long window (a reconnect, a range request) is
// answered with a 401 and the tile dies for no visible reason. Four minutes keeps
// every window comfortably inside the token it was minted with.
const CHUNK_MAX_MS = 240_000;
// …and a floor, so a tile parked near the right-hand edge of a tight timeline
// range still gets a usable window rather than three seconds of video.
const CHUNK_MIN_MS = 60_000;
// Windows are jittered by up to this much so that seven tiles opened together do
// not all reach the end of their footage in the same second and re-open at once.
const CHUNK_JITTER_MS = 45_000;
// A window this short is not footage, it is the tail end of a recorded span.
//
// The node answers from the span that CONTAINS the requested instant and clamps
// to that span's end, so asking for the instant a span ends returns a window of
// ~0.0003 seconds — observed exactly, on the tile that reached the end of its
// recording first. Chrome does not merely fail to play that: it blocks the
// response outright (ERR_BLOCKED_BY_ORB) and the tile shows "Playback failed" on
// a camera whose next recording is thirty seconds away.
const MIN_USEFUL_SEC = 1.5;
// So a thin answer is a cue to step PAST the boundary and ask again — bounded,
// because a long gap must end in "no footage here" rather than a walk.
const THIN_STEP_MS = 2_000;
const THIN_MAX = 5;
// Continuing into the next window starts a moment past the end of this one. The
// end instant itself belongs to the span that is finishing, which is what
// produced the degenerate window above.
const CONTINUE_EPS_MS = 1_000;

// Seconds of footage buffered ahead at which this tile stops being a load on the
// link and hands its connectGate slot to the next tile. Rule 2 above.
const READY_AHEAD_S = 6;
// …but never hold the wall up longer than this. A tile on a slow camera must not
// be able to stop every other tile from opening.
const GATE_MAX_HOLD_MS = 10_000;
// No bytes and no progress for this long means the stream really is not coming:
// try the node's transcode, then say so. This is measured from the LAST sign of
// life, not from the open — which is the difference between "slow" and "broken",
// and the difference the previous fixed 9s-from-open timer could not tell.
const NO_PROGRESS_MS = 14_000;

// Seconds of the served window, read off the URL the node minted
// (`?duration=`). The browser reports `Infinity` for the progressive fMP4 it
// serves, so this is the only reliable length.
function urlDurationSec(url) {
  if (!url) return 0;
  try {
    const u = new URL(url, window.location.origin);
    const d = Number(u.searchParams.get("duration"));
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

// How far ahead of the playhead this element already holds footage.
function bufferedAhead(v) {
  try {
    const b = v?.buffered;
    if (!b || !b.length) return 0;
    return Math.max(0, b.end(b.length - 1) - v.currentTime);
  } catch {
    return 0;
  }
}

// The furthest instant this element could seek to without fetching anything new.
function reachableEnd(v) {
  try {
    const sk = v?.seekable;
    const bf = v?.buffered;
    return Math.max(
      sk?.length ? sk.end(sk.length - 1) : 0,
      bf?.length ? bf.end(bf.length - 1) : 0,
    );
  } catch {
    return 0;
  }
}

function TilePlayback({
  camera,
  // The instant every tile in this playback anchors at, and a sequence that
  // makes a repeat seek to the same instant a real event.
  anchorMs,
  anchorSeq,
  // End of the timeline's window — the far edge a session may run to, subject to
  // the chunk ceiling above.
  windowToMs,
  playing,
  speed = 1,
  // The master publishes the shared clock; followers subscribe to it.
  master = false,
  clock,
  muted = true,
  compact = false, // dense grid tile: smaller type in the status overlays
  // The master calls this when it finds NO footage at all, so the wall can skip
  // the gap instead of sitting on a still frame with a clock that has stopped.
  onReachedEnd,
}: any) {
  const videoRef = useRef<any>(null);
  const [session, setSession] = useState<any>(null); // { url, transcodeUrl, startMs, durationSec }
  const [transcoded, setTranscoded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [noFootage, setNoFootage] = useState(false);
  const [failed, setFailed] = useState(false);
  // Playing, but the bytes ran out — the link is busy, not broken. A spinner over
  // the last frame is the honest picture of that, and it is what an operator
  // expects to see; "Playback failed" is not.
  const [buffering, setBuffering] = useState(false);
  // The shared clock has not reached this camera's footage yet: its recording
  // starts LATER than the instant the wall is at. Holding is the honest answer —
  // see the follower effect.
  const [waiting, setWaiting] = useState(false);

  const federated = !!camera?.federated;
  const nodeId = camera?.node_id;
  const realId = camera?.real_id;

  // ── refs the long-lived listeners read ───────────────────────────────────
  // Everything here is read from a listener (the clock subscription, the progress
  // watchdog) that must NOT be torn down and rebuilt every time one of these
  // changes — rebuilding them mid-stream is itself a source of churn.
  const sessionRef = useRef<any>(null);
  sessionRef.current = session;
  const loadingRef = useRef(true);
  loadingRef.current = loading;
  const transcodedRef = useRef(false);
  transcodedRef.current = transcoded;
  const masterRef = useRef(master);
  masterRef.current = master;
  const onReachedEndRef = useRef<any>(onReachedEnd);
  onReachedEndRef.current = onReachedEnd;
  const lastRemintRef = useRef(0);
  // The window's far edge is read through a ref, NOT captured in `openAt`'s deps.
  // It changes whenever the operator re-frames the timeline (the range ladder,
  // paging), and a dep on it would re-mint every tile on the wall — reloading
  // video that is playing perfectly well — for a change that only affects where
  // the NEXT session may run to.
  const windowToRef = useRef(windowToMs);
  windowToRef.current = windowToMs;
  // Read inside the clock subscription, which must not re-subscribe on a
  // play/pause toggle.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // Corrections are suppressed until this instant after every open.
  const settleUntilRef = useRef(0);
  // Consecutive follower ticks that wanted a hard correction (see HARD_TICKS).
  const hardTicksRef = useRef(0);
  // An open is in flight: the follower must not "helpfully" start another.
  const openingRef = useRef(false);
  // Monotonic id of the newest open. A slower earlier request that lands after a
  // newer one must not overwrite it — two opens racing is how a tile ends up
  // playing a window the wall left thirty seconds ago, drifting, and correcting
  // itself into a blink.
  const mintRef = useRef(0);
  // How far this tile is from the wall, when that is worth saying out loud.
  const [skew, setSkew] = useState(0);
  const skewShownAtRef = useRef(0);
  // How long an open actually takes on this camera, as an EMA — the lead a
  // catch-up mint has to allow for. Seeded optimistically, corrected by
  // measurement on every first frame.
  const openStartedRef = useRef(0);
  const openLatencyRef = useRef(2_500);
  const leadMs = () => Math.min(LEAD_MAX_MS, Math.max(LEAD_MIN_MS, openLatencyRef.current));
  // Consecutive degenerate windows while stepping over a span boundary.
  const thinRef = useRef(0);
  // openAt calls itself when it steps over a boundary; through a ref so the
  // callback never has to reference its own binding.
  const openAtRef = useRef<any>(null);
  // The last sign of life from the stream, for the progress watchdog.
  const lastProgressRef = useRef(0);
  const markProgress = useCallback(() => {
    lastProgressRef.current = Date.now();
  }, []);

  const src = transcoded && session?.transcodeUrl ? session.transcodeUrl : session?.url;

  // ── holding the picture across a re-anchor ───────────────────────────────
  // Pointing a <video> at a new URL blanks it while the new stream is fetched and
  // its first keyframe decoded — a black flash. There used to be a `key={src}` on
  // the element as well, which threw the whole element away and made that flash
  // worse; the recorder console hit exactly this and calls it out ("remounting
  // tore the picture to black on every seek… that read as a blinking video").
  //
  // The element now survives, and the LAST FRAME is painted into a canvas over it
  // until the new stream has data. The operator sees the picture hold for a beat
  // instead of going black.
  const freezeRef = useRef<any>(null);
  const [frozen, setFrozen] = useState(false);
  const freeze = useCallback(() => {
    const v = videoRef.current;
    const c = freezeRef.current;
    if (!v || !c || !v.videoWidth) return;
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      setFrozen(true);
    } catch {
      /* a tainted or not-yet-decodable frame — just skip the hold */
    }
  }, []);

  // ── the connectGate slot ─────────────────────────────────────────────────
  // Exactly one slot per tile, released exactly once. The previous version
  // tracked this with a boolean set AFTER the await, so two opens racing each
  // took a slot and only one was ever given back — the gate leaked until no tile
  // on the page could open anything, which from the outside looks like tiles that
  // simply never load. The claim is now made SYNCHRONOUSLY, before the await.
  const gateRef = useRef<any>(null); // null | Promise (pending) | "held"
  const gateTimerRef = useRef<any>(null);
  const dropGate = useCallback(() => {
    const g = gateRef.current;
    clearTimeout(gateTimerRef.current);
    gateTimerRef.current = null;
    if (!g) return;
    gateRef.current = null;
    // A slot that has not been granted yet cannot be given back yet — hand it
    // straight on the moment it arrives.
    if (g === "held") releaseSlot();
    else Promise.resolve(g).then(() => releaseSlot());
  }, []);
  const takeGate = useCallback(async () => {
    if (gateRef.current) return; // already held, or being taken
    const p = acquireSlot();
    gateRef.current = p;
    await p;
    if (gateRef.current !== p) return; // dropped while we waited
    gateRef.current = "held";
    // The backstop: a tile that never becomes comfortable must not hold the wall.
    gateTimerRef.current = setTimeout(dropGate, GATE_MAX_HOLD_MS);
  }, [dropGate]);
  useEffect(() => dropGate, [dropGate]);

  // ── the progress watchdog ────────────────────────────────────────────────
  // Rule 3. This replaces a fixed timer started at open, which on a busy wall
  // fired on tiles that were downloading perfectly well, only slowly — and
  // painted "Playback failed" over footage that was two seconds from appearing.
  useEffect(() => {
    if (!src) return undefined;
    markProgress();
    const id = setInterval(() => {
      if (!loadingRef.current) return; // already showing a picture
      if (Date.now() - lastProgressRef.current < NO_PROGRESS_MS) return;
      // Truly nothing. An H.265 stream Chromium cannot decode often fails by
      // simply never producing data rather than by raising an error, so the
      // node's transcode is worth one try before giving up visibly.
      if (sessionRef.current?.transcodeUrl && !transcodedRef.current) {
        setTranscoded(true);
        markProgress();
        return;
      }
      // Drop the session too, so a follower takes the 'nothing open' path and
      // rejoins the wall on its own. A tile that gives up must not need a human
      // to press Retry before it will try again.
      setSession(null);
      setFailed(true);
      setLoading(false);
      setFrozen(false);
      dropGate();
    }, 2_000);
    return () => clearInterval(id);
  }, [src, dropGate, markProgress]);

  // ── mint a window at an instant ──────────────────────────────────────────
  const openAt = useCallback(
    async (atMs) => {
      if (!federated || !nodeId || !realId || atMs == null) return;
      const mint = (mintRef.current += 1);
      openingRef.current = true;
      openStartedRef.current = Date.now();
      settleUntilRef.current = Date.now() + SETTLE_MS;
      hardTicksRef.current = 0;
      setLoading(true);
      setSkew(0);
      setNoFootage(false);
      setFailed(false);
      setWaiting(false);
      setBuffering(false);
      setTranscoded(false);
      freeze();
      markProgress();
      // Hold a connectGate slot while this window opens. Sync asks every tile on
      // the wall for footage at the same instant, and the link cannot serve them
      // all at once (see the header) — so they open a few at a time.
      await takeGate();
      if (mint !== mintRef.current) return; // a newer open supersedes this one
      try {
        // Bounded: never more than CHUNK_MAX_MS, never less than CHUNK_MIN_MS,
        // and jittered so a wall opened together does not run out together.
        const jitter = Math.floor(Math.random() * CHUNK_JITTER_MS);
        const far = Math.min(windowToRef.current ?? 0, atMs + CHUNK_MAX_MS);
        const to = Math.max(atMs + CHUNK_MIN_MS, far) + jitter;
        const s = await vms.federation.playback(nodeId, realId, {
          from: new Date(atMs).toISOString(),
          to: new Date(to).toISOString(),
        });
        if (mint !== mintRef.current) return;
        const url = s?.playback_url || "";
        if (!url) {
          openingRef.current = false;
          setSession(null);
          setNoFootage(true);
          setLoading(false);
          dropGate();
          // The master finding nothing means the WALL is in a gap. A follower
          // just waits — the wall is still somewhere, and it will be told.
          if (masterRef.current) onReachedEndRef.current?.(to);
          return;
        }
        // `start` is the node's clamp-forward answer and the video's true t=0 —
        // treating our own request as t=0 is the off-by-(start − from) drift the
        // node's own contract warns about, and on a synced wall it would show as
        // tiles that are minutes apart.
        const startMs = s.start ? new Date(s.start).getTime() : atMs;
        const durationSec = urlDurationSec(url) || (to - startMs) / 1000;

        // Landed on the last instant of a span — step past the boundary and ask
        // again rather than handing the element a window with no frames in it.
        if (durationSec < MIN_USEFUL_SEC) {
          thinRef.current += 1;
          if (thinRef.current <= THIN_MAX) {
            openAtRef.current?.(startMs + THIN_STEP_MS);
            return;
          }
          thinRef.current = 0;
          openingRef.current = false;
          setSession(null);
          setNoFootage(true);
          setLoading(false);
          dropGate();
          if (masterRef.current) onReachedEndRef.current?.(to);
          return;
        }

        thinRef.current = 0;
        openingRef.current = false;
        markProgress();
        setSession({
          url,
          transcodeUrl: s.playback_transcode_url || null,
          codec: s.codec || null,
          startMs,
          durationSec: Math.max(1, durationSec),
        });
      } catch {
        if (mint !== mintRef.current) return;
        openingRef.current = false;
        setSession(null);
        setFailed(true);
        setLoading(false);
        dropGate();
      }
      // NOTE: on success the slot is NOT freed here. A minted URL is not a
      // playing stream — the download is only beginning — so the slot is held
      // until this tile is comfortable (READY_AHEAD_S buffered) or the backstop
      // fires. `loading` stays true for the same reason: the tile is not open
      // until it shows a picture.
    },
    [federated, nodeId, realId, freeze, takeGate, dropGate, markProgress],
  );
  openAtRef.current = openAt;

  // Re-anchor whenever the wall seeks (anchorSeq), or the camera changes.
  useEffect(() => {
    openAt(anchorMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorSeq, camera?.id, openAt]);

  // Mirror the wall's play/pause and speed onto this element. playbackRate is
  // reset by the element on every load, so it is re-applied on loadeddata too.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [playing, src]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const rate = Math.min(speed, RATE_MAX);
    const apply = () => {
      if (v.playbackRate !== rate) v.playbackRate = rate;
    };
    apply();
    v.addEventListener("loadeddata", apply);
    return () => v.removeEventListener("loadeddata", apply);
  }, [speed, src]);

  // ── master: publish the clock ────────────────────────────────────────────
  useEffect(() => {
    if (!master || !clock) return undefined;
    const v = videoRef.current;
    if (!v || !session) return undefined;
    const onTime = () => clock.set(session.startMs + v.currentTime * 1000);
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [master, clock, session, src]);

  // ── follower: keep step with the master ──────────────────────────────────
  //
  // Cameras on one wall do not record the same minutes. Ask three of them for
  // 12:06 and a continuous one answers at 12:06, while a motion-recorded one has
  // nothing until 12:11 — the node clamps FORWARD and hands back a session that
  // begins there. So a follower's own start is routinely LATER than the instant
  // the wall is at, and `target` is negative for a while by design.
  //
  // Reading that as drift and re-minting is what broke Sync: the tile asked for
  // 12:06, got 12:11 back, computed a negative target, re-minted at 12:06, got
  // 12:11 again — a loop that never played a frame. The cases are genuinely
  // different and get genuinely different answers:
  //
  //   ahead   (clock before our footage) → HOLD. Pause at the first frame and say
  //                                        so; resume when the wall reaches us.
  //   in step (or nearly)                → nudge the RATE, never seek.
  //   behind, inside what we hold        → one seek, after HARD_TICKS agree.
  //   behind, outside it                 → re-mint there, rate-limited.
  useEffect(() => {
    if (master || !clock) return undefined;
    return clock.subscribe((ms) => {
      const v = videoRef.current;
      if (ms == null || !v) return;
      const s = sessionRef.current;

      // Nothing open at all (a gap, a failure). Rejoin the wall where it is —
      // but never while an open is already in flight, which is how a tile ends
      // up with two windows racing.
      if (!s) {
        if (openingRef.current) return;
        const now = Date.now();
        if (now - lastRemintRef.current < REMINT_COOLDOWN_MS) return;
        lastRemintRef.current = now;
        openAt(ms + leadMs());
        return;
      }
      // Freshly opened: it is loading, not drifting. Leave it alone.
      if (Date.now() < settleUntilRef.current) return;

      const target = (ms - s.startMs) / 1000;

      // Our footage has not started yet at the wall's instant.
      if (target < -AHEAD_S) {
        setWaiting(true);
        if (!v.paused) v.pause();
        if (v.currentTime > 0.1) v.currentTime = 0;
        return;
      }
      setWaiting(false);
      if (playingRef.current && v.paused) v.play().catch(() => {});

      const base = Math.min(speedRef.current, RATE_MAX);
      const drift = target - v.currentTime; // + = we are behind the wall

      // Say so when this tile is not where the wall is. A silently desynced wall
      // is the one failure an operator cannot see and must never be left to
      // assume away: every tile carries a PLAYBACK badge asserting it is at this
      // instant, and that has to be true or visibly qualified.
      //
      // Written to state at most once a second, and only when the whole-second
      // reading changes — the clock ticks 4+ times a second and a tile that
      // re-rendered on every one of them would cost more than the badge is worth.
      const nowMs = Date.now();
      if (nowMs - skewShownAtRef.current > 1_000) {
        skewShownAtRef.current = nowMs;
        const shown = Math.abs(drift) >= SKEW_WARN_S ? Math.round(drift) : 0;
        setSkew((prev) => (prev === shown ? prev : shown));
      }

      // In step — hold the plain rate.
      if (Math.abs(drift) <= DRIFT_S) {
        hardTicksRef.current = 0;
        if (v.playbackRate !== base) v.playbackRate = base;
        return;
      }

      // Off by a little — absorb it with the RATE, not with a seek. This is the
      // whole point: nothing about the decode pipeline is disturbed, the picture
      // never blanks, and the tile slides back into step over a couple of
      // seconds.
      if (Math.abs(drift) <= RESYNC_S) {
        hardTicksRef.current = 0;
        const want = drift > 0 ? base * (1 + NUDGE) : base * (1 - NUDGE);
        if (Math.abs(v.playbackRate - want) > 0.001) v.playbackRate = want;
        return;
      }

      // A big gap. Wait for a few ticks to agree before acting: the clock jumps
      // whenever the master opens its next window, and one such reading must not
      // seek the whole wall.
      hardTicksRef.current += 1;
      if (hardTicksRef.current < HARD_TICKS) return;
      hardTicksRef.current = 0;

      if (v.playbackRate !== base) v.playbackRate = base;
      // A currentTime write past what the element holds does not land, and
      // asking again every tick is the other half of the blinking.
      if (target >= 0 && target <= reachableEnd(v)) {
        v.currentTime = target;
        return;
      }

      // Outside it entirely: the wall has moved somewhere this session does not
      // contain. Fetch it — rate-limited, because a wall of tiles doing this at
      // once is a stampede at the recorder.
      const now = Date.now();
      if (now - lastRemintRef.current < REMINT_COOLDOWN_MS) return;
      lastRemintRef.current = now;
      openAt(ms + leadMs());
    });
  }, [master, clock, openAt]);

  // Non-federated cameras record on the VMS, not on a node, and that path is not
  // wired here yet. Say so instead of showing a dead black cell.
  if (!federated) {
    return (
      <Placeholder icon="heroicons-outline:film" label="Recorder playback only" compact={compact} />
    );
  }

  return (
    <div className="absolute inset-0 bg-black">
      {src && (
        /* eslint-disable-next-line jsx-a11y/media-has-caption */
        <video
          ref={videoRef}
          src={src}
          autoPlay={playing}
          playsInline
          muted={muted}
          preload="auto"
          className="h-full w-full bg-black object-contain"
          onLoadedMetadata={() => {
            const v = videoRef.current;
            // No video track decoded = a codec this browser cannot play (H.265),
            // whatever the node's codec column claims. The node returns a
            // transcoded URL precisely so this can be recovered by observation.
            if (v && !v.videoWidth && session?.transcodeUrl && !transcoded) setTranscoded(true);
          }}
          onProgress={() => {
            markProgress();
            // Comfortable — stop being a load on the link and let the next tile
            // on the wall open. Rule 2.
            if (bufferedAhead(videoRef.current) >= READY_AHEAD_S) dropGate();
          }}
          onTimeUpdate={markProgress}
          onCanPlayThrough={dropGate}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => {
            setBuffering(false);
            markProgress();
          }}
          onLoadedData={() => {
            setLoading(false);
            setFrozen(false);
            markProgress();
            // What this open actually cost, folded into the lead a catch-up mint
            // will allow for.
            const dt = Date.now() - openStartedRef.current;
            if (dt > 0 && dt < 30_000) {
              openLatencyRef.current = Math.round(openLatencyRef.current * 0.6 + dt * 0.4);
            }
          }}
          onEnded={() => {
            // This window is finished — continue into the next one IN THIS TILE.
            // The wall is not re-anchored for it: the node clamps forward, so
            // each tile crosses its own gaps, and one camera's short recording no
            // longer drags every other tile through a re-open.
            const s = sessionRef.current;
            if (s) openAt(s.startMs + s.durationSec * 1000 + CONTINUE_EPS_MS);
          }}
          onError={() => {
            if (session?.transcodeUrl && !transcoded) setTranscoded(true);
            else {
              setFailed(true);
              setLoading(false);
              setFrozen(false);
              dropGate();
            }
          }}
        />
      )}

      {/* The held frame. `hidden` rather than unmounted so the canvas keeps its
          bitmap between swaps. */}
      <canvas
        ref={freezeRef}
        className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${frozen ? "" : "hidden"}`}
      />

      {loading && !noFootage && !failed && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-white/60">
          <Icon icon="svg-spinners:180-ring" className={compact ? "text-lg" : "text-2xl"} />
          {!compact && <p className="font-mono text-[10px] tracking-[.6px]">opening footage…</p>}
        </div>
      )}
      {/* Rebuffering: the picture stays, a spinner says why it is not moving. */}
      {buffering && !loading && !failed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Icon
            icon="svg-spinners:180-ring"
            className={`${compact ? "text-base" : "text-xl"} text-white/50`}
          />
        </div>
      )}
      {/* Out of step with the wall, and saying so. */}
      {!!skew && !loading && !failed && !noFootage && !waiting && (
        <div className="pointer-events-none absolute left-1/2 top-1.5 z-[5] -translate-x-1/2 rounded-[6px] border border-[rgba(251,191,36,.45)] bg-[rgba(20,14,0,.72)] px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[.5px] text-[#fbbf24]">
          OUT OF SYNC {skew > 0 ? "\u2212" : "+"}
          {Math.abs(skew)}s
        </div>
      )}
      {waiting && !noFootage && !failed && (
        <Placeholder
          icon="heroicons-outline:clock"
          label="Recording starts later — holding"
          compact={compact}
        />
      )}
      {noFootage && (
        <Placeholder icon="heroicons-outline:film" label="No footage at this time" compact={compact} />
      )}
      {failed && (
        <Placeholder
          icon="heroicons-outline:exclamation-triangle"
          label="Playback failed"
          compact={compact}
          danger
          onRetry={() => openAt(anchorMs)}
        />
      )}
    </div>
  );
}

function Placeholder({ icon, label, compact, danger = false, onRetry }: any) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[#05070f] px-3 text-center">
      <Icon icon={icon} className={`${danger ? "text-[#f87171]/70" : "text-white/25"} ${compact ? "text-lg" : "text-2xl"}`} />
      <p className={`font-mono ${compact ? "text-[9px]" : "text-[10px]"} leading-tight ${danger ? "text-[#f87171]/80" : "text-white/35"}`}>
        {label}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="mt-1 inline-flex items-center gap-1 rounded-[7px] border border-white/15 px-2 py-0.5 text-[10px] font-medium text-white/60 transition hover:border-[#22d3ee] hover:text-[#67e8f9]"
        >
          <Icon icon="heroicons-outline:arrow-path" className="text-[11px]" />
          Retry
        </button>
      )}
    </div>
  );
}

// Memoised for the same reason LivePlayer is: on a full wall every tile mounts
// one of these, and an unrelated shell render must not restart a decoder.
export default memo(TilePlayback);
