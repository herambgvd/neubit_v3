"use client";

// PlayoutBar — the wall's DVR dock: a coverage timeline for the focused camera
// and the transport that drives the wall's playback.
//
// It does not PLAY anything. Playback happens in the tiles themselves (see
// TilePlayback) — this bar only says which instant the wall is at. That is the
// whole shape of the feature, and it is the recorder console's shape too
// (neubit_nvr `app/(console)/live/page.tsx` + `components/console/transport-bar`):
// an operator scrubbing an incident wants the wall they already built, with its
// neighbouring cameras in place, not one camera in a dialog on top of it.
//
//   • Click or drag the track  → the wall enters playback at that instant.
//   • SYNC                     → every filled tile plays that instant, together.
//   • GO LIVE                  → every tile returns to its live stream.
//
// The coverage bars are real: recorded ranges come from the node's segment index
// via /vms/federation/.../timeline. An empty track means the recorder genuinely
// has no footage in the window. Local (non-federated) cameras record on the VMS
// and are not wired to this path yet — the track says so rather than pretending.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { vms } from "../api";
import { RANGES, SPEEDS } from "../hooks/useWallPlayback";

// Colour per recording trigger (mockup palette).
const TRIGGER_COLOR = {
  continuous: "#34d399",
  motion: "#fbbf24",
  schedule: "#60a5fa",
  manual: "#a78bfa",
};

const SKIP_SEC = 10;

