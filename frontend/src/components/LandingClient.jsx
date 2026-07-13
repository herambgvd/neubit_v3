"use client";

// Landing page — Vercel-dark marketing surface with GSAP-driven motion:
//   • a hero entrance TIMELINE (eyebrow → headline → copy → CTAs → badges → console),
//   • ScrollTrigger.batch REVEALS for every section block as it enters the viewport,
//   • a scrubbed PARALLAX on the live console as you scroll past the hero.
// The live command-and-control console (ConsoleHero) keeps its own Framer Motion
// loops (video-wall shimmer, event feed, radar, count-ups) — GSAP owns page-level
// entrance + scroll; Framer owns the always-on micro-animation inside the console.
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
  Cloud,
  Cpu,
  Eye,
  Fingerprint,
  Flame,
  GitBranch,
  Globe2,
  LayoutGrid,
  Network,
  Radar,
  ServerCog,
  ShieldCheck,
  Siren,
  Sparkles,
  Workflow,
  Zap,
  Check,
} from "lucide-react";

import ConsoleHero from "@/components/landing/ConsoleHero";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/* Single restrained accent — emerald, used only for live/status/CTA. */
const ACCENT = "#10b981";

const NAV = [
  ["#what", "Platform"],
  ["#how", "How it works"],
  ["#architecture", "Architecture"],
  ["#use-cases", "Use cases"],
  ["#why-neubit", "Why Neubit"],
];

const PILLARS = [
  { icon: Eye, label: "Video Surveillance" },
  { icon: Fingerprint, label: "Access Control" },
  { icon: Radar, label: "Intrusion Detection" },
  { icon: Flame, label: "Fire & Life Safety" },
  { icon: Sparkles, label: "AI Video Analytics" },
  { icon: Workflow, label: "Workflow & BI" },
];

const IMPACTS = [
  ["Eliminate", "manual coordination between systems and teams"],
  ["Standardize", "operations across sites and environments"],
  ["Improve", "compliance, audit readiness, and reporting visibility"],
  ["Scale", "operations without increasing operational complexity"],
];

const FLOW = [
  { step: "01", title: "Input", body: "Cameras, sensors, access panels, fire systems, IoT devices.", icon: Cable },
  { step: "02", title: "Orchestration", body: "Event-driven processing engine with workflow automation.", icon: GitBranch },
  { step: "03", title: "Action", body: "Alerts, automated system triggers, dashboards, reporting.", icon: Zap },
];

const ARCHITECTURE = [
  { icon: ShieldCheck, title: "Unified Management System", body: "Identity, governance, and control across the estate." },
  { icon: ServerCog, title: "API Gateway", body: "Secure, centralized access layer for every subsystem." },
  { icon: Boxes, title: "Subsystem Modules", body: "Video, access, intrusion, fire, and analytics — independent yet integrated." },
  { icon: Network, title: "Event Bus", body: "Real-time system-to-system communication backbone." },
  { icon: Cpu, title: "Data & Intelligence", body: "Operational state, history, and decision insights." },
];

const CAPABILITIES = [
  { icon: LayoutGrid, title: "Single Operational View", body: "Eliminate multiple dashboards — complete visibility across systems and locations." },
  { icon: Workflow, title: "Automated Cross-System Response", body: "Trigger coordinated, multi-step actions across video, access, fire, and alerts instantly." },
  { icon: Activity, title: "Real-Time Decision Intelligence", body: "Convert live events into actionable outcomes — not just notifications." },
  { icon: Cable, title: "Seamless Integration", body: "Work with existing infrastructure — no rip-and-replace required." },
  { icon: Globe2, title: "Centralized Multi-Site Control", body: "Manage multiple facilities, cities, or clients from one command layer." },
  { icon: Cloud, title: "Flexible Deployment", body: "Cloud, hybrid, or fully on-premise environments." },
];

const MODULES = [
  "Video Management System (VMS)",
  "Access Control Integration",
  "Intrusion Detection",
  "Fire & Life Safety Systems",
  "AI Video Analytics Engine",
  "Workflow Automation Engine",
  "Business Intelligence & Reporting",
];

const COMPARISON = [
  ["Operating model", "Reactive monitoring", "System-driven execution"],
  ["Systems", "Disconnected dashboards", "Unified control layer"],
  ["Response", "Manual coordination", "Automated, multi-system actions"],
  ["Output", "Alerts & notifications", "Coordinated decisions"],
  ["Scale", "Linear with headcount", "Horizontal across sites"],
];

