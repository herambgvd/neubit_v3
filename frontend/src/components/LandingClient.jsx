"use client";

// Landing page — ground-up rebuild in a Verkada-class enterprise pattern, kept on
// our dark command-center identity. Structure: sticky glass nav → product-forward
// hero (live console in an app-window frame) → sectors trust strip → one-platform
// suite → alternating feature deep-dives → count-up stats band → industries →
// security & compliance → CTA → multi-column footer. Motion is GSAP: a hero
// entrance timeline, ScrollTrigger.batch reveals, count-ups, and a gentle console
// drift. The live console keeps its own Framer loops inside ConsoleHero.
import Link from "next/link";
import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import {
  ArrowRight,
  Activity,
  Boxes,
  Cable,
  Check,
  Cloud,
  Cpu,
  Eye,
  Fingerprint,
  Flame,
  Globe2,
  KeyRound,
  LayoutGrid,
  Lock,
  Network,
  Radar,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";

import ConsoleHero from "@/components/landing/ConsoleHero";

gsap.registerPlugin(ScrollTrigger, useGSAP);

const ACCENT = "#10b981";

const NAV = [
  ["#platform", "Platform"],
  ["#features", "How it works"],
  ["#industries", "Industries"],
  ["#security", "Security"],
  ["#why", "Why Neubit"],
];

const PILLARS = [
  { icon: Eye, label: "Video Surveillance", body: "Unified live + recorded video across every site and NVR." },
  { icon: Fingerprint, label: "Access Control", body: "Doors, cardholders and schedules on one control plane." },
  { icon: Radar, label: "Intrusion Detection", body: "Sensors and perimeter events correlated in real time." },
  { icon: Flame, label: "Fire & Life Safety", body: "Panels and alarms wired into coordinated response." },
  { icon: Sparkles, label: "AI Video Analytics", body: "Turn footage into events — search, counting, alerts." },
  { icon: Workflow, label: "Workflow & BI", body: "Automate multi-step response and report on everything." },
];

const SECTORS = [
  "Smart Cities",
  "Airports & Transit",
  "Manufacturing",
  "Government",
  "Enterprise",
  "Critical Infrastructure",
];

const FEATURES = [
  {
    eyebrow: "See everything, live",
    title: "One operational view across every system and site.",
    body:
      "Replace a wall of disconnected dashboards with a single command surface — live video, access, intrusion and fire, correlated on one screen for every location.",
    points: ["Multi-site video wall + patterns", "Live health across cameras & NVRs", "Spotlight, tour and shared control-room walls"],
    visual: "wall",
  },
  {
    eyebrow: "Act, don't just alert",
    title: "Every event triggers the right action — instantly.",
    body:
      "An event-driven engine correlates detections and runs coordinated, multi-step responses across systems: raise an incident, cue cameras, notify the right people, log it all.",
    points: ["Visual SOP + workflow automation", "Cross-system linkage rules", "Incidents with full situational context"],
    visual: "flow",
  },
  {
    eyebrow: "Command from anywhere",
    title: "Centralized control across cities, sites and clients.",
    body:
      "Run one facility or hundreds from a single layer — multi-tenant, resilient, and deployable in cloud, hybrid or fully on-premise for regulated environments.",
    points: ["Multi-site, multi-tenant control", "Cloud · hybrid · sovereign on-prem", "High-availability, horizontal scale"],
    visual: "map",
  },
];

const STATS = [
  { to: 512, label: "Cameras per node", fmt: (v) => Math.round(v).toLocaleString() },
  { to: 24, label: "Sites unified", fmt: (v) => Math.round(v) },
  { to: 1.8, label: "Avg response (s)", fmt: (v) => v.toFixed(1) },
  { to: 99.99, label: "Uptime target %", fmt: (v) => v.toFixed(2) },
];

const INDUSTRIES = [
  ["Smart Cities", "Safe-city programs and metropolitan command centers.", Globe2],
  ["Airports & Transit", "Aviation, rail and transportation infrastructure.", Network],
  ["Manufacturing", "Industrial operations and facility security.", Boxes],
  ["Government", "Command centers and critical agencies.", ShieldCheck],
  ["Enterprise", "Distributed corporate security operations.", LayoutGrid],
  ["Critical Infrastructure", "Utilities, energy and regulated environments.", Cpu],
];

const SECURITY = [
  { icon: Lock, label: "Encryption at rest & in transit" },
  { icon: KeyRound, label: "RBAC + 2FA / SSO / LDAP" },
  { icon: ScrollText, label: "Append-only audit trail" },
  { icon: ShieldCheck, label: "Tamper-proof signed export" },
  { icon: Cloud, label: "Sovereign on-prem option" },
  { icon: Activity, label: "Four-eyes dual authorization" },
];

const WHY = [
  "Replace siloed systems with a unified control architecture",
  "Automate response without adding operational complexity",
  "Enable real-time, system-driven decision execution",
  "Stay flexible across deployment and infrastructure",
  "Future-proof operations with a scalable, extensible platform",
  "Keep full ownership of your data and video",
];

const FOOTER = [
  ["Platform", [["Video Surveillance", "#platform"], ["Access Control", "#platform"], ["Intrusion & Fire", "#platform"], ["Workflow & BI", "#platform"]]],
  ["Solutions", [["Smart Cities", "#industries"], ["Airports & Transit", "#industries"], ["Enterprise", "#industries"], ["Government", "#industries"]]],
  ["Company", [["Why Neubit", "#why"], ["Security", "#security"], ["Book a demo", "#cta"], ["Sign in", "/login"]]],
];

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */
function Eyebrow({ children, className = "" }) {
  return (
    <div className={`inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-white/45 ${className}`}>
      <span className="h-1 w-1 rounded-full" style={{ background: ACCENT }} />
      {children}
    </div>
  );
}

const cardBase =
  "rounded-2xl border border-white/[0.08] bg-white/[0.02] transition-[transform,border-color,background-color] duration-300 hover:-translate-y-1 hover:border-white/[0.16]";

// Browser/app chrome frame around the live console — makes the product feel real.
function AppWindow({ children }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0b0b0d] shadow-[0_50px_140px_-40px_rgba(0,0,0,0.95)]">
      <div className="flex items-center gap-3 border-b border-white/[0.07] bg-white/[0.02] px-4 py-2.5">
        <div className="flex gap-1.5">
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c, opacity: 0.6 }} />
          ))}
        </div>
        <div className="mx-auto flex items-center gap-2 rounded-md bg-white/[0.04] px-3 py-1 font-mono text-[10px] text-white/40">
          <Lock className="h-2.5 w-2.5" />
          neubit.command/live
        </div>
        <span className="hidden font-mono text-[10px] text-white/30 sm:block">C2</span>
      </div>
      {children}
    </div>
  );
}

