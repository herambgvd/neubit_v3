"use client";

import Link from "next/link";
import { motion } from "framer-motion";

/* ------------------------------------------------------------------ */
/* NeuBit VMS sign-in shell — two-panel command-console layout.        */
/* Navy/teal/violet palette (login-only; the shared AuthShell keeps    */
/* its emerald identity for Setup / Forgot-password).                  */
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
          <stop offset="0" stopColor="#1a3260" stopOpacity=".45" />
          <stop offset="70%" stopColor="#0c1530" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* stroke="none": the svg's inherited currentColor stroke would otherwise
          outline this rect, showing as white edges left/right after slice-crop. */}
      <rect width="1600" height="900" fill="url(#nb-soul-v)" stroke="none" />
      <g transform="translate(470,470)" fill="none" stroke="#8fb0e8" opacity=".06">
        <circle r="330" />
        <circle r="470" />
      </g>
      <g transform="translate(470,470)" fill="none" stroke="#22d3ee">
        <circle r="58" className="nb-pulse" opacity=".22" strokeWidth="1.4" />
        <circle r="104" className="nb-pulse" opacity=".15" style={{ animationDelay: "2s" }} />
        <circle r="158" className="nb-pulse" opacity=".1" style={{ animationDelay: "4s" }} />
        <g className="nb-spin" opacity=".35" stroke="#9fb9ec" strokeLinecap="round">
          <path d="M0 -58 L32 -25" />
          <path d="M50 29 L18 50" />
          <path d="M-50 29 L-18 50" />
          <path d="M-50 -29 L-18 -50" />
          <path d="M50 -29 L18 -50" />
          <path d="M0 58 L-32 25" />
        </g>
      </g>
      <g stroke="#8fb0e8" fill="none" opacity=".1" strokeLinecap="round">
        <path d="M980 180 Q 700 300 560 420" strokeDasharray="1 15" strokeWidth="1.5" />
        <path d="M1040 700 Q 760 600 590 500" strokeDasharray="1 15" strokeWidth="1.5" />
      </g>
      <g fontFamily="ui-monospace,monospace" fontSize="12" fill="#67e8f9" opacity=".2" stroke="none">
        <text x="392" y="404">1</text>
        <text x="540" y="368">0</text>
      </g>
      <line x1="0" y1="700" x2="1600" y2="700" stroke="#22d3ee" opacity=".07" />
    </svg>
  );
}

function Hero() {
  return (
    <div className="relative z-[1] hidden flex-col justify-center px-[8%] pr-[7%] lg:flex">
      {/* masthead */}
      <div className="absolute left-[8%] top-9 flex items-center gap-3">
        <span className="text-[20px] font-bold tracking-[0.5px] text-[#f2f6ff]">
          Neu<i className="not-italic text-[#67e8f9]">Bit</i>
        </span>
        <span className="border-l border-[rgba(160,150,245,.2)] pl-3 font-mono text-[9px] tracking-[2.4px] text-[#9a92c8]">
          GENIUS VISION DIGITAL · GVD
        </span>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        <h1 className="max-w-[560px] text-[44px] font-[650] leading-[1.14] tracking-[-0.4px] text-[#f2f6ff]">
          Every new bit of information.
          <br />
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "linear-gradient(100deg,#67e8f9,#c4b5fd)" }}
          >
            Captured. Understood. Acted on.
          </span>
        </h1>
        <p className="mt-4 max-w-[520px] text-[15.5px] text-[#cfd0f2]">
          One platform for security, surveillance and building intelligence — from a single recorder to a
          federated estate. The NVR records and responds, the platform federates and operates, the AI operator
          drives the workflow to a verified fix.
        </p>

        <div className="mt-[34px] flex flex-wrap gap-[26px]">
          {[
            ["Surveillance", "#22d3ee", "#67e8f9"],
            ["Building Intelligence", "#a78bfa", "#c4b5fd"],
            ["Configurations", "#60a5fa", "#93c5fd"],
          ].map(([label, dot, text]) => (
            <span
              key={label}
              className="flex items-center gap-[9px] text-[13px] tracking-[0.3px]"
              style={{ color: text }}
            >
              <i
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: dot, boxShadow: `0 0 9px ${dot}cc` }}
              />
              {label}
            </span>
          ))}
        </div>

        <div className="mt-[38px] flex flex-wrap gap-[10px]">
          {[
            ["100,000", "channels · one directory ladder"],
            ["Island mode", "— lose the server, keep the site"],
            ["−62%", "false alarms · camera-verified"],
          ].map(([b, rest]) => (
            <span
              key={b}
              className="rounded-2xl border border-[rgba(160,150,245,.2)] px-[14px] py-[6px] font-mono text-[10px] tracking-[0.6px] text-[#9a92c8]"
            >
              <b className="font-semibold text-[#cfd0f2]">{b}</b> {rest}
            </span>
          ))}
        </div>
      </motion.div>

      <div className="absolute bottom-[26px] left-[8%] font-mono text-[9px] tracking-[2px] text-[#9a92c8] opacity-75">
        NEUBIT · LISTEN TO YOUR DATA
      </div>
    </div>
  );
}