const USE_CASES = [
  ["Smart Cities", "Safe-city programs and metropolitan command centers."],
  ["Airports & Transit", "Aviation, rail, and transportation infrastructure."],
  ["Manufacturing", "Industrial operations and facility security."],
  ["Government", "Command centers and critical agencies."],
  ["Enterprise", "Distributed corporate security operations."],
  ["Critical Infrastructure", "Utilities, energy, and regulated environments."],
];

const RESPONSE_STEPS = [
  "Detection captured instantly",
  "Event processed through the platform",
  "Workflow triggers predefined response logic",
  "Multiple systems act simultaneously",
  "Operators receive full, real-time situational context",
];

const INTEGRATIONS = [
  "CCTV & Video Infrastructure",
  "Access Control Systems",
  "Fire & Alarm Panels",
  "IoT Devices & Sensors",
  "Enterprise Systems via APIs & Webhooks",
];

const DEPLOYMENTS = [
  { tag: "Cloud", title: "SaaS", body: "Rapid deployment, managed scale." },
  { tag: "Hybrid", title: "Edge + Cloud", body: "Edge performance with centralized control." },
  { tag: "On-Premise", title: "Sovereign", body: "Full control for regulated environments." },
];

const WHY = [
  "Replace siloed systems with a unified control architecture",
  "Automate response without increasing operational complexity",
  "Enable real-time, system-driven decision execution",
  "Maintain flexibility across deployment and infrastructure",
  "Future-proof operations with a scalable, extensible platform",
];

/* ------------------------------------------------------------------ */
/* Reusable primitives                                                 */
/* ------------------------------------------------------------------ */

/** Dotted-grid + radial-glow backdrop shared by sections. */
function GridBackdrop({ glow = false }) {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.6]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.045) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage:
            "radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 85%)",
        }}
      />
      {glow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 340px at 78% 8%, rgba(16,185,129,0.10), transparent 60%)," +
              "radial-gradient(700px 340px at 12% 90%, rgba(255,255,255,0.035), transparent 60%)",
          }}
        />
      )}
    </>
  );
}

/** Section — cohesive dark tones; `tone` only shifts the near-black shade. */
function Section({ id, tone = "base", children }) {
  const bg = tone === "raised" ? "bg-[#0d0d0f]" : "bg-[#0a0a0a]";
  return (
    <section id={id} className={`relative ${bg} text-white`}>
      <GridBackdrop />
      <div className="relative mx-auto max-w-7xl px-6 py-24 lg:py-28">{children}</div>
    </section>
  );
}

function Eyebrow({ children }) {
  return (
    <div className="inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-white/45">
      <span className="h-1 w-1 rounded-full" style={{ background: ACCENT }} />
      {children}
    </div>
  );
}

// The `reveal` class is what GSAP's ScrollTrigger.batch animates into view.
function SectionHeading({ eyebrow, title, description, center = true }) {
  return (
    <div className={`reveal max-w-3xl ${center ? "mx-auto text-center" : ""}`}>
      <div className={center ? "flex justify-center" : ""}>
        <Eyebrow>{eyebrow}</Eyebrow>
      </div>
      <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.9rem] lg:leading-[1.1]">
        {title}
      </h2>
      {description && (
        <p className="mt-5 text-lg leading-relaxed text-white/55">{description}</p>
      )}
    </div>
  );
}

/* Card shell — thin border, hover lift + accent edge. */
const cardBase =
  "rounded-xl border border-white/[0.08] bg-white/[0.015] transition-[transform,border-color,background-color] duration-300 hover:-translate-y-1 hover:border-white/[0.16]";

