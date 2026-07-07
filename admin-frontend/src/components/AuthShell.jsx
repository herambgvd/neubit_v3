"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Activity,
  Cable,
  Eye,
  Fingerprint,
  Flame,
  Network,
  Radar,
  Sparkles,
  Workflow,
} from "lucide-react";

const PILLARS = [
  { icon: Eye, label: "Video" },
  { icon: Fingerprint, label: "Access" },
  { icon: Radar, label: "Intrusion" },
  { icon: Flame, label: "Fire" },
  { icon: Sparkles, label: "AI Analytics" },
  { icon: Workflow, label: "Workflow" },
];

export function BrandVisual() {
  return (
    <div className="relative h-[280px] w-full overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02]">
      <div
        aria-hidden
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.5) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 p-3">
        {[Eye, Fingerprint, Radar, Flame, Sparkles, Cable, Network, Workflow, Activity].map(
          (Icon, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 + i * 0.05, duration: 0.4 }}
              className="flex items-center justify-center"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-cyan-300">
                <Icon className="h-4 w-4" />
              </div>
            </motion.div>
          )
        )}
      </div>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 400 280" fill="none">
        <defs>
          <linearGradient id="auth-line" x1="0" x2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
            <stop offset="50%" stopColor="#6366f1" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[
          "M70,55 C 180,55 240,140 330,140",
          "M70,140 C 180,140 240,225 330,225",
          "M70,225 C 180,225 240,140 330,55",
        ].map((d, i) => (
          <motion.path
            key={i}
            d={d}
            stroke="url(#auth-line)"
            strokeWidth="1.2"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1.4, delay: 0.4 + i * 0.2, ease: "easeInOut" }}
          />
        ))}
      </svg>
      <motion.div
        className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-cyan-400/30 to-indigo-500/30 blur-2xl"
        animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0.9, 0.6] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

export default function AuthShell({
  eyebrow,
  title,
  subtitle,
  productName = "Neubit",
  children,
}) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-black text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(800px 460px at 85% -15%, rgba(34,211,238,0.06), transparent 60%)," +
            "radial-gradient(700px 420px at -10% 110%, rgba(99,102,241,0.05), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
        {/* Brand panel */}
        <aside className="hidden lg:flex relative flex-col justify-between p-12 xl:p-16 border-r border-white/5">
          <Link href="/" className="inline-flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo/neubit_logo.svg"
              alt={productName}
              className="h-8 w-auto invert brightness-0"
            />
          </Link>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-lg"
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1 text-xs font-medium text-cyan-200 backdrop-blur">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
              Unified Command & Control
            </div>
            <h2 className="mt-5 text-3xl xl:text-4xl font-semibold tracking-tight leading-[1.1]">
              Command.{" "}
              <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-cyan-300 bg-clip-text text-transparent">
                Control.
              </span>{" "}
              Intelligence.
            </h2>
            <p className="mt-4 text-slate-300 leading-relaxed">
              The intelligence layer for enterprise command & control —
              where every event triggers the right action, instantly.
            </p>

            <div className="mt-8">
              <BrandVisual />
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
              {PILLARS.map(({ icon: Icon, label }) => (
                <div key={label} className="inline-flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-cyan-300" />
                  {label}
                </div>
              ))}
            </div>
          </motion.div>

          <div className="text-xs text-slate-500">
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
            <div className="lg:hidden mb-8 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo/neubit_logo.svg"
                alt={productName}
                className="h-8 w-auto invert brightness-0"
              />
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 backdrop-blur-xl shadow-2xl shadow-black/40">
              <div className="mb-6">
                {eyebrow && (
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
                    {eyebrow}
                  </div>
                )}
                <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                  {title}
                </h1>
                {subtitle && (
                  <p className="mt-1.5 text-sm text-slate-400">{subtitle}</p>
                )}
              </div>
              {children}
            </div>

            <div className="mt-6 flex items-center justify-between text-xs text-slate-500">
              <Link href="/" className="hover:text-slate-300 transition">
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

/* Reusable styled inputs/buttons for dark auth shell */

export function AuthInput({ className = "", ...props }) {
  return (
    <input
      {...props}
      className={
        "h-11 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 text-sm text-white placeholder:text-slate-500 outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 hover:border-white/20 transition " +
        className
      }
    />
  );
}

export function AuthLabel({ children, htmlFor, action }) {
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={htmlFor} className="text-sm font-medium text-slate-300">
        {children}
      </label>
      {action}
    </div>
  );
}

export function AuthSubmit({ children, loading }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full h-11 rounded-lg bg-white text-slate-900 hover:bg-slate-100 text-sm font-semibold transition disabled:opacity-60 inline-flex items-center justify-center gap-2"
    >
      {loading && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-slate-900" />
      )}
      {children}
    </button>
  );
}

export function AuthError({ children }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
    >
      {children}
    </div>
  );
}
