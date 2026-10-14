"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";
import { motion } from "framer-motion";

import LensAperture from "./LensAperture";

/* ------------------------------------------------------------------ */
/* NeuBit VMS sign-in shell — two-panel command-console layout.        */
/* Teal/violet on the console's theme tokens, so it is drawn in the    */
/* theme the operator picked (Default navy, Light or Dark).            */
/* ------------------------------------------------------------------ */

/* Lightweight animated "soul" backdrop — aperture rings + pulse.
   Faithful recreation of the mockup SVG; perf-light (CSS transforms). */
function Soul() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      style={{ stroke: "currentColor", fill: "none", strokeWidth: 1.7, strokeLinecap: "round" }}
    >
      <defs>
        <radialGradient id="nb-soul-v" cx="30%" cy="45%" r="70%">
          <stop offset="0" stopColor="rgb(var(--nb-c-glow))" stopOpacity=".45" />
          <stop offset="70%" stopColor="rgb(var(--nb-c-bg))" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* stroke="none": the svg's inherited currentColor stroke would otherwise
          outline this rect, showing as white edges left/right after slice-crop. */}
      <rect width="1600" height="900" fill="url(#nb-soul-v)" stroke="none" />
      <g transform="translate(470,470)" fill="none" stroke="rgb(var(--nb-c-mist))" opacity=".06">
        <circle r="330" />
        <circle r="470" />
      </g>
      <g stroke="rgb(var(--nb-c-mist))" fill="none" opacity=".1" strokeLinecap="round">
        <path d="M980 180 Q 700 300 560 420" strokeDasharray="1 15" strokeWidth="1.5" />
        <path d="M1040 700 Q 760 600 590 500" strokeDasharray="1 15" strokeWidth="1.5" />
      </g>
      <line x1="0" y1="700" x2="1600" y2="700" stroke="rgb(var(--nb-c-teal))" opacity=".07" />
    </svg>
  );
}

