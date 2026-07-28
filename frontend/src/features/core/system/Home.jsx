"use client";

// NeuBit VMS — metro HOME launcher. Faithful recreation (JSX + Tailwind) of
// design/mockups/neubit-vms-home.html: a MODE SWITCHER (three big typographic
// mode tabs; only the active mode's pane of grouped metro tiles shows,
// left-anchored, single-viewport) over the NeuBit "soul" backdrop (aperture
// rings + plexus + horizon). A minimal status strip (mode · clock · lock ·
// fullscreen) sits top-right, and a floating "NeuBit AI" button anchors
// bottom-right (a placeholder for the coming AI assistant/chatbot). Live tiles
// link to the EXISTING route; surfaces with no destination are dimmed "SOON"
// (never a broken link, never a faked number). Building Intelligence is entirely
// coming-soon in this phase.

import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";
import { toast } from "sonner";

/* Inline SVG for the AI button so it never depends on the Iconify CDN — the
   launcher chrome must render even fully offline. */
const IconSpark = (p) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2l1.9 5.6L19.5 9l-4.4 3.2 1.6 5.8L12 14.9 7.3 18l1.6-5.8L4.5 9l5.6-1.4z" /></svg>
);

import { vms } from "@/features/vms/api";
import { useAuth } from "@/lib/auth";

/* ── The NeuBit "soul" backdrop — aperture rings, plexus, horizon (decorative). */
function Soul() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 0 }}
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="nbv" cx="70%" cy="36%" r="85%">
          <stop offset="0" stopColor="#18305a" stopOpacity=".5" />
          <stop offset="60%" stopColor="#0c1530" stopOpacity="0" />
        </radialGradient>
        <pattern id="nbdots" width="84" height="84" patternUnits="userSpaceOnUse">
          <circle cx="14" cy="18" r="1" fill="#8fb0e8" opacity=".1" />
          <circle cx="58" cy="60" r="1" fill="#8fb0e8" opacity=".07" />
        </pattern>
      </defs>
      <rect width="1600" height="900" fill="url(#nbv)" />
      <rect width="1600" height="900" fill="url(#nbdots)" />
      <g transform="translate(1210,350)" fill="none" stroke="#8fb0e8" opacity=".06">
        <circle r="300" strokeWidth="1" />
        <circle r="430" strokeWidth="1" />
      </g>
      <g transform="translate(1210,350)" fill="none" stroke="#22d3ee" opacity=".16">
        <circle r="48" strokeWidth="1.3" />
        <circle r="88" strokeWidth="1" />
        <circle r="134" strokeWidth="1" opacity=".65" />
        <g stroke="#9fb9ec" opacity=".5" strokeLinecap="round">
          <path d="M0 -48 L27 -21" />
          <path d="M42 24 L15 42" />
          <path d="M-42 24 L-15 42" />
          <path d="M-42 -24 L-15 -42" />
          <path d="M42 -24 L15 -42" />
          <path d="M0 48 L-27 21" />
        </g>
      </g>
      <g stroke="#8fb0e8" fill="none" opacity=".12" strokeLinecap="round">
        <path d="M150 250 Q 680 300 1160 340" strokeDasharray="1 16" strokeWidth="1.5" />
        <path d="M120 560 Q 720 500 1176 372" strokeDasharray="1 16" strokeWidth="1.5" />
        <path d="M260 780 Q 780 640 1188 392" strokeDasharray="1 18" strokeWidth="1.5" />
      </g>
      <line x1="0" y1="652" x2="1600" y2="652" stroke="#22d3ee" strokeWidth="1" opacity=".08" />
    </svg>
  );
}

