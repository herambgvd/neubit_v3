"use client";

/**
 * ConsoleHero — a live command-and-control console mockup.
 *
 * Pure divs/SVG + Framer Motion (no real video). Composed like a real ops
 * dashboard: status bar, mini video wall, live event feed, KPI counters, and a
 * radar/site map. All intervals are cleaned up on unmount; animations use
 * transforms/opacity to stay performant.
 */

import { useEffect, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  animate,
  useInView,
} from "framer-motion";

const ACCENT = "#10b981"; // emerald — the single restrained accent

/* ------------------------------------------------------------------ */
/* Shared live clock — one interval, shared across children via prop.  */
/* ------------------------------------------------------------------ */
function useClock() {
  // Start null so SSR + first client render agree (no wall-clock in the HTML) —
  // the real time is set only AFTER mount, avoiding a hydration mismatch.
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function fmtTime(d) {
  if (!d) return "--:--:--"; // pre-mount placeholder (matches server render)
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

/* ------------------------------------------------------------------ */
/* Video wall                                                          */
/* ------------------------------------------------------------------ */
const CAM_TILES = [
  "CAM-01", "GATE-03", "LOBBY-2", "DOCK-07",
  "PERIM-W", "CAM-14", "ATRIUM", "ELEV-B2",
  "ROOF-01", "CAM-22", "GATE-01", "BAY-09",
];

function VideoTile({ label, index, time }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.15 + index * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative aspect-video overflow-hidden rounded-[3px] border border-white/[0.06] bg-[#0c0c0e]"
    >
      {/* faux feed gradient */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 30% 10%, rgba(255,255,255,0.06), transparent 60%)," +
            "linear-gradient(160deg, #141417 0%, #0a0a0b 100%)",
        }}
      />
      {/* moving scanline */}
      <motion.div
        aria-hidden
        className="absolute inset-x-0 h-8"
        style={{
          background:
            "linear-gradient(180deg, transparent, rgba(16,185,129,0.05), transparent)",
        }}
        animate={{ y: ["-20%", "260%"] }}
        transition={{ duration: 3 + (index % 4), repeat: Infinity, ease: "linear" }}
      />
      {/* fixed scanlines texture */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 3px)",
        }}
      />
      {/* LIVE dot */}
      <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
        <motion.span
          className="h-1 w-1 rounded-full"
          style={{ background: ACCENT }}
          animate={{ opacity: [1, 0.25, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, delay: index * 0.2 }}
        />
        <span className="font-mono text-[7px] leading-none tracking-wider text-white/50">
          LIVE
        </span>
      </div>
      {/* channel label */}
      <div className="absolute bottom-1 left-1.5 font-mono text-[8px] leading-none tracking-wide text-white/60">
        {label}
      </div>
      {/* ticking timestamp */}
      <div className="absolute bottom-1 right-1.5 font-mono text-[8px] leading-none tabular-nums tracking-wide text-white/35">
        {time}
      </div>
    </motion.div>
  );
}

