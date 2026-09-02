"use client";

// PlayoutBar — the wall-level DVR transport. A 24h timeline of the focused
// camera's REAL recorded coverage (from the node's segment index via
// /vms/federation/.../timeline) with transport controls, and a playback theatre
// that plays the recorded window the node mints for a chosen instant.
//
// Data is real — recorded ranges come straight from the recorder's Postgres
// segment index; an empty track means the node genuinely has no footage in the
// window (not a stub). Local (non-federated) cameras aren't wired here yet.
//
// ── Why the theatre is PORTALLED ─────────────────────────────────────────────
// It used to be a `fixed inset-0` div nested inside this dock. That does not
// centre on the viewport: `backdrop-filter` (this bar has `backdrop-blur`) makes
// an element the containing block for fixed-position descendants, so "the
// viewport" became the ~90px dock and the player rendered pinned to the bottom of
// the screen with most of it cut off. Rendering through a portal to <body> takes
// it out of that containing block for good — and keeps it out if anyone adds a
// transform/filter/backdrop anywhere up this tree later.
//
// ── Why the transport is OURS and not `<video controls>` ─────────────────────
// The node serves a progressive fMP4 window: the browser never resolves a
// `duration` for it, so the native scrubber shows no time, has no end to scrub
// toward, and cannot be dragged. But the window's real bounds ARE known — the
// session returns `start` (the true t=0, clamped forward to where coverage
// begins) and the playback URL carries `duration` — so we drive a seek bar over
// [start, start+duration] in ABSOLUTE wall-clock time, which is the only timeline
// an operator cares about. Seeks inside what the browser holds are a plain
// currentTime write; anything beyond re-mints the session at that instant, which
// is what the node's clamp-to-coverage contract is for.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { vms } from "../api";

// Colour per recording trigger (mockup palette).
const TRIGGER_COLOR = {
  continuous: "#34d399",
  motion: "#fbbf24",
  schedule: "#60a5fa",
  manual: "#a78bfa",
};

const DAY_MS = 86_400_000;
const SPEEDS = [0.5, 1, 2, 4];
const SKIP_SEC = 10;