export default function LandingPage() {
  const root = useRef(null);

  useGSAP(
    () => {
      // Respect reduced-motion: reveal everything instantly, skip the choreography.
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        gsap.set(".reveal", { opacity: 1, y: 0 });
        return;
      }

      // ── Hero entrance timeline ──────────────────────────────────────────
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".hero-eyebrow", { y: 20, opacity: 0, duration: 0.6 })
        .from(".hero-title", { y: 30, opacity: 0, duration: 0.75 }, "-=0.3")
        .from(".hero-sub", { y: 20, opacity: 0, duration: 0.6 }, "-=0.45")
        .from(".hero-note", { y: 16, opacity: 0, duration: 0.5 }, "-=0.45")
        .from(".hero-cta", { y: 16, opacity: 0, duration: 0.5 }, "-=0.4")
        .from(".hero-badge", { y: 14, opacity: 0, stagger: 0.06, duration: 0.4 }, "-=0.3")
        .from(".hero-console", { y: 44, opacity: 0, duration: 0.9 }, "-=0.35");

      // ── Parallax: the console drifts GENTLY as you scroll past the hero. No
      // opacity fade — that was making the console look like it vanished. ───────
      gsap.to(".hero-console", {
        yPercent: 6,
        ease: "none",
        scrollTrigger: {
          trigger: ".hero-console",
          start: "top 30%",
          end: "bottom top",
          scrub: true,
        },
      });

      // ── Section reveals — batch each `.reveal` as it enters the viewport ──
      gsap.set(".reveal", { opacity: 0, y: 26 });
      ScrollTrigger.batch(".reveal", {
        start: "top 88%",
        once: true,
        onEnter: (els) =>
          gsap.to(els, {
            opacity: 1,
            y: 0,
            duration: 0.6,
            ease: "power2.out",
            stagger: 0.08,
            overwrite: true,
          }),
      });

      // First paint may land mid-scroll (deep link / refresh) — sync triggers.
      ScrollTrigger.refresh();
    },
    { scope: root },
  );

  return (
    <div ref={root} className="min-h-screen bg-[#0a0a0a] text-white antialiased selection:bg-emerald-500/20">
      {/* ============================= HERO ============================= */}
      <section className="relative overflow-hidden bg-[#0a0a0a]">
        {/* grid + radial glows */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.7]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage:
              "radial-gradient(ellipse 90% 80% at 50% 0%, black 40%, transparent 90%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(800px 460px at 85% -8%, rgba(16,185,129,0.14), transparent 60%)," +
              "radial-gradient(760px 420px at -8% 24%, rgba(255,255,255,0.04), transparent 60%)",
          }}
        />

        {/* NAV */}
        <header className="relative z-20 border-b border-white/[0.06]">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
            <Link href="/" className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-7 w-auto invert brightness-0" />
            </Link>
            <nav className="hidden items-center gap-8 text-sm text-white/55 md:flex">
              {NAV.map(([href, label]) => (
                <a key={href} href={href} className="transition-colors hover:text-white">
                  {label}
                </a>
              ))}
            </nav>
            <div className="flex items-center gap-3">
              <Link href="/login" className="hidden text-sm text-white/60 transition-colors hover:text-white sm:inline">
                Sign in
              </Link>
              <Link
                href="#cta"
                className="inline-flex items-center gap-1.5 rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90"
              >
                Book a Demo <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </header>

        <div className="relative z-10 mx-auto max-w-7xl px-6 pt-16 pb-24 lg:pt-20 lg:pb-28">
          {/* Centered headline block */}
          <div className="mx-auto max-w-4xl text-center">
            <div className="hero-eyebrow flex justify-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-3.5 py-1.5 font-mono text-[11px] tracking-wide text-white/60 backdrop-blur">
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full"
                  style={{ background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }}
                />
                UNIFIED COMMAND &amp; CONTROL PLATFORM
              </div>
            </div>

            <h1 className="hero-title mt-7 text-[3.1rem] font-semibold leading-[1.02] tracking-tight sm:text-6xl lg:text-[4.6rem]">
              Command. Control.{" "}
              <span style={{ color: ACCENT }}>Intelligence.</span>
            </h1>

            <p className="hero-sub mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/55">
              The intelligence layer for enterprise command &amp; control. Unify video, access,
              intrusion, fire, and analytics into a single operational layer — where every event
              triggers the right action instantly.
            </p>

            <p className="hero-note mt-4 font-mono text-sm text-white/40">
              Not a dashboard. <span className="text-white">A decision execution system.</span>
            </p>

            <div className="hero-cta mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="#cta"
                className="inline-flex items-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-medium text-black transition-colors hover:bg-white/90"
              >
                Book a Demo <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="#cta"
                className="inline-flex items-center gap-2 rounded-md border border-white/[0.12] bg-white/[0.02] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-white/[0.06]"
              >
                Talk to an Expert
              </Link>
            </div>

            {/* Capability pillars as badges */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-2.5">
              {PILLARS.map(({ icon: Icon, label }) => (
                <span
                  key={label}
                  className="hero-badge inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.025] px-3.5 py-1.5 font-mono text-xs text-white/65 backdrop-blur transition-colors hover:border-white/[0.2] hover:text-white"
                >
                  <Icon className="h-3.5 w-3.5" style={{ color: ACCENT }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Full-width live console */}
          <div className="hero-console mx-auto mt-16 max-w-6xl lg:mt-20">
            <ConsoleHero />
          </div>
        </div>
      </section>

      {/* ========================= POSITIONING ========================= */}
      <Section id="positioning" tone="base">
        <div className="reveal mx-auto max-w-4xl text-center">
          <div className="flex justify-center">
            <Eyebrow>Positioning</Eyebrow>
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl lg:text-[2.9rem] lg:leading-[1.1]">
            Fragmented systems don&apos;t fail technically — they fail{" "}
            <span style={{ color: ACCENT }}>operationally.</span>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-white/55">
            Disconnected tools, delayed response, and manual coordination create risk at scale. Neubit
            replaces passive monitoring with active, system-driven operations — a unified, event-driven
            control layer where systems respond together, in real time, without human dependency.
          </p>
        </div>
      </Section>

      {/* ========================= WHAT IS NEUBIT ====================== */}
      <Section id="what" tone="raised">
        <SectionHeading
          eyebrow="What is Neubit"
          title="A unified command & control platform."
          description="Neubit consolidates your entire physical security and operational ecosystem into a single, intelligent control interface."
        />
        <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map(({ icon: Icon, label }) => (
            <div key={label} className={`reveal group ${cardBase} p-6`}>
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03]"
                style={{ color: ACCENT }}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="mt-4 text-base font-medium text-white">{label}</div>
              <div className="mt-1 font-mono text-xs text-white/40">Integrated · Coordinated · Acted upon</div>
            </div>
          ))}
        </div>
        <p className="reveal mx-auto mt-10 max-w-2xl text-center text-sm text-white/45">
          Instead of switching between systems, your entire operation runs through one platform — where
          every event is captured, correlated, and acted upon instantly.
        </p>
      </Section>

      {/* ========================= BUSINESS IMPACT ===================== */}
      <Section id="impact" tone="base">
        <SectionHeading
          eyebrow="Business Impact"
          title="What this means for your organization."
          description="Reduce response time, improve coordination, and enable real-time control."
        />
        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-2">
          {IMPACTS.map(([verb, body]) => (
            <div key={verb} className="reveal bg-[#0a0a0a] p-8">
              <div className="font-mono text-xs font-medium uppercase tracking-[0.18em]" style={{ color: ACCENT }}>
                {verb}
              </div>
              <div className="mt-2 text-lg text-white/85">{body}</div>
            </div>
          ))}
        </div>
        <p className="reveal mt-10 text-center text-base text-white/55">
          Neubit turns operational data into <span className="font-medium text-white">real-time execution capability.</span>
        </p>
      </Section>

      {/* ========================= HOW IT WORKS ======================== */}
      <Section id="how" tone="raised">
        <SectionHeading
          eyebrow="How Neubit Works"
          title="From detection to decision — instantly."
          description="Input → Orchestration → Action. Every event flows through a centralized event backbone, ensuring immediate correlation and coordinated response."
        />
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {FLOW.map(({ step, title, body, icon: Icon }, i) => (
            <div key={step} className={`reveal relative ${cardBase} p-7`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs" style={{ color: ACCENT }}>{step}</span>
                <Icon className="h-5 w-5" style={{ color: ACCENT }} />
              </div>
              <div className="mt-6 text-xl font-medium text-white">{title}</div>
              <div className="mt-2 text-sm leading-relaxed text-white/55">{body}</div>
              {i < FLOW.length - 1 && (
                <div
                  className="absolute right-[-18px] top-1/2 hidden h-px w-9 lg:block"
                  style={{ background: `linear-gradient(90deg, ${ACCENT}88, transparent)` }}
                />
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* ========================= ARCHITECTURE ======================== */}
      <Section id="architecture" tone="base">
        <SectionHeading
          eyebrow="Platform Architecture"
          title="Built for real-time, multi-system orchestration."
          description="All systems operate as a single coordinated platform — not disconnected tools."
        />
        <div className="mt-14 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {ARCHITECTURE.map(({ icon: Icon, title, body }) => (
            <div key={title} className={`reveal ${cardBase} p-6`}>
              <Icon className="h-6 w-6" style={{ color: ACCENT }} />
              <div className="mt-4 text-base font-medium text-white">{title}</div>
              <div className="mt-1.5 text-sm leading-relaxed text-white/50">{body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ========================= CAPABILITIES ======================== */}
      <Section id="capabilities" tone="raised">
        <SectionHeading eyebrow="Key Capabilities" title="Control complexity without increasing it." />
        <div className="mt-14 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map(({ icon: Icon, title, body }) => (
            <div key={title} className={`reveal ${cardBase} p-6`}>
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-black/40"
                style={{ color: ACCENT }}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="mt-4 text-base font-medium text-white">{title}</div>
              <div className="mt-1.5 text-sm leading-relaxed text-white/50">{body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ========================= MODULES ============================= */}
      <Section id="modules" tone="base">
        <SectionHeading
          eyebrow="Platform Modules"
          title="Modular capabilities. Unified execution."
          description="Each module scales independently — yet operates together through a unified event-driven system."
        />
        <ul className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <li
              key={m}
              className="reveal flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.015] px-5 py-4 transition-colors hover:border-white/[0.16]"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }} />
              <span className="text-sm font-medium text-white/80">{m}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ========================= TRADITIONAL VS NEUBIT =============== */}
      <Section id="vs" tone="raised">
        <SectionHeading
          eyebrow="Traditional vs Neubit"
          title="From monitoring to command & control."
          description="Legacy systems generate alerts. Neubit executes decisions."
        />
        <div className="reveal mt-14 overflow-hidden rounded-xl border border-white/[0.08]">
          <div className="grid grid-cols-3 bg-white/[0.03] px-6 py-4 font-mono text-[11px] font-medium uppercase tracking-[0.15em] text-white/45">
            <div>Dimension</div>
            <div>Traditional</div>
            <div style={{ color: ACCENT }}>Neubit</div>
          </div>
          {COMPARISON.map(([dim, legacy, neubit], i) => (
            <div
              key={dim}
              className={`grid grid-cols-3 items-center border-t border-white/[0.06] px-6 py-5 text-sm ${
                i % 2 === 0 ? "bg-white/[0.012]" : "bg-transparent"
              }`}
            >
              <div className="font-medium text-white">{dim}</div>
              <div className="text-white/45">{legacy}</div>
              <div className="text-white/90">{neubit}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ========================= USE CASES =========================== */}
      <Section id="use-cases" tone="base">
        <SectionHeading eyebrow="Use Cases" title="Built for high-responsibility environments." />
        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map(([title, body]) => (
            <div key={title} className="reveal group bg-[#0a0a0a] p-7 transition-colors hover:bg-white/[0.02]">
              <div className="text-base font-medium text-white">{title}</div>
              <div className="mt-1.5 text-sm text-white/50">{body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ========================= REAL-WORLD RESPONSE ================= */}
      <Section id="response" tone="raised">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div className="reveal">
            <Eyebrow>Real-World Response</Eyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Coordinated action — executed in seconds.
            </h2>
            <p className="mt-4 leading-relaxed text-white/55">
              When a critical event occurs, response isn&apos;t managed manually — it&apos;s built into the system.
            </p>
          </div>
          <ol className="relative space-y-3">
            <div
              className="absolute left-[15px] top-3 bottom-3 w-px"
              style={{ background: `linear-gradient(to bottom, ${ACCENT}88, ${ACCENT}22, transparent)` }}
            />
            {RESPONSE_STEPS.map((step, i) => (
              <li key={step} className="reveal relative flex items-start gap-4">
                <div
                  className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-medium"
                  style={{ borderColor: `${ACCENT}55`, background: "rgba(16,185,129,0.08)", color: ACCENT }}
                >
                  0{i + 1}
                </div>
                <div className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.015] px-5 py-3.5 text-sm text-white/80">
                  {step}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* ========================= INTEGRATION ========================= */}
      <Section id="integration" tone="base">
        <SectionHeading
          eyebrow="Integration"
          title="Built to work with your existing ecosystem."
          description="No replacement. No disruption. Full interoperability."
        />
        <div className="mt-14 flex flex-wrap justify-center gap-3">
          {INTEGRATIONS.map((i) => (
            <span
              key={i}
              className="reveal rounded-full border border-white/[0.1] bg-white/[0.02] px-5 py-2.5 font-mono text-xs text-white/60 transition-colors hover:border-white/[0.2] hover:text-white"
            >
              {i}
            </span>
          ))}
        </div>
      </Section>

      {/* ========================= SCALABILITY ========================= */}
      <Section id="scalability" tone="raised">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div className="reveal">
            <Eyebrow>Scalability</Eyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Engineered for enterprise environments.
            </h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              "Multi-site, multi-region deployments",
              "High device and event throughput",
              "Horizontal scaling across modules",
              "Resilient, high-availability architecture",
            ].map((s) => (
              <li
                key={s}
                className="reveal flex items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.015] p-4 text-sm text-white/70"
              >
                <Siren className="mt-0.5 h-4 w-4 shrink-0" style={{ color: ACCENT }} />
                {s}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ========================= DEPLOYMENT ========================== */}
      <Section id="deployment" tone="base">
        <SectionHeading eyebrow="Deployment Options" title="One platform. Multiple deployment models." />
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {DEPLOYMENTS.map(({ tag, title, body }) => (
            <div key={tag} className={`reveal ${cardBase} p-7`}>
              <div className="font-mono text-xs font-medium uppercase tracking-[0.18em]" style={{ color: ACCENT }}>
                {tag}
              </div>
              <div className="mt-3 text-2xl font-semibold tracking-tight text-white">{title}</div>
              <div className="mt-2 text-sm leading-relaxed text-white/50">{body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ========================= WHY NEUBIT ========================== */}
      <Section id="why-neubit" tone="raised">
        <SectionHeading eyebrow="Why Neubit" title="Why enterprises choose Neubit." />
        <ul className="mt-14 grid gap-3 md:grid-cols-2">
          {WHY.map((w) => (
            <li key={w} className={`reveal flex items-start gap-4 ${cardBase} p-6 text-white/70`}>
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: `${ACCENT}55` }}>
                <Check className="h-3 w-3" style={{ color: ACCENT }} />
              </div>
              <div className="text-sm leading-relaxed">{w}</div>
            </li>
          ))}
        </ul>
      </Section>

      {/* ============================= CTA ============================= */}
      <section id="cta" className="relative overflow-hidden bg-[#0a0a0a] text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 400px at 50% 0%, rgba(16,185,129,0.14), transparent 60%)," +
              "radial-gradient(760px 460px at 50% 100%, rgba(255,255,255,0.04), transparent 60%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,0.045) 1px, transparent 1px)",
            backgroundSize: "26px 26px",
            maskImage: "radial-gradient(ellipse 70% 60% at 50% 40%, black 20%, transparent 80%)",
          }}
        />
        <div className="relative mx-auto max-w-5xl px-6 py-24 text-center lg:py-32">
          <div className="reveal mb-6 flex justify-center">
            <Eyebrow>Get Started</Eyebrow>
          </div>
          <h2 className="reveal text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Move from monitoring to{" "}
            <span style={{ color: ACCENT }}>command &amp; control.</span>
          </h2>
          <p className="reveal mx-auto mt-6 max-w-2xl text-lg text-white/55">
            Delayed decisions create risk. Fragmented systems create inefficiency. Neubit brings everything
            into one unified platform — so your operations can respond instantly.
          </p>
          <div className="reveal mt-10 flex flex-wrap justify-center gap-3">
            <Link
              href="#"
              className="inline-flex items-center gap-2 rounded-md bg-white px-6 py-3.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
            >
              Book a Demo <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="#"
              className="inline-flex items-center gap-2 rounded-md border border-white/[0.12] bg-white/[0.02] px-6 py-3.5 text-sm font-medium text-white transition-colors hover:bg-white/[0.06]"
            >
              Talk to an Expert
            </Link>
          </div>
        </div>
      </section>

      {/* ============================= FOOTER ========================== */}
      <footer className="border-t border-white/[0.08] bg-[#0a0a0a]">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-6 py-10 text-sm text-white/45 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-6 w-auto opacity-70 invert brightness-0" />
            <span>© {new Date().getFullYear()} Neubit. Unified Command &amp; Control Platform.</span>
          </div>
          <div className="flex flex-wrap gap-6">
            <Link href="/login" className="transition-colors hover:text-white">Sign in</Link>
            <a href="#what" className="transition-colors hover:text-white">Platform</a>
            <a href="#architecture" className="transition-colors hover:text-white">Architecture</a>
            <a href="#use-cases" className="transition-colors hover:text-white">Use cases</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