/* ── One metro tile ───────────────────────────────────────────────────── */
function Tile({ icon, label, href, tone = "teal", count, soon }) {
  const toneRing = {
    teal: "hover:border-[rgba(34,211,238,.65)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(34,211,238,.3)]",
    blue: "hover:border-[rgba(96,165,250,.65)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(96,165,250,.3)]",
    hot: "border-[rgba(248,113,113,.5)] hover:border-[rgba(248,113,113,.75)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(248,113,113,.35)]",
    att: "border-[rgba(251,191,36,.45)] hover:border-[rgba(251,191,36,.7)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(251,191,36,.3)]",
  };
  const toneBg = {
    teal: "linear-gradient(155deg,rgba(34,211,238,.13),rgba(150,180,245,.05) 65%)",
    blue: "linear-gradient(155deg,rgba(96,165,250,.14),rgba(167,139,250,.06) 65%)",
    hot: "linear-gradient(155deg,rgba(248,113,113,.24),rgba(248,113,113,.07) 70%)",
    att: "linear-gradient(155deg,rgba(251,191,36,.20),rgba(251,191,36,.06) 70%)",
  };
  const toneIcon = { teal: "#67e8f9", blue: "#93c5fd", hot: "#fca5a5", att: "#fcd34d" };
  const countColor = { teal: "#67e8f9", blue: "#93c5fd", hot: "#f87171", att: "#fbbf24" };

  if (soon) {
    return (
      <div
        aria-disabled="true"
        title="Coming soon"
        className="relative h-[186px] w-[186px] select-none rounded-[16px] border border-[rgba(167,139,250,.28)] opacity-50 backdrop-blur-sm"
        style={{ background: "linear-gradient(155deg,rgba(167,139,250,.12),rgba(34,211,238,.04) 70%)" }}
      >
        <Icon icon={icon} className="absolute left-1/2 top-7 -translate-x-1/2 text-[58px] text-[#c4b5fd]" />
        <div className="absolute inset-x-3.5 bottom-3 flex items-baseline gap-2 text-[13px] tracking-[.3px] text-[#aec2e8]">
          <span className="truncate">{label}</span>
          <span className="ml-auto rounded-[5px] border border-[rgba(160,150,245,.3)] px-1.5 py-px font-mono text-[9px] uppercase tracking-[.6px] text-[#8f8ac0]">
            Soon
          </span>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={`group relative block h-[186px] w-[186px] rounded-[16px] border border-[rgba(160,150,245,.22)] backdrop-blur-sm transition-[transform,box-shadow,border-color,background] duration-150 hover:z-10 hover:scale-[1.1] ${toneRing[tone]}`}
      style={{ background: toneBg[tone] }}
    >
      <Icon
        icon={icon}
        className="absolute left-1/2 top-7 -translate-x-1/2 text-[58px] transition-transform duration-150 group-hover:scale-110"
        style={{ color: toneIcon[tone] }}
      />
      <div className="absolute inset-x-3.5 bottom-3 flex items-baseline gap-2 text-[13px] tracking-[.3px] text-[#aec2e8] transition group-hover:text-[#f2f6ff]">
        <span className="truncate">{label}</span>
        {count != null && (
          <span className="ml-auto font-mono text-[15px] font-bold" style={{ color: countColor[tone] }}>
            {count}
          </span>
        )}
      </div>
    </Link>
  );
}

function GroupHeading({ children, accent }) {
  return (
    <h4 className="mb-4 flex items-center gap-2 text-[13px] font-normal tracking-[.6px]" style={{ color: accent }}>
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
      {children}
    </h4>
  );
}

function Group({ title, accent, tiles, soon }) {
  return (
    <div>
      <GroupHeading accent={accent}>{title}</GroupHeading>
      <div className="flex flex-wrap gap-[18px]">
        {tiles.map((t) => (
          <Tile key={t.label} {...t} soon={soon || t.soon} />
        ))}
      </div>
    </div>
  );
}

/* ── Floating "NeuBit AI" button — placeholder for the coming AI assistant.
   Sits above the GVD lockup (raised off the very bottom edge). */
function NeuBitAiButton() {
  return (
    <button
      type="button"
      onClick={() =>
        toast("NeuBit AI", { description: "The AI assistant is coming soon." })
      }
      title="NeuBit AI — coming soon"
      className="fixed bottom-14 right-6 z-30 flex items-center gap-2 rounded-full border border-[rgba(103,232,249,.4)] bg-[rgba(8,15,34,.7)] px-4 py-2.5 text-[13px] font-medium text-[#cfeffb] backdrop-blur-md transition hover:border-[#67e8f9] hover:shadow-[0_0_22px_rgba(34,211,238,.35)]"
    >
      <IconSpark width="16" height="16" className="text-[#67e8f9]" />
      NeuBit AI
      <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-[#34d399] shadow-[0_0_6px_#34d399]" />
    </button>
  );
}

const MODES = [
  { id: "surv", label: "Surveillance", glow: "rgba(34,211,238,.5)" },
  { id: "int", label: "Building Intelligence", glow: "rgba(167,139,250,.55)" },
  { id: "conf", label: "Configurations", glow: "rgba(96,165,250,.5)" },
];

const MODE_IDS = MODES.map((m) => m.id);

export default function HomePage() {
  const { can, hasModule } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // The active mode is kept in the URL (?mode=…) so it survives a refresh and is
  // shareable; falls back to Surveillance for a missing/unknown value.
  const urlMode = searchParams.get("mode");
  const mode = MODE_IDS.includes(urlMode) ? urlMode : "surv";
  const setMode = (id) =>
    router.replace(`/home?mode=${id}`, { scroll: false });

  const canVms = hasModule("vms");
  const canCam = canVms && can("vms.camera.read");

  const camCountQ = useQuery({
    queryKey: ["home-camera-count"],
    queryFn: () => vms.cameras.list({ limit: 1 }),
    enabled: canCam,
    staleTime: 60_000,
    retry: false,
  });
  const cameraCount = typeof camCountQ.data?.total === "number" ? camCountQ.data.total : undefined;

  const gate = (t) => {
    const ok = (!t.perm || can(t.perm)) && (!t.module || hasModule(t.module));
    return ok ? t : { ...t, href: undefined, soon: true };
  };
  const g = (arr) => arr.map((t) => (t.soon ? t : gate(t)));

  // ── Surveillance — Watch / Act ──
  const survWatch = g([
    { icon: "heroicons:play-circle", label: "Live", href: "/streaming", tone: "teal", perm: "neubit.read", module: "vms", count: cameraCount },
    { icon: "heroicons:tv", label: "Video Walls", href: "/wall", tone: "teal", perm: "vms.wall.view", module: "vms" },
    { icon: "heroicons:cpu-chip", label: "Fleet", href: "/devices/recorders", tone: "att", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:heart", label: "Pulse", href: "/system-health", tone: "teal", perm: "system.read" },
  ]);
  const survAct = g([
    { icon: "heroicons:bell-alert", label: "Alarms", href: "/events", tone: "hot", perm: "neubit.read" },
    { icon: "heroicons:magnifying-glass-circle", label: "Investigate", href: "/playback", tone: "teal", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:chart-bar-square", label: "Video Analytics", soon: true },
  ]);

  // ── Building Intelligence — Sense / Think (all coming-soon) ──
  const biSense = [
    { icon: "heroicons:building-office-2", label: "Portfolio" },
    { icon: "heroicons:cog-8-tooth", label: "HVAC & Assets" },
    { icon: "heroicons:bolt", label: "Energy & Metering" },
    { icon: "heroicons:sparkles", label: "IAQ & Environment" },
  ];
  const biThink = [
    { icon: "heroicons:star", label: "Ratings" },
    { icon: "heroicons:chart-pie", label: "Insights & Correlation" },
  ];

  // ── Configurations — System & Policy / Devices & Automation ──
  const confSystem = g([
    { icon: "heroicons:users", label: "Users & Roles", href: "/users", tone: "blue", perm: "user.read" },
    { icon: "heroicons:map-pin", label: "Sites", href: "/sites", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:adjustments-horizontal", label: "System", href: "/general", tone: "blue", perm: "settings.manage" },
    { icon: "heroicons:share", label: "Federation", soon: true },
  ]);
  const confDevices = g([
    { icon: "heroicons:video-camera", label: "Devices", href: "/devices/cameras", tone: "blue", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:bolt", label: "Linkage & Policies", href: "/config/linkage", tone: "att", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:computer-desktop", label: "Wall Layouts", href: "/config/video-wall", tone: "blue", perm: "vms.wall.manage", module: "vms" },
    { icon: "heroicons:rectangle-stack", label: "Workflow", href: "/workflow-config", tone: "blue", perm: "neubit.read", module: "workflow" },
    { icon: "heroicons:queue-list", label: "Rules", soon: true },
  ]);

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden text-[#f2f6ff]"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <Soul />

      {/* big typographic mode tabs (status strip now lives in the header) */}
      <div className="relative z-10 flex flex-wrap items-baseline gap-x-11 gap-y-2 px-8 pb-2 pt-10 lg:px-[11%]">
        {MODES.map((m) => {
          const on = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className="bg-transparent text-[42px] font-thin tracking-[1px] transition-[color,text-shadow] duration-200"
              style={on ? { color: "#f2f6ff", textShadow: `0 0 24px ${m.glow}` } : { color: "#7e93bf" }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* active pane — one mode at a time, left-anchored */}
      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-8 pt-10 lg:px-[11%]">
        {mode === "surv" && (
          <div className="flex flex-wrap gap-x-[72px] gap-y-10">
            <Group title="Watch" accent="#67e8f9" tiles={survWatch} />
            <Group title="Act" accent="#67e8f9" tiles={survAct} />
          </div>
        )}
        {mode === "int" && (
          <div className="flex flex-wrap gap-x-[72px] gap-y-10">
            <Group title="Sense" accent="#67e8f9" tiles={biSense} soon />
            <Group title="Think" accent="#c4b5fd" tiles={biThink} soon />
          </div>
        )}
        {mode === "conf" && (
          <div className="flex flex-col gap-8">
            <Group title="System & Policy" accent="#93c5fd" tiles={confSystem} />
            <Group title="Devices & Automation" accent="#93c5fd" tiles={confDevices} />
          </div>
        )}
      </div>

      {/* GVD lockup — bottom-right */}
      <div className="pointer-events-none absolute bottom-4 right-6 z-10 flex items-center gap-2.5 opacity-80">
        <span className="text-[10px] font-medium uppercase tracking-[2.5px] text-[#9fb2d8]">
          Genius Vision Digital
        </span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo/gvd_logo_color.png" alt="GVD" className="h-4 w-auto object-contain" />
      </div>

      <NeuBitAiButton />
    </div>
  );
}