function Btn({ icon, title, onClick, active = false, disabled = false }: any) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border transition ${
        active
          ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
          : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee] disabled:cursor-not-allowed disabled:opacity-40"
      }`}
    >
      <Icon icon={icon} className="text-base" />
    </button>
  );
}

// ── time helpers ────────────────────────────────────────────────────────────
// The track is one LOCAL day, so every conversion goes through local midnight.
const dayStartMs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const clockOf = (ms) =>
  ms == null ? "--:--:--" : new Date(ms).toLocaleTimeString(undefined, { hour12: false });

// Seconds-from-midnight for an ISO instant, in LOCAL time.
function daySeconds(iso) {
  const d = new Date(iso);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// The served window's length, read off the playback URL the node minted
// (`?duration=<seconds>` — see mediamtx.GetURL / playbackTranscodeURL). This is
// the ONLY reliable length: the browser reports `duration: Infinity` for the
// progressive fMP4 the node streams.
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

// ── scrub plumbing ──────────────────────────────────────────────────────────
// One drag model for both tracks: press anywhere to grab the playhead, drag to
// aim (the bar shows the target the whole time), release to commit ONE seek.
// Committing on release rather than on every move is what keeps a drag across a
// 24h track from minting a playback session per pixel.
//
// Pointer capture is what makes the drag survive leaving the 4px-tall bar — the
// mouse WILL leave it, and without capture the gesture died there, which is most
// of why the old track felt like it "doesn't drag".
function useScrub(onCommit) {
  const ref = useRef<any>(null);
  const [drag, setDrag] = useState<any>(null); // fraction while dragging
  const [hover, setHover] = useState<any>(null); // fraction under the cursor

  const fracFrom = (e) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  // Pin the page's cursor for the length of a drag. Pointer capture keeps the
  // EVENTS on this bar but not the cursor: the moment the mouse leaves the track
  // mid-drag — and on a 6px-tall bar it will — the cursor becomes whatever is
  // underneath (an I-beam over the readout, an arrow over the video), which reads
  // as the drag having been dropped while it is in fact still live.
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return undefined;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragging]);

  const handlers = {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrag(fracFrom(e));
    },
    onPointerMove: (e) => {
      const f = fracFrom(e);
      setHover(f);
      setDrag((d) => (d == null ? d : f));
    },
    onPointerUp: (e) => {
      if (drag == null) return;
      const f = fracFrom(e);
      setDrag(null);
      onCommit(f);
    },
    onPointerCancel: () => setDrag(null),
    onPointerLeave: () => setHover(null),
  };

  return { ref, drag, hover, handlers };
}

export default function PlayoutBar({ camera, onClose }: any) {
  const [nowFrac, setNowFrac] = useState(0);
  const [session, setSession] = useState<any>(null); // the media currently loaded
  // The theatre's TIMELINE, which is deliberately NOT the same thing as the media
  // above. See `playFrom`.
  const [view, setView] = useState<any>(null); // { fromMs, toMs }
  const [minting, setMinting] = useState(false);
  const [noFootage, setNoFootage] = useState(false);

  const federated = !!camera?.federated;
  const nodeId = camera?.node_id;
  const realId = camera?.real_id;

  // Today's window (local midnight → next midnight) as RFC3339 for the node.
  const day0 = useMemo(() => dayStartMs(), []);
  const win = useMemo(
    () => ({ from: new Date(day0).toISOString(), to: new Date(day0 + DAY_MS).toISOString() }),
    [day0],
  );

  // Playhead at the current time-of-day. Updates each minute; browser-only.
  useEffect(() => {
    const tick = () => setNowFrac((Date.now() - dayStartMs()) / DAY_MS);
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const tlQ = useQuery<any>({
    queryKey: ["fed-timeline", nodeId, realId, win.from],
    queryFn: () => vms.federation.timeline(nodeId, realId, { from: win.from, to: win.to }),
    enabled: federated && !!nodeId && !!realId,
    refetchInterval: 60_000,
  });
  const ranges = tlQ.data?.ranges || [];

  // Recorded spans as epoch ms, in time order — the basis for prev/next-span
  // stepping and for snapping a click that lands in a gap.
  const spans = useMemo(
    () =>
      [...ranges]
        .map((r: any) => {
          const start = new Date(r.start).getTime();
          return { start, end: start + (r.duration || 0) * 1000, trigger: r.trigger_type };
        })
        .filter((r) => Number.isFinite(r.start))
        .sort((a, b) => a.start - b.start),
    [ranges],
  );

  // The recorded span an instant belongs to — the one containing it, else the next
  // one forward (a click in a gap means "the next footage after here").
  const spanAt = useCallback(
    (ms) => spans.find((sp) => ms >= sp.start && ms <= sp.end) || spans.find((sp) => sp.start >= ms) || null,
    [spans],
  );

  const hours = useMemo(() => Array.from({ length: 25 }, (_, i) => i), []);

  // Switching the focused camera drops the session — the window belonged to the
  // camera we were looking at, and its media token is scoped to that camera.
  useEffect(() => {
    setSession(null);
    setView(null);
    setNoFootage(false);
  }, [camera?.id]);

  // ── mint a recorded window at an instant ─────────────────────────────────
  // `start` is the node's clamp-forward answer (often later than we asked, when
  // the ask landed in a gap), and it is the video's true t=0 — treating our own
  // request as t=0 is exactly the off-by-(start − from) drift the node's contract
  // warns about.
  //
  // ── The MEDIA is not the TIMELINE ────────────────────────────────────────
  // The node serves [requested → end of that coverage span], so every seek makes
  // the served window SHORTER. If the seek bar's domain were that window — as it
  // was — then seeking to 11:10:03 inside 11:05:34–11:12:32 rebuilt the bar as
  // 11:10:03–11:12:32 and 11:09:58 became unreachable without closing playback and
  // starting over from the 24h track. No DVR behaves that way, and it is a real
  // loss: an operator scrubbing an incident lands past it and cannot step back.
  //
  // So the timeline is pinned to the recorded SPAN the playhead is in and stays
  // put while the media underneath is re-minted freely. `keepView` is how a seek
  // from inside the theatre says "same timeline, new media"; an entry from the
  // 24h track, prev/next-span, or auto-advance leaves it false and re-frames the
  // timeline on whichever span it lands in.
  const playFrom = useCallback(
    async (atMs, { keepView = false }: any = {}) => {
      if (!federated) return;
      setMinting(true);
      setNoFootage(false);
      try {
        const s = await vms.federation.playback(nodeId, realId, {
          from: new Date(atMs).toISOString(),
          to: win.to,
        });
        const url = s?.playback_url || "";
        if (!url) {
          setSession(null);
          setNoFootage(true);
          return;
        }
        const startMs = s.start ? new Date(s.start).getTime() : atMs;
        if (!keepView) {
          // Frame the timeline on the span we actually landed in. With no timeline
          // data (the coverage query failed, or the node has footage it did not
          // report) fall back to the served window, which is still correct — just
          // not as generous.
          const sp = spanAt(startMs);
          setView(
            sp && sp.end > sp.start
              ? { fromMs: sp.start, toMs: sp.end }
              : {
                  fromMs: startMs,
                  toMs: startMs + Math.max(1, urlDurationSec(url)) * 1000,
                },
          );
        }
        setSession({
          url,
          // The node returns this WHATEVER the stored codec says, so a camera whose
          // codec column lies (it documents that some do) can still be recovered by
          // OBSERVATION — see the theatre's no-picture fallback.
          transcodeUrl: s.playback_transcode_url || null,
          codec: s.codec || null,
          startMs,
          // Never 0: everything downstream divides by it. The URL's own duration
          // is the truth; the day's remainder is the belt-and-braces fallback.
          durationSec: Math.max(1, urlDurationSec(url) || (day0 + DAY_MS - startMs) / 1000),
        });
      } catch {
        // Node unreachable — the track stays; no fake playback.
        setSession(null);
      } finally {
        setMinting(false);
      }
    },
    [federated, nodeId, realId, win.to, day0, spanAt],
  );

  // Click / drag the 24h track → play from there. A landing in a gap snaps
  // FORWARD to the next recorded span, so a rough drag still lands on footage
  // instead of silently doing nothing.
  const seekDay = useCallback(
    (frac) => {
      if (!federated) return;
      const at = day0 + frac * DAY_MS;
      const inSpan = spans.some((s) => at >= s.start && at <= s.end);
      const next = spans.find((s) => s.start >= at);
      playFrom(inSpan ? at : next ? next.start : at);
    },
    [federated, day0, spans, playFrom],
  );

  const dayScrub = useScrub(seekDay);

  // Where the playhead sits on the 24h track: the playback position while a
  // window is up, otherwise the wall clock.
  const [playClock, setPlayClock] = useState<any>(null);
  const headFrac =
    dayScrub.drag != null
      ? dayScrub.drag
      : playClock != null
        ? (playClock - day0) / DAY_MS
        : nowFrac;

  // Step to the previous / next recorded span relative to where we are.
  const stepSpan = (dir) => {
    if (spans.length === 0) return;
    const at = playClock ?? day0 + nowFrac * DAY_MS;
    const target =
      dir < 0
        ? [...spans].reverse().find((s) => s.start < at - 1_000)
        : spans.find((s) => s.start > at + 1_000);
    if (target) playFrom(target.start);
  };

  const goLive = () => {
    setSession(null);
    setView(null);
    setPlayClock(null);
    setNoFootage(false);
  };

  const live = !session;
  const trackTime = dayScrub.drag ?? dayScrub.hover;

  return (
    <div className="shrink-0 border-t border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.82)] px-3 py-2 backdrop-blur-xs">
      {/* Transport row */}
      <div className="flex items-center gap-2">
        <Btn
          icon="heroicons-solid:backward"
          title="Previous recorded span"
          disabled={!federated || spans.length === 0}
          onClick={() => stepSpan(-1)}
        />
        <Btn
          icon="heroicons-solid:play"
          title="Play earliest recording today"
          disabled={!federated || spans.length === 0}
          onClick={() => spans.length > 0 && playFrom(spans[0].start)}
        />
        <Btn
          icon="heroicons-solid:forward"
          title="Next recorded span"
          disabled={!federated || spans.length === 0}
          onClick={() => stepSpan(1)}
        />

        {/* LIVE ⇄ PLAYBACK. In playback this is the way back to live, which is
            the one control an operator reaches for first after scrubbing. */}
        {live ? (
          <span className="ml-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.14)] px-2.5 py-1.5 text-[11px] font-semibold tracking-[.6px] text-[#f87171]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#f87171]" />
            LIVE
          </span>
        ) : (
          <button
            type="button"
            onClick={goLive}
            title="Back to live"
            className="ml-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.14)] px-2.5 py-1.5 text-[11px] font-semibold tracking-[.6px] text-[#67e8f9] transition hover:border-[#22d3ee]"
          >
            <Icon icon="heroicons-outline:arrow-uturn-left" className="text-xs" />
            GO LIVE
          </button>
        )}

        <div className="mx-1 h-6 w-px bg-[rgba(150,180,245,.22)]" />

        {/* The time under the pointer while scrubbing, else the playhead's own
            time. A DVR bar with no clock on it is the complaint; this is the
            answer to it, in the same monospace the rest of the wall uses. */}
        <span className="inline-flex min-w-[92px] items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2 py-1 font-mono text-[12px] tabular-nums text-[#d7f7e9]">
          <Icon icon="heroicons-outline:clock" className="text-xs text-[#7e93bf]" />
          {clockOf(
            trackTime != null ? day0 + trackTime * DAY_MS : (playClock ?? Date.now()),
          )}
        </span>

        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#aec2e8]">
          {camera ? (
            <>
              <Icon icon="heroicons-solid:video-camera" className="mr-1 inline text-sm text-[#22d3ee]" />
              {camera.name}
              {camera.node_name && <span className="ml-1.5 text-[#7e93bf]">· {camera.node_name}</span>}
              {federated && (
                <span className="ml-2 text-[#7e93bf]">
                  {tlQ.isLoading ? "loading…" : `${spans.length} recorded span${spans.length === 1 ? "" : "s"} today`}
                </span>
              )}
            </>
          ) : (
            <span className="text-[#7e93bf]">Select a camera on the wall to scrub its recordings</span>
          )}
        </span>

        {minting && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[#7e93bf]">
            <Icon icon="svg-spinners:180-ring" className="text-xs" />
            opening…
          </span>
        )}
        {noFootage && (
          <span className="font-mono text-[10px] text-[#f87171]">No footage at that time</span>
        )}

        <button
          type="button"
          onClick={onClose}
          title="Hide transport"
          className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[rgba(248,113,113,.5)] hover:text-[#f87171]"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-base" />
        </button>
      </div>

      {/* 24h timeline — press, drag, release to seek. `touch-none` so a stylus /
          touch drag scrubs instead of panning the page away under the gesture.
          The cursor is a plain POINTER, not `ew-resize`: a resize cursor promises
          you are about to change the bar's SIZE, which is what every window edge
          and column divider in the console uses it for. This bar is a control you
          click and drag along, the same as any other seek bar. */}
      <div
        ref={dayScrub.ref}
        {...dayScrub.handlers}
        className={`relative mt-2 h-9 touch-none select-none overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.15)] bg-[#0b1428] ${
          federated ? "cursor-pointer" : ""
        }`}
      >
        {/* Recorded coverage spans (REAL) */}
        {ranges.map((r, i) => {
          const left = (daySeconds(r.start) / 86400) * 100;
          const width = Math.max(0.15, ((r.duration || 0) / 86400) * 100);
          const color = TRIGGER_COLOR[r.trigger_type] || TRIGGER_COLOR.continuous;
          return (
            <div
              key={i}
              className="pointer-events-none absolute top-1/2 h-3 -translate-y-1/2 rounded-[2px]"
              style={{ left: `${left}%`, width: `${width}%`, background: color, opacity: 0.8 }}
            />
          );
        })}

        {/* Hour gridlines + labels */}
        {hours.map((h) => (
          <div
            key={h}
            className="pointer-events-none absolute top-0 h-full border-l border-[rgba(150,180,245,.08)]"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            {h % 3 === 0 && h < 24 && (
              <span className="absolute left-1 top-0.5 font-mono text-[9px] text-[#7e93bf]">
                {String(h).padStart(2, "0")}
              </span>
            )}
          </div>
        ))}

        {/* Empty-state note (only when we KNOW there's no footage) */}
        {federated && !tlQ.isLoading && ranges.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[10px] tracking-[.6px] text-[#7e93bf]">
              No recorded footage today
            </span>
          </div>
        )}
        {!federated && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[10px] tracking-[.6px] text-[#7e93bf]">
              {camera ? "Recorder playback only" : "—"}
            </span>
          </div>
        )}

        {/* Time under the cursor — a tooltip that follows the pointer, so an
            operator can aim at 14:07 instead of at "about two-thirds along". */}
        {federated && trackTime != null && (
          <div
            className="pointer-events-none absolute top-0.5 z-10 -translate-x-1/2 rounded-[5px] border border-[rgba(150,180,245,.3)] bg-[rgba(8,15,34,.95)] px-1.5 py-px font-mono text-[10px] tabular-nums text-[#d7f7e9]"
            style={{ left: `${Math.min(97, Math.max(3, trackTime * 100))}%` }}
          >
            {clockOf(day0 + trackTime * DAY_MS)}
          </div>
        )}

        {/* Playhead — playback position when a window is up, else the wall clock.
            A fatter grab handle while dragging, so the gesture has a visible grip. */}
        <div
          className={`pointer-events-none absolute top-0 h-full ${
            dayScrub.drag != null ? "w-0.5 bg-[#67e8f9]" : "w-px bg-[#22d3ee]"
          } shadow-[0_0_6px_#22d3ee]`}
          style={{ left: `${Math.min(100, Math.max(0, headFrac * 100))}%` }}
        >
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#22d3ee]" />
        </div>
      </div>

      {/* Playback theatre — portalled to <body>; see the file header. */}
      {/* No `key` on the session: re-minting media must NOT remount the theatre,
          or the timeline, speed and play state would reset on every seek. */}
      {session && view && (
        <PlaybackTheatre
          camera={camera}
          session={session}
          view={view}
          spans={spans}
          onClock={setPlayClock}
          onPlayFrom={playFrom}
          onClose={goLive}
        />
      )}
    </div>
  );
}