export default function NeubitAuthShell({ children }: any) {
  return (
    <div
      className="relative grid h-screen w-full overflow-hidden text-[#f2f6ff] antialiased lg:grid-cols-[1.25fr_1fr]"
      style={{ background: "radial-gradient(1400px 800px at 72% 30%, #18305a 0%, #0c1530 55%)" }}
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
        className="relative z-[1] grid place-items-center overflow-y-auto px-5 py-8 lg:border-l lg:border-[rgba(160,150,245,.2)] lg:p-[30px]"
        style={{ background: "linear-gradient(200deg,rgba(167,139,250,.05),rgba(8,13,30,.55) 60%)" }}
      >
        {/* Mobile masthead (hero hidden < lg) */}
        <div className="w-full max-w-[400px]">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <span className="text-[20px] font-bold tracking-[0.5px]">
              Neu<i className="not-italic text-[#67e8f9]">Bit</i>
            </span>
            <span className="border-l border-[rgba(160,150,245,.2)] pl-3 font-mono text-[9px] tracking-[2.4px] text-[#9a92c8]">
              GENIUS VISION DIGITAL · GVD
            </span>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="rounded-[18px] border border-[rgba(167,139,250,.4)] p-[30px] sm:px-8"
            style={{
              background: "linear-gradient(165deg,rgba(167,139,250,.10),#0e1734 65%)",
              boxShadow: "0 24px 70px rgba(3,10,28,.65)",
            }}
          >
            {children}
          </motion.div>

          <div className="mt-5 flex items-center justify-between font-mono text-[10px] text-[#9a92c8]">
            <Link href="/" className="transition hover:text-[#cfd0f2]">
              ← Back to site
            </Link>
            <span>Need access? Contact your administrator.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared NeuBit-styled primitives for the login + MFA forms.          */
/* ------------------------------------------------------------------ */
export function NbLabel({ children }: any) {
  return (
    <label className="mb-[5px] block font-mono text-[10px] tracking-[0.8px] text-[#9a92c8]">{children}</label>
  );
}

export function NbInput({ className = "", invalid = false, ...props }: any) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={
        "w-full rounded-[10px] border bg-[#0b1228] px-[14px] py-[11px] text-[13.5px] text-[#f2f6ff] outline-hidden transition placeholder:text-[#9a92c8]/60 focus:ring-[3px] " +
        (invalid
          ? "border-red-400/60 focus:border-red-400/80 focus:ring-red-500/10 "
          : "border-[rgba(160,150,245,.2)] focus:border-[rgba(34,211,238,.55)] focus:ring-[rgba(34,211,238,.08)] ") +
        className
      }
    />
  );
}

/* Per-field validation message — sits directly under its input. */
export function NbFieldError({ id, children }: any) {
  if (!children) return null;
  return (
    <p id={id} className="mt-[5px] flex items-center gap-[5px] text-[11px] text-red-300">
      <span aria-hidden>⚠</span>
      {children}
    </p>
  );
}

export function NbSubmit({ children, loading, disabled }: any) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="inline-flex w-full items-center justify-center gap-2 rounded-[11px] py-3 text-[13.5px] font-[650] tracking-[0.4px] text-[#062330] transition hover:shadow-[0_0_26px_rgba(34,211,238,.45)] active:translate-y-[1px] disabled:opacity-60"
      style={{ background: "linear-gradient(100deg,#22d3ee,#67e8f9)" }}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#062330]/30 border-t-[#062330]" />}
      {children}
    </button>
  );
}

export function NbError({ children }: any) {
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