function VideoWall({ time }) {
  return (
    <div className="rounded-md border border-white/[0.07] bg-white/[0.015] p-2">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
          Video Wall · 12 / 512
        </span>
        <span className="flex items-center gap-1 font-mono text-[9px] text-white/40">
          <span className="h-1 w-1 rounded-full" style={{ background: ACCENT }} />
          streaming
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {CAM_TILES.map((c, i) => (
          <VideoTile key={c} label={c} index={i} time={fmtTime(time)} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live event feed                                                     */
/* ------------------------------------------------------------------ */
const EVENT_POOL = [
  { sev: "amber", tag: "MOTION", loc: "Gate 3" },
  { sev: "emerald", tag: "ACCESS GRANTED", loc: "Lobby" },
  { sev: "emerald", tag: "FIRE PANEL", loc: "OK" },
  { sev: "red", tag: "INTRUSION", loc: "Perimeter W" },
  { sev: "amber", tag: "LOITERING", loc: "Bay 09" },
  { sev: "emerald", tag: "BADGE IN", loc: "Dock 07" },
  { sev: "red", tag: "DOOR FORCED", loc: "Elev B2" },
  { sev: "amber", tag: "TAILGATE", loc: "Atrium" },
  { sev: "emerald", tag: "CAMERA ONLINE", loc: "Roof 01" },
  { sev: "amber", tag: "LPR MATCH", loc: "Gate 1" },
];

const SEV_COLOR = {
  amber: "#f59e0b",
  red: "#ef4444",
  emerald: "#10b981",
};

function EventFeed({ time }) {
  const [events, setEvents] = useState(() =>
    EVENT_POOL.slice(0, 5).map((e, i) => ({ ...e, id: i, t: fmtTime(time) }))
  );
  const seqRef = useRef(5);

  useEffect(() => {
    let mounted = true;
    let timer;
    const push = () => {
      if (!mounted) return;
      const pick = EVENT_POOL[Math.floor(Math.random() * EVENT_POOL.length)];
      const id = seqRef.current++;
      setEvents((prev) => [
        { ...pick, id, t: fmtTime(new Date()) },
        ...prev.slice(0, 5),
      ]);
      timer = setTimeout(push, 1500 + Math.random() * 1000);
    };
    timer = setTimeout(push, 1800);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex h-full flex-col rounded-md border border-white/[0.07] bg-white/[0.015] p-2">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
          Event Feed
        </span>
        <span className="font-mono text-[9px] tabular-nums text-white/40">
          {fmtTime(time)}
        </span>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          {events.map((e) => (
            <motion.div
              key={e.id}
              layout
              initial={{ opacity: 0, y: -14, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-2 border-b border-white/[0.04] py-1.5"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: SEV_COLOR[e.sev], boxShadow: `0 0 6px ${SEV_COLOR[e.sev]}` }}
              />
              <span className="font-mono text-[9px] tabular-nums text-white/35">
                [{e.t}]
              </span>
              <span className="truncate font-mono text-[9px] font-medium tracking-wide text-white/75">
                {e.tag}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[9px] text-white/40">
                {e.loc}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KPI counters — count up on view                                     */
/* ------------------------------------------------------------------ */
function CountUp({ to, format }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const mv = useMotionValue(0);
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(mv, to, {
      duration: 1.6,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setVal(v),
    });
    return () => controls.stop();
  }, [inView, to, mv]);

  return <span ref={ref}>{format ? format(val) : Math.round(val)}</span>;
}

const KPIS = [
  { label: "Cameras", to: 512, format: (v) => Math.round(v).toLocaleString() },
  { label: "Events / min", to: 1240, format: (v) => Math.round(v).toLocaleString() },
  { label: "Sites", to: 24, format: (v) => Math.round(v) },
  { label: "Avg response", to: 1.8, format: (v) => v.toFixed(1) + "s" },
];

function KpiRow() {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {KPIS.map((k) => (
        <div
          key={k.label}
          className="rounded-md border border-white/[0.07] bg-white/[0.015] px-2.5 py-2"
        >
          <div className="font-mono text-base font-medium tabular-nums text-white sm:text-lg">
            <CountUp to={k.to} format={k.format} />
          </div>
          <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.15em] text-white/40">
            {k.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Radar / site map                                                    */
/* ------------------------------------------------------------------ */
const BLIPS = [
  { x: 34, y: 40, sev: "emerald", d: 0 },
  { x: 68, y: 30, sev: "amber", d: 0.6 },
  { x: 78, y: 66, sev: "emerald", d: 1.1 },
  { x: 46, y: 72, sev: "red", d: 0.3 },
  { x: 58, y: 52, sev: "emerald", d: 0.9 },
];

function Radar() {
  return (
    <div className="relative flex-1 overflow-hidden rounded-md border border-white/[0.07] bg-white/[0.015] p-2">
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
          Situational Map
        </span>
        <span className="font-mono text-[9px] text-white/40">24 sites</span>
      </div>
      <div className="relative aspect-square w-full">
        <svg viewBox="0 0 100 100" className="h-full w-full">
          {/* grid rings */}
          {[42, 30, 18].map((r) => (
            <circle
              key={r}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="0.4"
            />
          ))}
          <line x1="50" y1="8" x2="50" y2="92" stroke="rgba(255,255,255,0.05)" strokeWidth="0.4" />
          <line x1="8" y1="50" x2="92" y2="50" stroke="rgba(255,255,255,0.05)" strokeWidth="0.4" />

          {/* sweep */}
          <defs>
            <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={ACCENT} stopOpacity="0.35" />
              <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
            </linearGradient>
          </defs>
          <motion.g
            style={{ originX: "50px", originY: "50px" }}
            animate={{ rotate: 360 }}
            transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
          >
            <path d="M50 50 L50 8 A42 42 0 0 1 88 38 Z" fill="url(#sweep)" />
          </motion.g>

          {/* blips */}
          {BLIPS.map((b, i) => (
            <g key={i}>
              <motion.circle
                cx={b.x}
                cy={b.y}
                r="1.6"
                fill={SEV_COLOR[b.sev]}
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: b.d }}
              />
              <motion.circle
                cx={b.x}
                cy={b.y}
                r="1.6"
                fill="none"
                stroke={SEV_COLOR[b.sev]}
                strokeWidth="0.5"
                animate={{ r: [1.6, 6], opacity: [0.6, 0] }}
                transition={{ duration: 2.4, repeat: Infinity, delay: b.d, ease: "easeOut" }}
              />
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status bar                                                          */
/* ------------------------------------------------------------------ */
function StatusBar({ time }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5">
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} className="h-2 w-2 rounded-full" style={{ background: c, opacity: 0.55 }} />
          ))}
        </div>
        <div
          className="flex items-center gap-1.5 rounded-full border px-2 py-0.5"
          style={{ borderColor: "rgba(16,185,129,0.3)", background: "rgba(16,185,129,0.08)" }}
        >
          <motion.span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }}
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.8, repeat: Infinity }}
          />
          <span className="font-mono text-[9px] uppercase tracking-[0.18em]" style={{ color: ACCENT }}>
            System Nominal
          </span>
        </div>
      </div>

      <div className="hidden items-center gap-3 sm:flex">
        <span className="font-mono text-[9px] text-white/40">NEUBIT · C2</span>
        <div className="flex items-center gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <motion.span
              key={i}
              className="h-2.5 w-[3px] rounded-sm"
              style={{ background: i < 4 ? ACCENT : "rgba(245,158,11,0.8)" }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.18 }}
            />
          ))}
        </div>
        <span className="font-mono text-[9px] tabular-nums text-white/50">{fmtTime(time)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Composed console                                                    */
/* ------------------------------------------------------------------ */
export default function ConsoleHero() {
  const time = useClock();

  return (
    <div className="relative">
      {/* ambient glow under the frame */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-8 -z-10 opacity-60"
        style={{
          background:
            "radial-gradient(600px 300px at 60% 40%, rgba(16,185,129,0.10), transparent 70%)",
        }}
      />
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="overflow-hidden rounded-xl border border-white/[0.1] bg-[#08080a] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]"
      >
        <StatusBar time={time} />

        {/* Full-width ops layout: video wall · event feed · situational map,
            then a full-span KPI strip underneath. */}
        <div className="grid gap-2 p-2.5 lg:grid-cols-[1.9fr_1.15fr_1fr]">
          <VideoWall time={time} />
          <div className="flex min-h-[240px] flex-col">
            <EventFeed time={time} />
          </div>
          <div className="flex flex-col">
            <Radar />
          </div>
        </div>
        <div className="px-2.5 pb-2.5">
          <KpiRow />
        </div>
      </motion.div>
    </div>
  );
}