// ── the theatre ─────────────────────────────────────────────────────────────
// A recorded window with a REAL transport over it, built on the distinction the
// dock's `playFrom` explains:
//
//   `view`    — the TIMELINE. The recorded span the operator is working inside.
//               Fixed: it survives every seek, so any instant in the span stays
//               one click away, including one BEFORE where playback currently is.
//   `session` — the MEDIA loaded right now: `startMs` (its true t=0, after the
//               node's clamp) and `durationSec` (its length). It is re-minted
//               under the timeline as needed and the operator never sees it.
//
// Absolute time = session.startMs + video.currentTime, and every readout, the
// playhead and the seek target are in that absolute wall clock — the only
// timeline anyone actually asks playback about.
function PlaybackTheatre({ camera, session, view, spans, onClock, onPlayFrom, onClose }: any) {
  const videoRef = useRef<any>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [pos, setPos] = useState(0); // seconds into the LOADED media
  const [buffered, setBuffered] = useState(0); // seconds of the media held
  const [transcoded, setTranscoded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(true); // media requested, no frame yet

  const { startMs, durationSec, transcodeUrl } = session;
  const src = transcoded && transcodeUrl ? transcodeUrl : session.url;

  // The timeline's domain, in absolute ms.
  const domFrom = view.fromMs;
  const domTo = view.toMs;
  const domSpan = Math.max(1, domTo - domFrom);

  // Where playback is, absolutely. Clamped into the timeline so a media window
  // that runs a moment past its span cannot push the playhead off the bar.
  const clockMs = Math.min(domTo, Math.max(domFrom, startMs + pos * 1000));

  // A fresh media window starts at ITS t=0. Without this reset the previous
  // window's `pos` is briefly added to the new window's `startMs` and the readout
  // shows a time that never existed, until the first timeupdate corrects it.
  useEffect(() => {
    setPos(0);
    setBuffered(0);
    setFailed(false);
    setTranscoded(false);
    setOpening(true);
  }, [session.url]);

  // Report the playhead upward so the 24h track shows where playback is.
  useEffect(() => {
    onClock?.(clockMs);
  }, [onClock, clockMs]);
  useEffect(() => () => onClock?.(null), [onClock]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, src]);

  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = speed;
    // No video track decoded = the recorded codec is one this browser has no
    // decoder for (H.265), whatever the node's codec column said. The node hands
    // us a transcoded URL for exactly this recovery-by-observation; take it once.
    if (!v.videoWidth && transcodeUrl && !transcoded) setTranscoded(true);
  };

  const onTime = () => {
    const v = videoRef.current;
    if (!v) return;
    setPos(v.currentTime);
    try {
      const b = v.buffered;
      if (b.length) setBuffered(b.end(b.length - 1));
    } catch {
      /* buffered can throw before the first append */
    }
  };

  // How far the browser can seek WITHOUT new media. A progressive fMP4 is
  // seekable only over what it holds, so anything past that has to be re-minted
  // at the target instant — which is also the cheaper answer for a long jump.
  const seekableEnd = () => {
    try {
      const sk = videoRef.current?.seekable;
      return sk?.length ? sk.end(sk.length - 1) : 0;
    } catch {
      return 0;
    }
  };

  // Seek to an ABSOLUTE instant inside the timeline. Inside the loaded media it
  // is a currentTime write (instant); outside it — earlier than this media
  // begins, or past what it holds — the media is re-minted there while the
  // timeline stays exactly where it is.
  const seekAt = useCallback(
    (ms) => {
      const target = Math.min(domTo, Math.max(domFrom, ms));
      const rel = (target - startMs) / 1000;
      const v = videoRef.current;
      if (v && rel >= 0 && rel <= Math.min(durationSec, seekableEnd())) {
        v.currentTime = rel;
        setPos(rel);
        if (playing) v.play().catch(() => {});
        return;
      }
      onPlayFrom?.(target, { keepView: true });
    },
    [domFrom, domTo, startMs, durationSec, playing, onPlayFrom],
  );

  const scrub = useScrub((frac) => seekAt(domFrom + frac * domSpan));
  const shownMs = scrub.drag != null ? domFrom + scrub.drag * domSpan : clockMs;
  const frac = (shownMs - domFrom) / domSpan;

  const skip = (sec) => seekAt(clockMs + sec * 1000);

  // Step to the neighbouring recorded span — the way OUT of this timeline, since
  // the dock's 24h track is behind the theatre while it is open.
  const hasPrev = spans.some((sp) => sp.end <= domFrom + 1_000);
  const hasNext = spans.some((sp) => sp.start >= domTo - 1_000);
  const step = (dir) => {
    if (!spans.length) return;
    const target =
      dir < 0
        ? [...spans].reverse().find((sp) => sp.end <= domFrom + 1_000)
        : spans.find((sp) => sp.start >= domTo - 1_000);
    if (target) onPlayFrom?.(target.start);
  };

  // Reaching the end of the media is not the end of the story: media that stops
  // short of the span (a re-mint that began mid-span always does) carries on from
  // there, and at the span's own end we roll into the next recorded span — a DVR
  // plays the day through rather than stopping dead at every gap.
  const onEnded = () => {
    const reached = startMs + durationSec * 1000;
    if (reached < domTo - 1_000) {
      onPlayFrom?.(reached, { keepView: true });
      return;
    }
    const next = spans.find((sp) => sp.start >= domTo - 1_000);
    if (next) onPlayFrom?.(next.start);
    else setPlaying(false);
  };

  // Coverage inside the timeline. On a span-framed timeline this is the whole
  // bar; it earns its keep on the fallback framing, where gaps are real.
  const coverage = useMemo(
    () =>
      spans
        .filter((sp) => sp.end > domFrom && sp.start < domTo)
        .map((sp) => ({
          left: ((Math.max(sp.start, domFrom) - domFrom) / domSpan) * 100,
          width: ((Math.min(sp.end, domTo) - Math.max(sp.start, domFrom)) / domSpan) * 100,
        })),
    [spans, domFrom, domTo, domSpan],
  );

  // The stretch that is loaded and instantly seekable, drawn where it actually
  // sits on the timeline — not from the left edge, because the loaded media
  // usually starts partway in.
  const heldLeft = Math.max(0, ((startMs - domFrom) / domSpan) * 100);
  const heldWidth = Math.max(
    0,
    Math.min(100 - heldLeft, ((Math.min(buffered, durationSec) * 1000) / domSpan) * 100),
  );

  if (typeof document === "undefined") return null;

  // STATIC backdrop — clicking outside deliberately does NOT close. A drag on the
  // seek bar that ends past the bar's edge (which, on a 6px track under pointer
  // capture, is most drags) delivers its click to the common ancestor of press and
  // release — the backdrop — and playback was closing out from under the operator
  // mid-scrub. A window holding a recorded investigation should not be dismissible
  // by a stray click anyway: it closes on ✕, on Esc, or on GO LIVE.
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-6">
      <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[12px] border border-[rgba(150,180,245,.3)] bg-[rgba(8,15,34,.97)] shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(150,180,245,.2)] px-3 py-2">
          <Icon icon="heroicons-outline:film" className="text-sm text-[#22d3ee]" />
          <span className="min-w-0 truncate font-mono text-[12px] text-[#d7f7e9]">
            {camera?.name || "Camera"} · playback
          </span>
          {/* The SPAN's bounds — what the bar below can reach — not the loaded
              media's, which changes under the operator on every seek. */}
          <span className="font-mono text-[11px] text-[#7e93bf]">
            {clockOf(domFrom)} → {clockOf(domTo)}
          </span>
          {transcoded && (
            <span className="rounded-[6px] border border-[rgba(251,191,36,.4)] px-1.5 py-px font-mono text-[10px] text-[#fbbf24]">
              converting {session.codec || "h265"} → h264
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="ml-auto rounded-md p-1 text-[#aec2e8] transition hover:bg-white/10 hover:text-white"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
        </div>

        {/* Picture — a STAGE of fixed height, with the video fitted inside it.
            The video element used to size the panel itself (`max-h` + intrinsic
            size), so between one window ending and the next decoding a frame it
            had no size at all: the modal collapsed to its chrome and snapped back
            open when the picture arrived. Every seek made the dialog jump. A
            fixed stage means the panel's geometry never depends on whether media
            happens to be decoded right now, and `object-contain` letterboxes any
            aspect ratio into it rather than resizing the room around it. */}
        <div className="relative h-[62vh] shrink-0 bg-black">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            src={src}
            autoPlay
            playsInline
            className="h-full w-full bg-black object-contain"
            onLoadedMetadata={onLoaded}
            onLoadedData={() => setOpening(false)}
            onTimeUpdate={onTime}
            onProgress={onTime}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={onEnded}
            onError={() => {
              // A decode/network failure on the direct stream gets the one
              // transcode retry; a failure on the transcode itself is terminal.
              if (transcodeUrl && !transcoded) setTranscoded(true);
              else setFailed(true);
            }}
          />
          {/* Opening a window is a round trip to the recorder plus the first
              keyframe. Say so, rather than showing a black rectangle that reads
              as a camera with nothing on it. */}
          {opening && !failed && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70">
              <Icon icon="svg-spinners:180-ring" className="text-2xl" />
              <p className="font-mono text-[11px] tracking-[.6px]">opening {clockOf(startMs)}…</p>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-center">
              <Icon icon="heroicons-outline:exclamation-triangle" className="text-2xl text-[#f87171]" />
              <p className="text-xs text-[#f87171]">This recorded window could not be played.</p>
            </div>
          )}
        </div>

        {/* Transport */}
        <div className="shrink-0 border-t border-[rgba(150,180,245,.2)] px-3 py-2">
          <div className="flex items-center gap-2">
            <Btn
              icon="heroicons-solid:backward"
              title="Previous recorded span"
              disabled={!hasPrev}
              onClick={() => step(-1)}
            />
            <Btn
              icon={playing ? "heroicons-solid:pause" : "heroicons-solid:play"}
              title={playing ? "Pause (space)" : "Play (space)"}
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) v.play().catch(() => {});
                else v.pause();
              }}
            />
            <Btn
              icon="heroicons-solid:forward"
              title="Next recorded span"
              disabled={!hasNext}
              onClick={() => step(1)}
            />
            <Btn icon="heroicons-outline:chevron-double-left" title={`Back ${SKIP_SEC}s`} onClick={() => skip(-SKIP_SEC)} />
            <Btn icon="heroicons-outline:chevron-double-right" title={`Forward ${SKIP_SEC}s`} onClick={() => skip(SKIP_SEC)} />

            {/* Absolute wall-clock readout — the position, then the timeline's end.
                Relative "0:42 / ∞" tells an operator nothing about when a thing
                happened, which is the only question playback is ever asked. */}
            <span className="ml-1 font-mono text-[13px] tabular-nums text-[#d7f7e9]">
              {clockOf(shownMs)}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[#7e93bf]">/ {clockOf(domTo)}</span>

            <div className="ml-auto flex items-center gap-1">
              {SPEEDS.map((sp) => (
                <button
                  key={sp}
                  type="button"
                  onClick={() => setSpeed(sp)}
                  className={`rounded-[7px] px-1.5 py-0.5 font-mono text-[11px] transition ${
                    speed === sp
                      ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                      : "text-[#7e93bf] hover:text-[#aec2e8]"
                  }`}
                >
                  {sp}×
                </button>
              ))}
            </div>
          </div>

          {/* The span's seek bar — press / drag / release anywhere on it. Its
              domain is the SPAN, so every instant in the span stays reachable no
              matter where the loaded media happens to begin. */}
          <div
            ref={scrub.ref}
            {...scrub.handlers}
            className="group relative mt-2 h-6 cursor-pointer touch-none select-none"
          >
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[rgba(150,180,245,.15)]">
              {/* Recorded coverage inside the timeline */}
              {coverage.map((c, i) => (
                <div
                  key={i}
                  className="absolute inset-y-0 bg-[rgba(52,211,153,.35)]"
                  style={{ left: `${c.left}%`, width: `${Math.max(0.2, c.width)}%` }}
                />
              ))}
              {/* What the browser holds right now — the instantly-seekable part */}
              <div
                className="absolute inset-y-0 bg-[rgba(150,180,245,.28)]"
                style={{ left: `${heldLeft}%`, width: `${heldWidth}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 bg-[#22d3ee]"
                style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%` }}
              />
            </div>
            {/* Handle — always visible, so the bar reads as draggable before the
                operator has tried to drag it. */}
            <span
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0b1428] bg-[#67e8f9] transition-transform group-hover:scale-125"
              style={{ left: `${Math.min(100, Math.max(0, frac * 100))}%` }}
            />
            {scrub.hover != null && (
              <span
                className="pointer-events-none absolute -top-1 -translate-x-1/2 rounded-[5px] border border-[rgba(150,180,245,.3)] bg-[rgba(8,15,34,.95)] px-1.5 py-px font-mono text-[10px] tabular-nums text-[#d7f7e9]"
                style={{ left: `${Math.min(97, Math.max(3, scrub.hover * 100))}%` }}
              >
                {clockOf(domFrom + scrub.hover * domSpan)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