/* Feature-row visuals — lightweight framed panels (CSS/SVG, no framer). */
function FeatureVisual({ kind }) {
  if (kind === "wall") {
    return (
      <div className="rounded-xl border border-white/[0.08] bg-[#08080a] p-3">
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="relative aspect-video overflow-hidden rounded-md border border-white/[0.06] bg-gradient-to-br from-[#161619] to-[#0a0a0b]">
              <span className="absolute left-1.5 top-1.5 flex items-center gap-1">
                <span className="h-1 w-1 animate-pulse rounded-full" style={{ background: ACCENT }} />
                <span className="font-mono text-[6px] tracking-wider text-white/50">LIVE</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "flow") {
    const rows = [
      ["#f59e0b", "MOTION", "Gate 3"],
      ["#ef4444", "INTRUSION", "Perimeter"],
      ["#10b981", "ACCESS", "Lobby"],
    ];
    return (
      <div className="rounded-xl border border-white/[0.08] bg-[#08080a] p-4">
        <div className="space-y-2">
          {rows.map(([c, tag, loc]) => (
            <div key={tag} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />
              <span className="font-mono text-[11px] text-white/70">{tag}</span>
              <span className="ml-auto font-mono text-[10px] text-white/40">{loc}</span>
            </div>
          ))}
        </div>
        <div className="my-3 flex items-center justify-center text-white/30">
          <div className="h-4 w-px bg-white/15" />
        </div>
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2.5" style={{ borderColor: `${ACCENT}44`, background: "rgba(16,185,129,0.06)" }}>
          <Zap className="h-3.5 w-3.5" style={{ color: ACCENT }} />
          <span className="font-mono text-[11px]" style={{ color: ACCENT }}>WORKFLOW → incident · cue cameras · notify</span>
        </div>
      </div>
    );
  }
  // map
  const blips = [[30, 40], [64, 28], [76, 66], [46, 72], [58, 50]];
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#08080a] p-4">
      <svg viewBox="0 0 100 72" className="h-full w-full">
        {[46, 32, 18].map((r) => (
          <circle key={r} cx="50" cy="40" r={r * 0.7} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.3" />
        ))}
        {blips.map(([x, y], i) => (
          <g key={i}>
            <line x1="50" y1="40" x2={x} y2={y} stroke="rgba(16,185,129,0.25)" strokeWidth="0.3" />
            <circle cx={x} cy={y} r="1.4" fill={i === 3 ? "#ef4444" : ACCENT} />
          </g>
        ))}
        <circle cx="50" cy="40" r="2" fill={ACCENT} />
      </svg>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-white/40">
        <span>SITES · 24</span>
        <span className="flex items-center gap-1"><span className="h-1 w-1 rounded-full" style={{ background: ACCENT }} /> all reporting</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
export default function LandingPage() {
  const root = useRef(null);

  useGSAP(
    () => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        gsap.set(".reveal", { opacity: 1, y: 0 });
        return;
      }

      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".hero-eyebrow", { y: 20, opacity: 0, duration: 0.6 })
        .from(".hero-title", { y: 30, opacity: 0, duration: 0.75 }, "-=0.3")
        .from(".hero-sub", { y: 20, opacity: 0, duration: 0.6 }, "-=0.45")
        .from(".hero-cta", { y: 16, opacity: 0, duration: 0.5 }, "-=0.4")
        .from(".hero-badge", { y: 14, opacity: 0, stagger: 0.05, duration: 0.4 }, "-=0.3")
        .from(".hero-window", { y: 48, opacity: 0, duration: 0.95 }, "-=0.3");

      // Gentle console drift (no opacity fade — it must never look like it vanished).
      gsap.to(".hero-window", {
        yPercent: 5,
        ease: "none",
        scrollTrigger: { trigger: ".hero-window", start: "top 20%", end: "bottom top", scrub: true },
      });

      gsap.set(".reveal", { opacity: 0, y: 26 });
      ScrollTrigger.batch(".reveal", {
        start: "top 88%",
        once: true,
        onEnter: (els) =>
          gsap.to(els, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out", stagger: 0.08, overwrite: true }),
      });

      // Count-up stats on enter.
      gsap.utils.toArray(".stat-num").forEach((el) => {
        const to = parseFloat(el.dataset.to);
        const dec = parseInt(el.dataset.dec || "0", 10);
        const obj = { v: 0 };
        ScrollTrigger.create({
          trigger: el,
          start: "top 90%",
          once: true,
          onEnter: () =>
            gsap.to(obj, {
              v: to,
              duration: 1.6,
              ease: "power2.out",
              onUpdate: () => {
                el.textContent = dec
                  ? obj.v.toFixed(dec)
                  : Math.round(obj.v).toLocaleString();
              },
            }),
        });
      });

      ScrollTrigger.refresh();
    },
    { scope: root },
  );

  return (
    <div ref={root} className="min-h-screen bg-[#0a0a0a] text-white antialiased selection:bg-emerald-500/20">
      {/* ── Sticky glass nav ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#0a0a0a]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-7 w-auto invert brightness-0" />
          </Link>
          <nav className="hidden items-center gap-8 text-sm text-white/55 md:flex">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} className="transition-colors hover:text-white">{label}</a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="hidden text-sm text-white/60 transition-colors hover:text-white sm:inline">Sign in</Link>
            <Link href="#cta" className="inline-flex items-center gap-1.5 rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90">
              Book a Demo <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.7]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.026) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.026) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse 90% 80% at 50% 0%, black 40%, transparent 90%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(900px 500px at 50% -12%, rgba(16,185,129,0.14), transparent 60%)," +
              "radial-gradient(700px 420px at 12% 20%, rgba(255,255,255,0.035), transparent 60%)",
          }}
        />
        <div className="relative mx-auto max-w-7xl px-6 pt-20 pb-16 text-center lg:pt-24">
          <div className="hero-eyebrow flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-3.5 py-1.5 font-mono text-[11px] tracking-wide text-white/60 backdrop-blur">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }} />
              UNIFIED COMMAND &amp; CONTROL PLATFORM
            </div>
          </div>

          <h1 className="hero-title mx-auto mt-7 max-w-4xl text-[3.1rem] font-semibold leading-[1.02] tracking-tight sm:text-6xl lg:text-[4.6rem]">
            Command. Control. <span style={{ color: ACCENT }}>Intelligence.</span>
          </h1>
          <p className="hero-sub mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/55">
            The intelligence layer for enterprise physical security. Unify video, access, intrusion,
            fire and analytics into one operational layer — where every event triggers the right
            action, instantly.
          </p>

          <div className="hero-cta mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="#cta" className="inline-flex items-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-medium text-black transition-colors hover:bg-white/90">
              Book a Demo <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="#features" className="inline-flex items-center gap-2 rounded-md border border-white/[0.12] bg-white/[0.02] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-white/[0.06]">
              See how it works
            </Link>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            {PILLARS.map(({ icon: Icon, label }) => (
              <span key={label} className="hero-badge inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.025] px-3 py-1.5 font-mono text-[11px] text-white/60 backdrop-blur">
                <Icon className="h-3.5 w-3.5" style={{ color: ACCENT }} />
                {label}
              </span>
            ))}
          </div>

          {/* Product, framed */}
          <div className="hero-window mx-auto mt-16 max-w-6xl">
            <AppWindow>
              <ConsoleHero />
            </AppWindow>
          </div>
        </div>
      </section>

      {/* ── Sectors trust strip ── */}
      <section className="border-y border-white/[0.06] bg-[#0c0c0e]">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <p className="reveal text-center font-mono text-[11px] uppercase tracking-[0.2em] text-white/35">
            Built for high-responsibility environments
          </p>
          <div className="reveal mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
            {SECTORS.map((s) => (
              <span key={s} className="font-mono text-sm text-white/40 transition-colors hover:text-white/70">{s}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ── One platform (suite) ── */}
      <section id="platform" className="relative bg-[#0a0a0a]">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:py-28">
          <div className="reveal mx-auto max-w-3xl text-center">
            <div className="flex justify-center"><Eyebrow>One platform</Eyebrow></div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl lg:text-[2.9rem] lg:leading-[1.1]">
              Every system, on one control plane.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/55">
              Neubit consolidates your entire physical-security estate into a single, intelligent
              interface — no more switching between disconnected tools.
            </p>
          </div>
          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, label, body }) => (
              <div key={label} className={`reveal ${cardBase} p-6`}>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03]" style={{ color: ACCENT }}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="mt-4 text-base font-medium text-white">{label}</div>
                <div className="mt-1.5 text-sm leading-relaxed text-white/50">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Feature deep-dives (alternating) ── */}
      <section id="features" className="relative bg-[#0d0d0f]">
        <div className="mx-auto max-w-7xl space-y-20 px-6 py-24 lg:space-y-28 lg:py-28">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
              <div className={`reveal ${i % 2 === 1 ? "lg:order-2" : ""}`}>
                <Eyebrow>{f.eyebrow}</Eyebrow>
                <h3 className="mt-4 text-2xl font-semibold tracking-tight text-white sm:text-3xl lg:text-[2.1rem] lg:leading-[1.15]">
                  {f.title}
                </h3>
                <p className="mt-4 leading-relaxed text-white/55">{f.body}</p>
                <ul className="mt-6 space-y-2.5">
                  {f.points.map((p) => (
                    <li key={p} className="flex items-center gap-3 text-sm text-white/75">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: `${ACCENT}55` }}>
                        <Check className="h-3 w-3" style={{ color: ACCENT }} />
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`reveal ${i % 2 === 1 ? "lg:order-1" : ""}`}>
                <FeatureVisual kind={f.visual} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Stats band ── */}
      <section className="relative overflow-hidden bg-[#0a0a0a]">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(700px 300px at 50% 120%, rgba(16,185,129,0.10), transparent 60%)" }} />
        <div className="relative mx-auto max-w-7xl px-6 py-20">
          <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
            {STATS.map((s) => {
              const dec = s.label.includes("%") ? 2 : s.label.includes("(s)") ? 1 : 0;
              return (
                <div key={s.label} className="reveal text-center">
                  <div className="font-mono text-4xl font-semibold tabular-nums text-white sm:text-5xl">
                    <span className="stat-num" data-to={s.to} data-dec={dec}>0</span>
                  </div>
                  <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-white/40">{s.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Industries ── */}
      <section id="industries" className="relative bg-[#0d0d0f]">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:py-28">
          <div className="reveal mx-auto max-w-3xl text-center">
            <div className="flex justify-center"><Eyebrow>Industries</Eyebrow></div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl lg:text-[2.9rem] lg:leading-[1.1]">
              Trusted where response time matters most.
            </h2>
          </div>
          <div className="mt-14 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {INDUSTRIES.map(([title, body, Icon]) => (
              <div key={title} className={`reveal ${cardBase} p-6`}>
                <Icon className="h-6 w-6" style={{ color: ACCENT }} />
                <div className="mt-4 text-base font-medium text-white">{title}</div>
                <div className="mt-1.5 text-sm leading-relaxed text-white/50">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security & compliance ── */}
      <section id="security" className="relative bg-[#0a0a0a]">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div className="reveal">
              <Eyebrow>Security &amp; compliance</Eyebrow>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.5rem] lg:leading-[1.1]">
                Enterprise-grade by default. Your data, your control.
              </h2>
              <p className="mt-5 leading-relaxed text-white/55">
                Hardened for regulated environments — encryption, granular access control, full
                auditability and tamper-proof evidence, with a fully sovereign on-premise option.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {SECURITY.map(({ icon: Icon, label }) => (
                <div key={label} className="reveal flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-black/40" style={{ color: ACCENT }}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm text-white/75">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Why Neubit ── */}
      <section id="why" className="relative bg-[#0d0d0f]">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:py-28">
          <div className="reveal mx-auto max-w-3xl text-center">
            <div className="flex justify-center"><Eyebrow>Why Neubit</Eyebrow></div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl lg:text-[2.9rem] lg:leading-[1.1]">
              From monitoring to command &amp; control.
            </h2>
          </div>
          <ul className="mt-14 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {WHY.map((w) => (
              <li key={w} className={`reveal flex items-start gap-4 ${cardBase} p-6 text-white/70`}>
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: `${ACCENT}55` }}>
                  <Check className="h-3 w-3" style={{ color: ACCENT }} />
                </div>
                <div className="text-sm leading-relaxed">{w}</div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── CTA ── */}
      <section id="cta" className="relative overflow-hidden bg-[#0a0a0a] text-white">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(700px 400px at 50% 0%, rgba(16,185,129,0.16), transparent 60%)" }} />
        <div className="relative mx-auto max-w-5xl px-6 py-24 text-center lg:py-32">
          <h2 className="reveal text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Move from monitoring to <span style={{ color: ACCENT }}>command &amp; control.</span>
          </h2>
          <p className="reveal mx-auto mt-6 max-w-2xl text-lg text-white/55">
            Fragmented systems create risk and inefficiency. Neubit brings everything into one unified
            platform — so your operations respond instantly.
          </p>
          <div className="reveal mt-10 flex flex-wrap justify-center gap-3">
            <Link href="#" className="inline-flex items-center gap-2 rounded-md bg-white px-6 py-3.5 text-sm font-medium text-black transition-colors hover:bg-white/90">
              Book a Demo <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="#" className="inline-flex items-center gap-2 rounded-md border border-white/[0.12] bg-white/[0.02] px-6 py-3.5 text-sm font-medium text-white transition-colors hover:bg-white/[0.06]">
              Talk to an Expert
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.08] bg-[#0a0a0a]">
        <div className="mx-auto max-w-7xl px-6 py-14">
          <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-7 w-auto opacity-80 invert brightness-0" />
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/45">
                The unified command &amp; control platform for enterprise physical security.
              </p>
            </div>
            {FOOTER.map(([title, links]) => (
              <div key={title}>
                <div className="font-mono text-[11px] font-medium uppercase tracking-[0.15em] text-white/40">{title}</div>
                <ul className="mt-4 space-y-2.5">
                  {links.map(([label, href]) => (
                    <li key={label}>
                      {href.startsWith("/") ? (
                        <Link href={href} className="text-sm text-white/55 transition-colors hover:text-white">{label}</Link>
                      ) : (
                        <a href={href} className="text-sm text-white/55 transition-colors hover:text-white">{label}</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-white/[0.06] pt-6 text-xs text-white/35 md:flex-row md:items-center">
            <span>© {new Date().getFullYear()} Neubit. Unified Command &amp; Control Platform.</span>
            <span className="font-mono">Command · Control · Intelligence</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