function Btn({ icon, title, onClick, active = false, disabled = false }: any) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border transition ${
        active
          ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
          : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee] disabled:cursor-not-allowed disabled:opacity-40"
      }`}
    >
      <Icon icon={icon} className="text-base" />
    </button>
  );
}

const pad2 = (n) => String(n).padStart(2, "0");
const clockOf = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "--:--:--";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const dayValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// Tick spacing for the window on screen: the smallest "round" interval that
// still leaves at most ~10 labels. A 24h track ticked every minute is noise; a
// 5m track ticked every hour has no ticks at all.
const TICKS = [15_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
function tickEvery(spanMs) {
  return TICKS.find((t) => spanMs / t <= 10) || TICKS[TICKS.length - 1];
}

// ── scrub plumbing ──────────────────────────────────────────────────────────
// Press anywhere to grab the playhead, drag to aim (the bar shows the target the
// whole time), release to commit ONE seek. Committing on release is what keeps a
// drag across the track from re-anchoring every tile on the wall per pixel.
//
// Pointer capture is what makes the drag survive leaving the track — the mouse
// WILL leave a bar this thin, and without capture the gesture dies there.
function useScrub(onCommit) {
  const ref = useRef<any>(null);
  const [drag, setDrag] = useState<any>(null);
  const [hover, setHover] = useState<any>(null);

  const fracFrom = (e) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  // Pin the page's cursor for the length of a drag. Pointer capture keeps the
  // EVENTS on this bar but not the cursor: the moment the mouse leaves the track
  // the cursor becomes whatever is underneath, which reads as the drag having
  // been dropped while it is in fact still live.
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return undefined;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragging]);

  // Whether a drag is live is tracked in a REF as well as in state, and the ref
  // is what onPointerUp reads.
  //
  // State alone loses the fast ones. `drag` inside the handler is the value from
  // the render that created the handler, and a quick click — pointerdown and
  // pointerup inside the same frame, before React has re-rendered — still sees
  // `null` there and drops the seek on the floor. It is intermittent by nature:
  // click slowly and it works, tap and nothing happens. The ref is written
  // synchronously, so a click of any length commits.
  const dragRef = useRef<any>(null);

  const handlers = {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      dragRef.current = fracFrom(e);
      setDrag(dragRef.current);
    },
    onPointerMove: (e) => {
      const f = fracFrom(e);
      setHover(f);
      if (dragRef.current == null) return;
      dragRef.current = f;
      setDrag(f);
    },
    onPointerUp: (e) => {
      if (dragRef.current == null) return;
      const f = fracFrom(e);
      dragRef.current = null;
      setDrag(null);
      onCommit(f);
    },
    onPointerCancel: () => {
      dragRef.current = null;
      setDrag(null);
    },
    onPointerLeave: () => setHover(null),
  };

  return { ref, drag, hover, handlers };
}

export default function PlayoutBar({ camera, pb, onClose }: any) {
  const { win, mode, sync, playing, speed, rangeSeconds, clock } = pb;
  const federated = !!camera?.federated;
  const nodeId = camera?.node_id;
  const realId = camera?.real_id;

  // The shared playhead. Only THIS component subscribes in React state — the
  // wall's tiles follow the clock object directly, so a 4Hz playhead re-renders
  // one bar rather than sixty-four tiles.
  const [head, setHead] = useState<any>(null);
  useEffect(() => clock.subscribe(setHead), [clock]);

  // "Now" for the live edge marker; a quarter-minute's resolution is plenty.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const from = win.fromMs;
  const to = win.toMs;
  const span = Math.max(1, to - from);

  const tlQ = useQuery<any>({
    queryKey: ["fed-timeline", nodeId, realId, from, to],
    queryFn: () =>
      vms.federation.timeline(nodeId, realId, {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      }),
    enabled: federated && !!nodeId && !!realId,
    refetchInterval: 60_000,
  });

  // Recorded spans as epoch ms, in time order — the basis for span stepping and
  // for snapping a click that lands in a gap.
  const spans = useMemo(() => {
    const rs = tlQ.data?.ranges || [];
    return rs
      .map((r: any) => {
        const s = new Date(r.start).getTime();
        return { start: s, end: s + (r.duration || 0) * 1000, trigger: r.trigger_type };
      })
      .filter((r) => Number.isFinite(r.start))
      .sort((a, b) => a.start - b.start);
  }, [tlQ.data]);

  // Seek to a fraction of the window. A landing in a gap snaps FORWARD to the
  // next recorded span, so a rough drag still lands on footage rather than
  // silently doing nothing.
  const seekFrac = useCallback(
    (frac) => {
      if (!federated) return;
      const at = from + frac * span;
      const inSpan = spans.some((s) => at >= s.start && at <= s.end);
      const next = spans.find((s) => s.start >= at);
      pb.playAt(inSpan ? at : next ? next.start : at);
    },
    [federated, from, span, spans, pb],
  );

  const scrub = useScrub(seekFrac);

  // Step to the neighbouring recorded span.
  const stepSpan = (dir) => {
    if (!spans.length) return;
    const at = head ?? nowMs;
    const target =
      dir < 0
        ? [...spans].reverse().find((s) => s.start < at - 1_500)
        : spans.find((s) => s.start > at + 1_500);
    if (target) pb.playAt(target.start);
  };

  const ticks = useMemo(() => {
    const every = tickEvery(span);
    const first = Math.ceil(from / every) * every;
    const out: number[] = [];
    for (let t = first; t <= to; t += every) out.push(t);
    return out;
  }, [from, to, span]);

  const playback = mode === "playback";
  // What the track's marker shows: the drag target while scrubbing, then the
  // playhead in playback, and the live edge otherwise.
  const markerMs = scrub.drag != null ? from + scrub.drag * span : playback ? head : nowMs;
  const markerFrac = markerMs == null ? null : (markerMs - from) / span;
  const hoverMs = scrub.hover != null ? from + scrub.hover * span : null;

  return (
    <div className="shrink-0 border-t border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.82)] px-3 py-2 backdrop-blur-xs">
      {/* Transport row */}
      <div className="flex items-center gap-1.5">
        <Btn
          icon="heroicons-solid:backward"
          title="Previous recorded span"
          disabled={!federated || !spans.length}
          onClick={() => stepSpan(-1)}
        />
        <Btn
          icon={playback && playing ? "heroicons-solid:pause" : "heroicons-solid:play"}
          title={!playback ? "Play the earliest footage in view" : playing ? "Pause" : "Play"}
          disabled={!federated || (!playback && !spans.length)}
          onClick={() => {
            if (playback) pb.togglePlaying();
            else if (spans.length) pb.playAt(spans[0].start);
          }}
        />
        <Btn
          icon="heroicons-solid:forward"
          title="Next recorded span"
          disabled={!federated || !spans.length}
          onClick={() => stepSpan(1)}
        />
        <Btn
          icon="heroicons-outline:chevron-double-left"
          title={`Back ${SKIP_SEC}s`}
          disabled={!playback}
          onClick={() => pb.skip(-SKIP_SEC)}
        />
        <Btn
          icon="heroicons-outline:chevron-double-right"
          title={`Forward ${SKIP_SEC}s`}
          disabled={!playback}
          onClick={() => pb.skip(SKIP_SEC)}
        />

        {/* LIVE ⇄ GO LIVE. In playback this is the way back, and it is the first
            control an operator reaches for after scrubbing. */}
        {playback ? (
          <button
            type="button"
            onClick={pb.goLive}
            title="Return every tile to its live stream"
            className="ml-0.5 inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.14)] px-2.5 text-[11px] font-semibold tracking-[.6px] text-[#67e8f9] transition hover:border-[#22d3ee]"
          >
            <Icon icon="heroicons-outline:arrow-uturn-left" className="text-xs" />
            GO LIVE
          </button>
        ) : (
          <span className="ml-0.5 inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.14)] px-2.5 text-[11px] font-semibold tracking-[.6px] text-[#f87171]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#f87171]" />
            LIVE
          </span>
        )}

        {/* SYNC — every filled tile plays this instant, together. Off, only the
            focused tile goes to playback and the rest of the wall stays live,
            which is what you want when you are checking one camera against what
            the others are showing NOW. */}
        <button
          type="button"
          onClick={pb.toggleSync}
          disabled={!playback}
          title={
            sync
              ? "Sync on — every camera on the wall plays this instant"
              : "Sync — play every camera on the wall at this instant"
          }
          className={`inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] font-semibold tracking-[.6px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
            sync
              ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
              : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee]"
          }`}
        >
          <Icon icon="heroicons-outline:squares-2x2" className="text-sm" />
          SYNC
        </button>

        <div className="mx-0.5 h-6 w-px shrink-0 bg-[rgba(150,180,245,.22)]" />

        {/* The absolute clock: the time under the pointer while scrubbing, else
            the playhead. A DVR bar with no clock on it answers no question. */}
        <span className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2 font-mono text-[12px] tabular-nums text-[#d7f7e9]">
          <Icon icon="heroicons-outline:clock" className="text-xs text-[#7e93bf]" />
          {clockOf(hoverMs ?? markerMs)}
        </span>

        {/* Speed — playback only; it means nothing on a live wall. */}
        {playback && (
          <div className="flex shrink-0 items-center gap-0.5">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pb.setSpeed(s)}
                className={`rounded-[7px] px-1.5 py-1 font-mono text-[11px] transition ${
                  speed === s
                    ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                    : "text-[#7e93bf] hover:text-[#aec2e8]"
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        )}

        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#aec2e8]">
          {camera ? (
            <>
              <Icon icon="heroicons-solid:video-camera" className="mr-1 inline text-sm text-[#22d3ee]" />
              {camera.name}
              {camera.node_name && <span className="ml-1.5 text-[#7e93bf]">· {camera.node_name}</span>}
              {federated && (
                <span className="ml-2 text-[#7e93bf]">
                  {tlQ.isLoading ? "loading…" : `${spans.length} span${spans.length === 1 ? "" : "s"} in view`}
                </span>
              )}
            </>
          ) : (
            <span className="text-[#7e93bf]">Click a camera on the wall to scrub its recordings</span>
          )}
        </span>

        {/* DATE. Without this the wall could only ever reach today: the window
            starts at now and the ladder only rescales around the playhead, so
            "show me Tuesday afternoon" had no way in from this page at all. The
            native picker is deliberate — it brings the platform's own calendar,
            keyboard entry and locale for free, and `max` stops an operator
            selecting a future day that cannot hold footage. */}
        <label
          title="Show a different day's recordings"
          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2 text-[#aec2e8] transition focus-within:border-[rgba(34,211,238,.6)] hover:border-[rgba(34,211,238,.6)]"
        >
          <Icon icon="heroicons-outline:calendar-days" className="text-sm text-[#7e93bf]" />
          <input
            type="date"
            value={dayValue(win.fromMs)}
            max={dayValue(Date.now())}
            onChange={(e) => e.target.value && pb.pickDay(e.target.value)}
            className="w-[112px] bg-transparent font-mono text-[11px] tabular-nums text-[#d7f7e9] outline-none [color-scheme:dark]"
          />
        </label>

        {/* Range ladder + paging. A 24h track cannot pick a five-second event and
            a 5m track cannot find which hour it was in; the operator needs both. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => pb.setRange(r.seconds)}
              className={`rounded-[7px] px-1.5 py-1 font-mono text-[11px] transition ${
                rangeSeconds === r.seconds
                  ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                  : "text-[#7e93bf] hover:text-[#aec2e8]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Btn icon="heroicons-outline:chevron-left" title="Earlier" onClick={() => pb.pan(-1)} />
        <Btn icon="heroicons-outline:chevron-right" title="Later" onClick={() => pb.pan(1)} />

        <button
          type="button"
          onClick={onClose}
          title="Hide playback transport"
          className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[rgba(248,113,113,.5)] hover:text-[#f87171]"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-base" />
        </button>
      </div>

      {/* The timeline. Press, drag, release to seek. `touch-none` so a stylus or
          touch drag scrubs instead of panning the page out from under it. */}
      <div
        ref={scrub.ref}
        {...scrub.handlers}
        className={`relative mt-2 h-10 touch-none select-none overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.15)] bg-[#0b1428] ${
          federated ? "cursor-pointer" : ""
        }`}
      >
        {/* Recorded coverage (REAL) */}
        {spans.map((s, i) => {
          const left = ((s.start - from) / span) * 100;
          const width = ((s.end - s.start) / span) * 100;
          if (left > 100 || left + width < 0) return null;
          return (
            <div
              key={i}
              className="pointer-events-none absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[2px]"
              style={{
                left: `${Math.max(0, left)}%`,
                width: `${Math.max(0.15, Math.min(100 - Math.max(0, left), width))}%`,
                background: TRIGGER_COLOR[s.trigger] || TRIGGER_COLOR.continuous,
                opacity: 0.8,
              }}
            />
          );
        })}

        {/* Time ticks, spaced for whatever range is on screen */}
        {ticks.map((t) => (
          <div
            key={t}
            className="pointer-events-none absolute top-0 h-full border-l border-[rgba(150,180,245,.1)]"
            style={{ left: `${((t - from) / span) * 100}%` }}
          >
            <span className="absolute left-1 top-0.5 font-mono text-[9px] text-[#7e93bf]">{hhmm(t)}</span>
          </div>
        ))}

        {/* Honest empty states */}
        {federated && !tlQ.isLoading && spans.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[10px] tracking-[.6px] text-[#7e93bf]">
              No recorded footage in this window
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

        {/* Time under the cursor — so an operator aims at 14:07:12, not at "about
            two thirds along". */}
        {federated && hoverMs != null && (
          <div
            className="pointer-events-none absolute top-0.5 z-10 -translate-x-1/2 rounded-[5px] border border-[rgba(150,180,245,.3)] bg-[rgba(8,15,34,.95)] px-1.5 py-px font-mono text-[10px] tabular-nums text-[#d7f7e9]"
            style={{ left: `${Math.min(96, Math.max(4, scrub.hover * 100))}%` }}
          >
            {clockOf(hoverMs)}
          </div>
        )}

        {/* Playhead — the playback position, or the live edge. */}
        {markerFrac != null && markerFrac >= 0 && markerFrac <= 1 && (
          <div
            className={`pointer-events-none absolute top-0 h-full ${
              scrub.drag != null ? "w-0.5 bg-[#67e8f9]" : playback ? "w-0.5 bg-[#22d3ee]" : "w-px bg-[#f87171]"
            }`}
            style={{ left: `${markerFrac * 100}%`, boxShadow: playback ? "0 0 6px #22d3ee" : "0 0 6px #f87171" }}
          >
            <span
              className={`absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 ${
                playback ? "bg-[#22d3ee]" : "bg-[#f87171]"
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
