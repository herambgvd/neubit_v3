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
  const [session, setSession] = useState<any>(null); // the active recorded window
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

  const hours = useMemo(() => Array.from({ length: 25 }, (_, i) => i), []);

  // Switching the focused camera drops the session — the window belonged to the
  // camera we were looking at, and its media token is scoped to that camera.
  useEffect(() => {
    setSession(null);
    setNoFootage(false);
  }, [camera?.id]);

  // ── mint a recorded window at an instant ─────────────────────────────────
  // `start` is the node's clamp-forward answer (often later than we asked, when
  // the ask landed in a gap), and it is the video's true t=0 — treating our own
  // request as t=0 is exactly the off-by-(start − from) drift the node's contract
  // warns about.
  const playFrom = useCallback(
    async (atMs) => {
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
    [federated, nodeId, realId, win.to, day0],
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
          touch drag scrubs instead of panning the page away under the gesture. */}
      <div
        ref={dayScrub.ref}
        {...dayScrub.handlers}
        className={`relative mt-2 h-9 touch-none select-none overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.15)] bg-[#0b1428] ${
          federated ? "cursor-ew-resize" : ""
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
      {session && (
        <PlaybackTheatre
          key={`${session.url}`}
          camera={camera}
          session={session}
          spans={spans}
          onClock={setPlayClock}
          onSeekAbsolute={playFrom}
          onClose={goLive}
        />
      )}
    </div>
  );
}

// ── the theatre ─────────────────────────────────────────────────────────────
// A recorded window with a REAL transport over it. Everything it shows is derived
// from two facts the node gave us: `startMs` (the video's true t=0) and
// `durationSec` (the served window's length). Absolute time = startMs +
// currentTime, which is the clock the operator is actually looking for.
function PlaybackTheatre({ camera, session, spans, onClock, onSeekAbsolute, onClose }: any) {
  const videoRef = useRef<any>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [pos, setPos] = useState(0); // seconds into the window
  const [buffered, setBuffered] = useState(0); // seconds of the window held
  const [transcoded, setTranscoded] = useState(false);
  const [failed, setFailed] = useState(false);

  const { startMs, durationSec, transcodeUrl } = session;
  const src = transcoded && transcodeUrl ? transcodeUrl : session.url;
  const endMs = startMs + durationSec * 1000;

  // Report the playhead upward so the 24h track shows where playback is.
  useEffect(() => {
    onClock?.(startMs + pos * 1000);
  }, [onClock, startMs, pos]);
  useEffect(() => () => onClock?.(null), [onClock]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, src]);

  // Escape closes the theatre — the same reflex as the wall's spotlight.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current;
        if (v) (v.paused ? v.play() : v.pause());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
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

  // How far the browser can seek WITHOUT a new session. A progressive fMP4 is
  // seekable only over what it holds, so anything past that has to be re-minted
  // at the target instant — which is also the cheaper answer for a long jump.
  const seekableEnd = () => {
    const v = videoRef.current;
    try {
      const s = v?.seekable;
      return s?.length ? s.end(s.length - 1) : 0;
    } catch {
      return 0;
    }
  };

  const seekTo = useCallback(
    (frac) => {
      const target = Math.min(durationSec, Math.max(0, frac * durationSec));
      const v = videoRef.current;
      if (v && target <= seekableEnd()) {
        v.currentTime = target;
        setPos(target);
        if (playing) v.play().catch(() => {});
        return;
      }
      // Outside what we hold → mint a fresh window at that instant.
      onSeekAbsolute?.(startMs + target * 1000);
    },
    [durationSec, startMs, playing, onSeekAbsolute],
  );

  const scrub = useScrub(seekTo);
  const shownPos = scrub.drag != null ? scrub.drag * durationSec : pos;
  const frac = durationSec > 0 ? Math.min(1, Math.max(0, shownPos / durationSec)) : 0;

  const skip = (sec) => seekTo(durationSec > 0 ? (pos + sec) / durationSec : 0);

  // Coverage inside THIS window, so the theatre's own bar shows where the gaps
  // are rather than pretending the window is solid footage.
  const windowSpans = useMemo(
    () =>
      spans
        .filter((s) => s.end > startMs && s.start < endMs)
        .map((s) => ({
          left: ((Math.max(s.start, startMs) - startMs) / (durationSec * 1000)) * 100,
          width: ((Math.min(s.end, endMs) - Math.max(s.start, startMs)) / (durationSec * 1000)) * 100,
        })),
    [spans, startMs, endMs, durationSec],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[12px] border border-[rgba(150,180,245,.3)] bg-[rgba(8,15,34,.97)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(150,180,245,.2)] px-3 py-2">
          <Icon icon="heroicons-outline:film" className="text-sm text-[#22d3ee]" />
          <span className="min-w-0 truncate font-mono text-[12px] text-[#d7f7e9]">
            {camera?.name || "Camera"} · playback
          </span>
          <span className="font-mono text-[11px] text-[#7e93bf]">
            {clockOf(startMs)} → {clockOf(endMs)}
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

        {/* Picture */}
        <div className="relative min-h-0 flex-1 bg-black">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            src={src}
            autoPlay
            playsInline
            className="max-h-[62vh] w-full bg-black"
            onLoadedMetadata={onLoaded}
            onTimeUpdate={onTime}
            onProgress={onTime}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => {
              // A decode/network failure on the direct stream gets the one
              // transcode retry; a failure on the transcode itself is terminal.
              if (transcodeUrl && !transcoded) setTranscoded(true);
              else setFailed(true);
            }}
          />
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
              icon={playing ? "heroicons-solid:pause" : "heroicons-solid:play"}
              title={playing ? "Pause (space)" : "Play (space)"}
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) v.play().catch(() => {});
                else v.pause();
              }}
            />
            <Btn icon="heroicons-outline:chevron-double-left" title={`Back ${SKIP_SEC}s`} onClick={() => skip(-SKIP_SEC)} />
            <Btn icon="heroicons-outline:chevron-double-right" title={`Forward ${SKIP_SEC}s`} onClick={() => skip(SKIP_SEC)} />

            {/* Absolute wall-clock readout — the position, then the window's end.
                Relative "0:42 / ∞" tells an operator nothing about when a thing
                happened, which is the only question playback is ever asked. */}
            <span className="ml-1 font-mono text-[13px] tabular-nums text-[#d7f7e9]">
              {clockOf(startMs + shownPos * 1000)}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[#7e93bf]">/ {clockOf(endMs)}</span>

            <div className="ml-auto flex items-center gap-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  className={`rounded-[7px] px-1.5 py-0.5 font-mono text-[11px] transition ${
                    speed === s
                      ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                      : "text-[#7e93bf] hover:text-[#aec2e8]"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>

          {/* Window seek bar — press / drag / release anywhere on it. */}
          <div
            ref={scrub.ref}
            {...scrub.handlers}
            className="group relative mt-2 h-6 cursor-ew-resize touch-none select-none"
          >
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[rgba(150,180,245,.15)]">
              {/* Recorded coverage inside this window */}
              {windowSpans.map((s, i) => (
                <div
                  key={i}
                  className="absolute inset-y-0 bg-[rgba(52,211,153,.35)]"
                  style={{ left: `${s.left}%`, width: `${Math.max(0.2, s.width)}%` }}
                />
              ))}
              {/* What the browser actually holds — the part that seeks instantly */}
              <div
                className="absolute inset-y-0 left-0 bg-[rgba(150,180,245,.28)]"
                style={{ width: `${durationSec > 0 ? Math.min(100, (buffered / durationSec) * 100) : 0}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 bg-[#22d3ee]"
                style={{ width: `${frac * 100}%` }}
              />
            </div>
            {/* Handle — always visible, so the bar reads as draggable before the
                operator has tried to drag it. */}
            <span
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0b1428] bg-[#67e8f9] transition-transform group-hover:scale-125"
              style={{ left: `${frac * 100}%` }}
            />
            {scrub.hover != null && (
              <span
                className="pointer-events-none absolute -top-1 -translate-x-1/2 rounded-[5px] border border-[rgba(150,180,245,.3)] bg-[rgba(8,15,34,.95)] px-1.5 py-px font-mono text-[10px] tabular-nums text-[#d7f7e9]"
                style={{ left: `${Math.min(97, Math.max(3, scrub.hover * 100))}%` }}
              >
                {clockOf(startMs + scrub.hover * durationSec * 1000)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
