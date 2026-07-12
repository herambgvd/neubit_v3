"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Eye, Fingerprint, Radar, Flame, Sparkles, Workflow } from "lucide-react";

/* Shared accent with the landing page — restrained emerald. */
const ACCENT = "#10b981";

const PILLARS = [
  { icon: Eye, label: "Video" },
  { icon: Fingerprint, label: "Access" },
  { icon: Radar, label: "Intrusion" },
  { icon: Flame, label: "Fire" },
  { icon: Sparkles, label: "AI Analytics" },
  { icon: Workflow, label: "Workflow" },
];

/* ------------------------------------------------------------------ */
/* Mini command-and-control console — panel-sized echo of the landing */
/* hero. Pure divs/SVG + Framer Motion. Vertical, fits a narrow aside. */
/* ------------------------------------------------------------------ */
function useClock() {
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const fmt = (d) => (d ? d.toLocaleTimeString("en-GB", { hour12: false }) : "--:--:--");

const MINI_TILES = ["CAM-01", "GATE-03", "LOBBY-2", "PERIM-W", "ATRIUM", "DOCK-07"];

const MINI_EVENTS = [
  { sev: ACCENT, tag: "ACCESS GRANTED", loc: "Lobby" },
  { sev: "#f59e0b", tag: "MOTION", loc: "Gate 3" },
  { sev: ACCENT, tag: "CAMERA ONLINE", loc: "Roof 01" },
];

function MiniConsole() {
  const now = useClock();
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 opacity-60"
        style={{ background: "radial-gradient(420px 220px at 55% 40%, rgba(16,185,129,0.12), transparent 70%)" }}
      />
      <motion.div
        initial={{ opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="overflow-hidden rounded-xl border border-white/[0.1] bg-[#08080a] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.9)]"
      >
        {/* status bar */}
        <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
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
          <span className="font-mono text-[9px] tabular-nums text-white/50">{fmt(now)}</span>
        </div>

        <div className="space-y-2 p-2.5">
          {/* mini video wall */}
          <div className="rounded-md border border-white/[0.07] bg-white/[0.015] p-2">
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">Video Wall · 6 / 512</span>
              <span className="flex items-center gap-1 font-mono text-[9px] text-white/40">
                <span className="h-1 w-1 rounded-full" style={{ background: ACCENT }} /> streaming
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {MINI_TILES.map((label, i) => (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2 + i * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="relative aspect-video overflow-hidden rounded-[3px] border border-white/[0.06] bg-[#0c0c0e]"
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        "radial-gradient(120% 90% at 30% 10%, rgba(255,255,255,0.06), transparent 60%)," +
                        "linear-gradient(160deg, #141417 0%, #0a0a0b 100%)",
                    }}
                  />
                  <motion.div
                    aria-hidden
                    className="absolute inset-x-0 h-6"
                    style={{ background: "linear-gradient(180deg, transparent, rgba(16,185,129,0.06), transparent)" }}
                    animate={{ y: ["-20%", "260%"] }}
                    transition={{ duration: 3 + (i % 3), repeat: Infinity, ease: "linear" }}
                  />
                  <div className="absolute left-1 top-1 flex items-center gap-1">
                    <motion.span
                      className="h-1 w-1 rounded-full"
                      style={{ background: ACCENT }}
                      animate={{ opacity: [1, 0.25, 1] }}
                      transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.2 }}
                    />
                    <span className="font-mono text-[6px] leading-none tracking-wider text-white/50">LIVE</span>
                  </div>
                  <div className="absolute bottom-1 left-1 font-mono text-[7px] leading-none tracking-wide text-white/55">
                    {label}
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* mini event feed */}
          <div className="rounded-md border border-white/[0.07] bg-white/[0.015] p-2">
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">Event Feed</span>
              <span className="font-mono text-[9px] tabular-nums text-white/40">{fmt(now)}</span>
            </div>
            <div className="space-y-0.5">
              {MINI_EVENTS.map((e, i) => (
                <motion.div
                  key={e.tag}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 + i * 0.15, duration: 0.4 }}
                  className="flex items-center gap-2 py-1"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: e.sev, boxShadow: `0 0 6px ${e.sev}` }}
                  />
                  <span className="font-mono text-[9px] tabular-nums text-white/35">[{fmt(now)}]</span>
                  <span className="truncate font-mono text-[9px] font-medium tracking-wide text-white/75">{e.tag}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-white/40">{e.loc}</span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* mini KPI strip */}
          <div className="grid grid-cols-3 gap-1.5">
            {[
              ["512", "Cameras"],
              ["24", "Sites"],
              ["1.8s", "Avg resp"],
            ].map(([v, l]) => (
              <div key={l} className="rounded-md border border-white/[0.07] bg-white/[0.015] px-2 py-1.5">
                <div className="font-mono text-sm font-medium tabular-nums text-white">{v}</div>
                <div className="mt-0.5 font-mono text-[7px] uppercase tracking-[0.15em] text-white/40">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AuthShell — two-panel branded shell (brand console left, form right) */
/* ------------------------------------------------------------------ */
export default function AuthShell({ eyebrow, title, subtitle, productName = "Neubit", children }) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#0a0a0a] text-white antialiased selection:bg-emerald-500/20">
      {/* line grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.6]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 90% 80% at 30% 0%, black 40%, transparent 90%)",
        }}
      />
      {/* radial glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(800px 460px at 15% -10%, rgba(16,185,129,0.12), transparent 60%)," +
            "radial-gradient(700px 420px at 100% 110%, rgba(255,255,255,0.035), transparent 60%)",
        }}
      />

      <div className="relative z-10 grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
        {/* Brand panel */}
        <aside className="relative hidden flex-col gap-10 overflow-y-auto border-r border-white/[0.06] p-12 lg:flex xl:p-16">
          <Link href="/" className="inline-flex shrink-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt={productName} className="h-8 w-auto invert brightness-0" />
          </Link>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-lg"
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-3.5 py-1.5 font-mono text-[11px] tracking-wide text-white/60 backdrop-blur">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full"
                style={{ background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }}
              />
              UNIFIED COMMAND &amp; CONTROL
            </div>
            <h2 className="mt-5 text-3xl font-semibold leading-[1.1] tracking-tight xl:text-4xl">
              Command. Control. <span style={{ color: ACCENT }}>Intelligence.</span>
            </h2>
            <p className="mt-4 leading-relaxed text-white/55">
              The intelligence layer for enterprise command &amp; control — where every event triggers the
              right action, instantly.
            </p>

            <div className="mt-8">
              <MiniConsole />
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-2">
              {PILLARS.map(({ icon: Icon, label }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.025] px-3 py-1 font-mono text-[11px] text-white/60"
                >
                  <Icon className="h-3 w-3" style={{ color: ACCENT }} />
                  {label}
                </span>
              ))}
            </div>
          </motion.div>

          <div className="mt-auto shrink-0 pt-2 font-mono text-[11px] text-white/35">
            © {new Date().getFullYear()} {productName}. All rights reserved.
          </div>
        </aside>

        {/* Form panel */}
        <section className="flex items-center justify-center px-6 py-12 sm:px-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-md"
          >
            <div className="mb-8 flex items-center justify-center lg:hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo/neubit_logo.svg" alt={productName} className="h-8 w-auto invert brightness-0" />
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
              <div className="mb-6">
                {eyebrow && (
                  <div className="font-mono text-[11px] font-medium uppercase tracking-[0.2em]" style={{ color: ACCENT }}>
                    {eyebrow}
                  </div>
                )}
                <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">{title}</h1>
                {subtitle && <p className="mt-1.5 text-sm text-white/50">{subtitle}</p>}
              </div>
              {children}
            </div>

            <div className="mt-6 flex items-center justify-between font-mono text-[11px] text-white/40">
              <Link href="/" className="transition hover:text-white/70">
                ← Back to site
              </Link>
              <span>Need access? Contact your administrator.</span>
            </div>
          </motion.div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reusable styled inputs/buttons — emerald focus                      */
/* ------------------------------------------------------------------ */
export function AuthInput({ className = "", ...props }) {
  return (
    <input
      {...props}
      className={
        "h-11 w-full rounded-lg border border-white/[0.1] bg-white/[0.03] px-3.5 text-sm text-white outline-none transition placeholder:text-white/30 hover:border-white/20 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/20 " +
        className
      }
    />
  );
}

export function AuthLabel({ children, htmlFor, action }) {
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={htmlFor} className="text-sm font-medium text-white/70">
        {children}
      </label>
      {action}
    </div>
  );
}

export function AuthSubmit({ children, loading, disabled }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />}
      {children}
    </button>
  );
}

export function AuthError({ children }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      {children}
    </div>
  );
}