function Hero() {
  return (
    <div className="relative z-[1] hidden flex-col justify-center px-[8%] pr-[7%] lg:flex">
      {/* masthead */}
      <div className="absolute left-[8%] top-9 flex items-center gap-3">
        <span className="text-[20px] font-bold tracking-[0.5px] text-nb-ink">
          Neu<i className="not-italic text-nb-tealb">Bit</i>
        </span>
        <span className="border-l border-nb-haze/20 pl-3 font-mono text-[9px] tracking-[2.4px] text-nb-faint">
          GENIUS VISION DIGITAL · GVD
        </span>
      </div>

      {/* THE LENS, and one line. What was here — a headline, a paragraph of
          positioning and three stat chips, one of them claiming a percentage
          nobody on this screen can check — was a brochure in front of a door.
          A sign-in page exists so somebody can get to work; what it should say
          about the product is that the product is a camera system, and the lens
          says that without a word. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        className="pointer-events-none absolute right-[6%] top-1/2 -translate-y-1/2 text-nb-tealb"
      >
        <LensAperture size={560} />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        className="relative"
      >
        <h1 className="max-w-[520px] text-[40px] font-[650] leading-[1.14] tracking-[-0.4px] text-nb-ink">
          Every new bit of information.
          <br />
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "linear-gradient(100deg,rgb(var(--nb-c-tealb)),rgb(var(--nb-c-violetb)))" }}
          >
            Captured. Understood. Acted on.
          </span>
        </h1>

        <div className="mt-7 flex flex-wrap gap-[26px]">
          {[
            ["Surveillance", "rgb(var(--nb-c-teal))", "rgb(var(--nb-c-tealb))"],
            ["Building Intelligence", "rgb(var(--nb-c-violet))", "rgb(var(--nb-c-violetb))"],
            ["Configurations", "rgb(var(--nb-c-blue))", "rgb(var(--nb-c-blueb))"],
          ].map(([label, dot, text], i) => (
            <motion.span
              key={label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 + i * 0.08 }}
              className="flex items-center gap-[9px] text-[13px] tracking-[0.3px]"
              style={{ color: text }}
            >
              <i
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: dot, boxShadow: `0 0 9px color-mix(in srgb, ${dot} 80%, transparent)` }}
              />
              {label}
            </motion.span>
          ))}
        </div>
      </motion.div>

      <div className="absolute bottom-[26px] left-[8%] font-mono text-[9px] tracking-[2px] text-nb-faint opacity-75">
        NEUBIT · LISTEN TO YOUR DATA
      </div>
    </div>
  );
}

const ACCESS_HINT = "Need access? Contact your administrator.";

/** `hint` replaces the line under the card: first-run setup has no
 *  administrator to contact yet. */
export default function NeubitAuthShell({
  children,
  hint = ACCESS_HINT,
}: Readonly<{ children?: ReactNode; hint?: ReactNode }>) {
  return (
    <div
      className="relative grid h-screen w-full overflow-hidden text-nb-ink antialiased lg:grid-cols-[1.25fr_1fr]"
      style={{ background: "radial-gradient(1400px 800px at 72% 30%, rgb(var(--nb-c-glow)) 0%, rgb(var(--nb-c-bg)) 55%)" }}
    >
      <style>{`
        @keyframes nb-spin{to{transform:rotate(360deg)}}
        @keyframes nb-pulse{0%,100%{opacity:.16}50%{opacity:.3}}
        .nb-spin{transform-origin:center;animation:nb-spin 90s linear infinite}
        .nb-pulse{animation:nb-pulse 6s ease-in-out infinite}
        @media (prefers-reduced-motion: reduce){
          .nb-spin,.nb-pulse{animation:none}
        }
      `}</style>

      <Soul />
      <Hero />

      {/* Auth panel */}
      <div
        className="relative z-[1] grid place-items-center overflow-y-auto px-5 py-8 lg:border-l lg:border-nb-haze/20 lg:p-[30px]"
        style={{ background: "linear-gradient(200deg,rgb(var(--nb-c-violet)/.05),rgb(var(--nb-c-surface3)/.55) 60%)" }}
      >
        {/* Mobile masthead (hero hidden < lg) */}
        <div className="w-full max-w-[400px]">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <span className="text-[20px] font-bold tracking-[0.5px]">
              Neu<i className="not-italic text-nb-tealb">Bit</i>
            </span>
            <span className="border-l border-nb-haze/20 pl-3 font-mono text-[9px] tracking-[2.4px] text-nb-faint">
              GENIUS VISION DIGITAL · GVD
            </span>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="rounded-[18px] border border-nb-violet/40 p-[30px] sm:px-8"
            style={{
              background: "linear-gradient(165deg,rgb(var(--nb-c-violet)/.1),rgb(var(--nb-c-panel)) 65%)",
              boxShadow: "var(--nb-shadow-lift)",
            }}
          >
            {children}
          </motion.div>

          <div className="mt-5 flex items-center justify-between font-mono text-[10px] text-nb-faint">
            <Link href="/" className="transition hover:text-nb-muted">
              ← Back to site
            </Link>
            <span>{hint}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared NeuBit-styled primitives for the login + MFA forms.          */
/* ------------------------------------------------------------------ */
export function NbLabel({ children, htmlFor }: Readonly<{ children?: ReactNode; htmlFor?: string }>) {
  return (
    <label htmlFor={htmlFor} className="mb-[5px] block font-mono text-[10px] uppercase tracking-[0.8px] text-nb-faint">
      {children}
    </label>
  );
}

export interface NbInputProps extends ComponentPropsWithoutRef<"input"> {
  /** Red border + aria-invalid; the message itself is NbFieldError below. */
  invalid?: boolean;
}

export function NbInput({ className = "", invalid = false, ...props }: Readonly<NbInputProps>) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={
        "w-full rounded-[10px] border bg-nb-field px-[14px] py-[11px] text-[13.5px] text-nb-ink outline-hidden transition placeholder:text-nb-faint/60 focus:ring-[3px] " +
        (invalid
          ? "border-red-400/60 focus:border-red-400/80 focus:ring-red-500/10 "
          : "border-nb-haze/20 focus:border-nb-teal/55 focus:ring-nb-teal/8 ") +
        className
      }
    />
  );
}

/* Per-field validation message — sits directly under its input. */
export function NbFieldError({ id, children }: Readonly<{ id?: string; children?: ReactNode }>) {
  if (!children) return null;
  return (
    <p id={id} className="mt-[5px] flex items-center gap-[5px] text-[11px] text-red-300">
      <span aria-hidden>⚠</span>
      {children}
    </p>
  );
}

export function NbSubmit({ children, loading, disabled }: Readonly<{ children?: ReactNode; loading?: boolean; disabled?: boolean }>) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="inline-flex w-full items-center justify-center gap-2 rounded-[11px] py-3 text-[13.5px] font-[650] tracking-[0.4px] text-nb-onteal transition hover:shadow-[0_0_26px_rgb(var(--nb-c-teal)/.45)] active:translate-y-[1px] disabled:opacity-60"
      style={{ background: "linear-gradient(100deg,rgb(var(--nb-c-teal)),rgb(var(--nb-c-tealb)))" }}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-nb-onteal/30 border-t-nb-onteal" />}
      {children}
    </button>
  );
}

export function NbError({ children }: Readonly<{ children?: ReactNode }>) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
    >
      {children}
    </div>
  );
}
