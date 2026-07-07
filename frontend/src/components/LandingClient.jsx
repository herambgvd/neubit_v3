"use client";

import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
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
} from "lucide-react";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

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

function HeroVisual() {
  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900/60 to-slate-950/60 backdrop-blur">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.5) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
        {[Eye, Fingerprint, Radar, Flame, Sparkles, Cable, Network, Workflow, Activity].map((Icon, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.06, duration: 0.5 }}
            viewport={{ once: true }}
            className="flex items-center justify-center"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-cyan-300 shadow-[0_0_40px_rgba(34,211,238,0.08)]">
              <Icon className="h-6 w-6" />
            </div>
          </motion.div>
        ))}
      </div>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 420" fill="none">
        <defs>
          <linearGradient id="line" x1="0" x2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
            <stop offset="50%" stopColor="#6366f1" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[
          "M100,70 C 250,70 350,210 500,210",
          "M100,210 C 250,210 350,350 500,350",
          "M100,350 C 250,350 350,210 500,70",
          "M100,210 C 250,210 350,70 500,70",
        ].map((d, i) => (
          <motion.path
            key={i}
            d={d}
            stroke="url(#line)"
            strokeWidth="1.5"
            initial={{ pathLength: 0, opacity: 0 }}
            whileInView={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1.6, delay: 0.3 + i * 0.2, ease: "easeInOut" }}
            viewport={{ once: true }}
          />
        ))}
      </svg>
      <motion.div
        className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-cyan-400/30 to-indigo-500/30 blur-2xl"
        animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0.9, 0.6] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

function Section({ id, tone = "white", children }) {
  const bg =
    tone === "dark"
      ? "bg-[#050814] text-white"
      : tone === "slate"
      ? "bg-slate-50 text-slate-900"
      : "bg-white text-slate-900";
  return (
    <section id={id} className={`relative ${bg}`}>
      {tone === "dark" && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />
      )}
      <div className="relative mx-auto max-w-7xl px-6 py-24 lg:py-28">{children}</div>
    </section>
  );
}

function SectionHeading({ eyebrow, title, description, dark = false }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <div className={`text-xs font-semibold uppercase tracking-[0.2em] ${dark ? "text-cyan-300" : "text-indigo-600"}`}>
        {eyebrow}
      </div>
      <h2 className={`mt-4 text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight ${dark ? "text-white" : "text-slate-900"}`}>
        {title}
      </h2>
      {description && (
        <p className={`mt-5 text-lg leading-relaxed ${dark ? "text-slate-300" : "text-slate-600"}`}>{description}</p>
      )}
    </div>
  );
}

export default function LandingPage() {
  const heroRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  const heroOpacity = useTransform(scrollYProgress, [0, 1], [1, 0.2]);

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* DARK CINEMATIC HERO */}
      <section ref={heroRef} className="relative overflow-hidden bg-[#050814] text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(900px 500px at 80% -10%, rgba(34,211,238,0.18), transparent 60%)," +
              "radial-gradient(900px 500px at -10% 30%, rgba(99,102,241,0.22), transparent 60%)," +
              "radial-gradient(700px 400px at 50% 110%, rgba(99,102,241,0.18), transparent 60%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />

        <header className="relative z-20">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
            <Link href="/" className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-7 w-auto invert brightness-0" />
            </Link>
            <nav className="hidden md:flex items-center gap-7 text-sm text-slate-300">
              {NAV.map(([href, label]) => (
                <a key={href} href={href} className="hover:text-white transition">
                  {label}
                </a>
              ))}
            </nav>
            <div className="flex items-center gap-3">
              <Link href="/login" className="hidden sm:inline text-sm text-slate-300 hover:text-white transition">
                Sign in
              </Link>
              <Link
                href="#cta"
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100 transition"
              >
                Book a Demo <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </header>

        <motion.div
          style={{ y: heroY, opacity: heroOpacity }}
          className="relative z-10 mx-auto max-w-7xl px-6 pt-20 pb-28 lg:pt-28 lg:pb-36"
        >
          <motion.div initial="hidden" animate="show" variants={stagger} className="grid gap-14 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div>
              <motion.div variants={fadeUp} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1 text-xs font-medium text-cyan-200 backdrop-blur">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
                Unified Command & Control Platform
              </motion.div>

              <motion.h1 variants={fadeUp} className="mt-6 text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
                Command.{" "}
                <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-cyan-300 bg-clip-text text-transparent">
                  Control.
                </span>{" "}
                Intelligence.
              </motion.h1>

              <motion.p variants={fadeUp} className="mt-6 max-w-xl text-lg text-slate-300 leading-relaxed">
                The intelligence layer for enterprise command & control. Unify video, access, intrusion,
                fire, and analytics into a single operational layer — where every event triggers the right
                action instantly.
              </motion.p>

              <motion.p variants={fadeUp} className="mt-4 text-sm text-slate-400">
                Not a dashboard. <span className="text-white">A decision execution system.</span>
              </motion.p>

              <motion.div variants={fadeUp} className="mt-10 flex flex-wrap items-center gap-3">
                <Link href="#cta" className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-100 transition">
                  Book a Demo <ArrowRight className="h-4 w-4" />
                </Link>
                <Link href="#cta" className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-semibold text-white hover:bg-white/[0.08] transition">
                  Talk to an Expert
                </Link>
              </motion.div>

              <motion.div variants={fadeUp} className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-slate-400">
                {PILLARS.map(({ icon: Icon, label }) => (
                  <div key={label} className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-cyan-300" />
                    {label}
                  </div>
                ))}
              </motion.div>
            </div>

            <motion.div variants={fadeUp}>
              <HeroVisual />
            </motion.div>
          </motion.div>
        </motion.div>

      </section>

      {/* POSITIONING */}
      <Section id="positioning" tone="white">
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-100px" }} variants={stagger} className="mx-auto max-w-4xl text-center">
          <motion.div variants={fadeUp} className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">
            Positioning
          </motion.div>
          <motion.h2 variants={fadeUp} className="mt-4 text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900">
            Fragmented systems don&apos;t fail technically — they fail{" "}
            <span className="bg-gradient-to-r from-indigo-600 to-cyan-500 bg-clip-text text-transparent">operationally.</span>
          </motion.h2>
          <motion.p variants={fadeUp} className="mt-6 text-lg text-slate-600 leading-relaxed">
            Disconnected tools, delayed response, and manual coordination create risk at scale. Neubit
            replaces passive monitoring with active, system-driven operations — a unified, event-driven
            control layer where systems respond together, in real time, without human dependency.
          </motion.p>
        </motion.div>
      </Section>

      {/* WHAT IS NEUBIT */}
      <Section id="what" tone="slate">
        <SectionHeading
          eyebrow="What is Neubit"
          title="A unified command & control platform."
          description="Neubit consolidates your entire physical security and operational ecosystem into a single, intelligent control interface."
        />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map(({ icon: Icon, label }) => (
            <motion.div key={label} variants={fadeUp} whileHover={{ y: -4 }} className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-white">
                <Icon className="h-5 w-5" />
              </div>
              <div className="mt-4 text-base font-semibold text-slate-900">{label}</div>
              <div className="mt-1 text-sm text-slate-500">Integrated. Coordinated. Acted upon.</div>
            </motion.div>
          ))}
        </motion.div>
        <p className="mt-10 text-center text-sm text-slate-500">
          Instead of switching between systems, your entire operation runs through one platform — where
          every event is captured, correlated, and acted upon instantly.
        </p>
      </Section>

      {/* BUSINESS IMPACT */}
      <Section id="impact" tone="white">
        <SectionHeading
          eyebrow="Business Impact"
          title="What this means for your organization."
          description="Reduce response time, improve coordination, and enable real-time control."
        />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-slate-200 bg-slate-200 sm:grid-cols-2">
          {IMPACTS.map(([verb, body]) => (
            <motion.div key={verb} variants={fadeUp} className="bg-white p-8">
              <div className="text-sm font-semibold uppercase tracking-wider text-indigo-600">{verb}</div>
              <div className="mt-2 text-lg text-slate-900">{body}</div>
            </motion.div>
          ))}
        </motion.div>
        <p className="mt-10 text-center text-base text-slate-600">
          Neubit turns operational data into <span className="font-semibold text-slate-900">real-time execution capability.</span>
        </p>
      </Section>

      {/* HOW IT WORKS */}
      <Section id="how" tone="dark">
        <SectionHeading
          eyebrow="How Neubit Works"
          title="From detection to decision — instantly."
          description="Input → Orchestration → Action. Every event flows through a centralized event backbone, ensuring immediate correlation and coordinated response."
          dark
        />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-14 grid gap-6 lg:grid-cols-3">
          {FLOW.map(({ step, title, body, icon: Icon }, i) => (
            <motion.div key={step} variants={fadeUp} className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-7 backdrop-blur">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-cyan-300">{step}</span>
                <Icon className="h-5 w-5 text-cyan-300" />
              </div>
              <div className="mt-6 text-xl font-semibold text-white">{title}</div>
              <div className="mt-2 text-sm text-slate-300 leading-relaxed">{body}</div>
              {i < FLOW.length - 1 && (
                <div className="hidden lg:block absolute right-[-22px] top-1/2 h-px w-10 bg-gradient-to-r from-cyan-400/60 to-transparent" />
              )}
            </motion.div>
          ))}
        </motion.div>
      </Section>

      {/* ARCHITECTURE */}
      <Section id="architecture" tone="white">
        <SectionHeading
          eyebrow="Platform Architecture"
          title="Built for real-time, multi-system orchestration."
          description="All systems operate as a single coordinated platform — not disconnected tools."
        />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ARCHITECTURE.map(({ icon: Icon, title, body }) => (
            <motion.div key={title} variants={fadeUp} whileHover={{ y: -4 }} className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 transition hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50">
              <Icon className="h-6 w-6 text-indigo-600" />
              <div className="mt-4 text-base font-semibold text-slate-900">{title}</div>
              <div className="mt-1.5 text-sm text-slate-600 leading-relaxed">{body}</div>
            </motion.div>
          ))}
        </motion.div>
      </Section>

      {/* KEY CAPABILITIES */}
      <Section id="capabilities" tone="slate">
        <SectionHeading eyebrow="Key Capabilities" title="Control complexity without increasing it." />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map(({ icon: Icon, title, body }) => (
            <motion.div key={title} variants={fadeUp} whileHover={{ y: -4 }} className="rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-cyan-400 hover:shadow-lg">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-cyan-300">
                <Icon className="h-5 w-5" />
              </div>
              <div className="mt-4 text-base font-semibold text-slate-900">{title}</div>
              <div className="mt-1.5 text-sm text-slate-600 leading-relaxed">{body}</div>
            </motion.div>
          ))}
        </motion.div>
      </Section>

      {/* MODULES */}
      <Section id="modules" tone="white">
        <SectionHeading
          eyebrow="Platform Modules"
          title="Modular capabilities. Unified execution."
          description="Each module scales independently — yet operates together through a unified event-driven system."
        />
        <motion.ul initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <motion.li key={m} variants={fadeUp} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 hover:border-indigo-300 transition">
              <span className="h-2 w-2 rounded-full bg-gradient-to-r from-indigo-500 to-cyan-500" />
              <span className="text-sm font-medium text-slate-800">{m}</span>
            </motion.li>
          ))}
        </motion.ul>
      </Section>

      {/* TRADITIONAL VS NEUBIT */}
      <Section id="vs" tone="dark">
        <SectionHeading
          eyebrow="Traditional vs Neubit"
          title="From monitoring to command & control."
          description="Legacy systems generate alerts. Neubit executes decisions."
          dark
        />
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} transition={{ duration: 0.6 }} className="mt-12 overflow-hidden rounded-3xl border border-white/10">
          <div className="grid grid-cols-3 bg-white/[0.04] px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <div>Dimension</div>
            <div>Traditional</div>
            <div className="text-cyan-300">Neubit</div>
          </div>
          {COMPARISON.map(([dim, legacy, neubit], i) => (
            <div key={dim} className={`grid grid-cols-3 items-center px-6 py-5 text-sm ${i % 2 === 0 ? "bg-white/[0.02]" : "bg-transparent"}`}>
              <div className="font-medium text-white">{dim}</div>
              <div className="text-slate-400">{legacy}</div>
              <div className="text-cyan-200">{neubit}</div>
            </div>
          ))}
        </motion.div>
      </Section>

      {/* USE CASES */}
      <Section id="use-cases" tone="white">
        <SectionHeading eyebrow="Use Cases" title="Built for high-responsibility environments." />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map(([title, body]) => (
            <motion.div key={title} variants={fadeUp} className="group bg-white p-7 transition hover:bg-slate-50">
              <div className="text-base font-semibold text-slate-900">{title}</div>
              <div className="mt-1.5 text-sm text-slate-600">{body}</div>
            </motion.div>
          ))}
        </motion.div>
      </Section>

      {/* REAL-WORLD RESPONSE */}
      <Section id="response" tone="slate">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Real-World Response</div>
            <h2 className="mt-4 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Coordinated action — executed in seconds.
            </h2>
            <p className="mt-4 text-slate-600 leading-relaxed">
              When a critical event occurs, response isn&apos;t managed manually — it&apos;s built into the system.
            </p>
          </div>
          <motion.ol initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="relative space-y-4">
            <div className="absolute left-[19px] top-2 bottom-2 w-px bg-gradient-to-b from-indigo-300 via-cyan-300 to-transparent" />
            {RESPONSE_STEPS.map((step, i) => (
              <motion.li key={step} variants={fadeUp} className="relative flex items-start gap-4">
                <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-cyan-500 text-xs font-mono font-semibold text-white shadow-md shadow-indigo-200">
                  0{i + 1}
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-800 flex-1">
                  {step}
                </div>
              </motion.li>
            ))}
          </motion.ol>
        </div>
      </Section>

      {/* INTEGRATION */}
      <Section id="integration" tone="white">
        <SectionHeading
          eyebrow="Integration"
          title="Built to work with your existing ecosystem."
          description="No replacement. No disruption. Full interoperability."
        />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 flex flex-wrap justify-center gap-3">
          {INTEGRATIONS.map((i) => (
            <motion.span key={i} variants={fadeUp} className="rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:border-indigo-400 hover:text-indigo-700 transition">
              {i}
            </motion.span>
          ))}
        </motion.div>
      </Section>

      {/* SCALABILITY */}
      <Section id="scalability" tone="slate">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Scalability</div>
            <h2 className="mt-4 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
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
              <li key={s} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
                <Siren className="h-4 w-4 mt-0.5 text-cyan-600 shrink-0" />
                {s}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* DEPLOYMENT */}
      <Section id="deployment" tone="white">
        <SectionHeading eyebrow="Deployment Options" title="One platform. Multiple deployment models." />
        <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-5 lg:grid-cols-3">
          {DEPLOYMENTS.map(({ tag, title, body }) => (
            <motion.div key={tag} variants={fadeUp} whileHover={{ y: -6 }} className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-7 transition hover:border-indigo-400 hover:shadow-xl">
              <div className="text-xs font-semibold uppercase tracking-wider text-indigo-600">{tag}</div>
              <div className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">{title}</div>
              <div className="mt-2 text-sm text-slate-600 leading-relaxed">{body}</div>
            </motion.div>
          ))}
        </motion.div>
      </Section>

      {/* WHY NEUBIT */}
      <Section id="why-neubit" tone="dark">
        <SectionHeading eyebrow="Why Neubit" title="Why enterprises choose Neubit." dark />
        <motion.ul initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} variants={stagger} className="mt-12 grid gap-4 md:grid-cols-2">
          {WHY.map((w, i) => (
            <motion.li key={w} variants={fadeUp} className="flex items-start gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-slate-200 backdrop-blur">
              <div className="font-mono text-xs text-cyan-300">0{i + 1}</div>
              <div className="text-sm leading-relaxed">{w}</div>
            </motion.li>
          ))}
        </motion.ul>
      </Section>

      {/* CTA */}
      <section id="cta" className="relative overflow-hidden bg-[#050814] text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 400px at 50% 0%, rgba(34,211,238,0.22), transparent 60%)," +
              "radial-gradient(800px 500px at 50% 100%, rgba(99,102,241,0.22), transparent 60%)",
          }}
        />
        <div className="relative mx-auto max-w-5xl px-6 py-24 text-center lg:py-32">
          <motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }} className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight">
            Move from monitoring to{" "}
            <span className="bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">
              command & control.
            </span>
          </motion.h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-300">
            Delayed decisions create risk. Fragmented systems create inefficiency. Neubit brings everything
            into one unified platform — so your operations can respond instantly.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href="#" className="inline-flex items-center gap-2 rounded-full bg-white px-7 py-3.5 text-sm font-semibold text-slate-900 hover:bg-slate-100 transition">
              Book a Demo <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="#" className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-7 py-3.5 text-sm font-semibold text-white hover:bg-white/[0.08] transition">
              Talk to an Expert
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-6 py-10 text-sm text-slate-500 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-6 w-auto opacity-80" />
            <span>© {new Date().getFullYear()} Neubit. Unified Command & Control Platform.</span>
          </div>
          <div className="flex flex-wrap gap-6">
            <Link href="/login" className="hover:text-slate-900 transition">Sign in</Link>
            <a href="#what" className="hover:text-slate-900 transition">Platform</a>
            <a href="#architecture" className="hover:text-slate-900 transition">Architecture</a>
            <a href="#use-cases" className="hover:text-slate-900 transition">Use cases</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
