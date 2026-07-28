"use client";

// NeuBit VMS — metro HOME launcher.
// Faithful recreation (JSX + Tailwind) of design/mockups/neubit-vms-home.html:
// a MODE SWITCHER — three big typographic mode tabs (Surveillance · Building
// Intelligence · Configurations); only the active mode's pane of metro tiles is
// shown, left-anchored, single-viewport. Each live tile links to the EXISTING
// route that implements it; surfaces with no destination yet are dimmed "SOON"
// (never a broken link, never a faked number). Building Intelligence is entirely
// coming-soon in this phase.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { vms } from "@/features/vms/api";
import { useAuth } from "@/lib/auth";

/* ── One metro tile ─────────────────────────────────────────────────────
   Live: navy glass, mono-line icon top-centre, name bottom-left + optional count.
   Soon: dimmed, non-clickable, SOON chip.                                    */
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
        className="relative h-[168px] w-[168px] select-none rounded-[16px] border border-[rgba(167,139,250,.28)] opacity-50 backdrop-blur-sm"
        style={{ background: "linear-gradient(155deg,rgba(167,139,250,.12),rgba(34,211,238,.04) 70%)" }}
      >
        <Icon icon={icon} className="absolute left-1/2 top-6 -translate-x-1/2 text-[52px] text-[#c4b5fd]" />
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
      className={`group relative block h-[168px] w-[168px] rounded-[16px] border border-[rgba(160,150,245,.22)] backdrop-blur-sm transition-[transform,box-shadow,border-color,background] duration-150 hover:z-10 hover:scale-[1.1] ${toneRing[tone]}`}
      style={{ background: toneBg[tone] }}
    >
      <Icon
        icon={icon}
        className="absolute left-1/2 top-6 -translate-x-1/2 text-[52px] transition-transform duration-150 group-hover:scale-110"
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

/* Group sub-heading inside a pane (mockup .grp h4 with a glowing dot). */
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

const MODES = [
  { id: "surv", label: "Surveillance", glow: "rgba(34,211,238,.5)" },
  { id: "int", label: "Building Intelligence", glow: "rgba(167,139,250,.55)" },
  { id: "conf", label: "Configurations", glow: "rgba(96,165,250,.5)" },
];

export default function HomePage() {
  const { can, hasModule } = useAuth();
  const [mode, setMode] = useState("surv");

  const canVms = hasModule("vms");
  const canCam = canVms && can("vms.camera.read");

  // Cheap camera count for the Live tile — omit the badge if unavailable (never fake).
  const camCountQ = useQuery({
    queryKey: ["home-camera-count"],
    queryFn: () => vms.cameras.list({ limit: 1 }),
    enabled: canCam,
    staleTime: 60_000,
    retry: false,
  });
  const cameraCount = typeof camCountQ.data?.total === "number" ? camCountQ.data.total : undefined;

  // Gate a live tile: reachable only when its permission + module allow it; otherwise
  // it degrades to a dimmed "soon" tile (honest — no broken links).
  const gate = (t) => {
    const ok = (!t.perm || can(t.perm)) && (!t.module || hasModule(t.module));
    return ok ? t : { ...t, href: undefined, soon: true };
  };
  const g = (arr) => arr.map((t) => (t.soon ? t : gate(t)));

  // ── Surveillance — two groups (Watch / Respond) ──
  const survWatch = g([
    { icon: "heroicons:play-circle", label: "Live", href: "/streaming", tone: "teal", perm: "neubit.read", module: "vms", count: cameraCount },
    { icon: "heroicons:tv", label: "Video Walls", href: "/wall", tone: "teal", perm: "vms.wall.view", module: "vms" },
    { icon: "heroicons:cpu-chip", label: "Fleet", href: "/devices/recorders", tone: "att", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:heart", label: "Pulse", href: "/system-health", tone: "teal", perm: "system.read" },
  ]);
  const survRespond = g([
    { icon: "heroicons:bell-alert", label: "Alarms", href: "/events", tone: "hot", perm: "neubit.read" },
    { icon: "heroicons:magnifying-glass-circle", label: "Investigate", href: "/playback", tone: "teal", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:chart-bar-square", label: "Video Analytics", soon: true },
  ]);

  // ── Building Intelligence — all coming-soon (Sense / Think) ──
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

  // ── Configurations — two groups (System & Policy / Devices & Automation) ──
  const confSystem = g([
    { icon: "heroicons:users", label: "Users & Roles", href: "/users", tone: "blue", perm: "user.read" },
    { icon: "heroicons:map-pin", label: "Sites", href: "/sites", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:circle-stack", label: "Storage & Resilience", href: "/config/storage", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:adjustments-horizontal", label: "System", href: "/general", tone: "blue", perm: "settings.manage" },
    { icon: "heroicons:share", label: "Federation", soon: true },
  ]);
  const confDevices = g([
    { icon: "heroicons:video-camera", label: "Devices", href: "/devices/cameras", tone: "blue", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:bolt", label: "Linkage & Policies", href: "/config/linkage", tone: "att", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:squares-2x2", label: "Patterns", href: "/config/patterns", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:computer-desktop", label: "Wall Layouts", href: "/config/video-wall", tone: "blue", perm: "vms.wall.manage", module: "vms" },
    { icon: "heroicons:rectangle-stack", label: "Workflow", href: "/workflow-config", tone: "blue", perm: "neubit.read", module: "workflow" },
    { icon: "heroicons:queue-list", label: "Rules", soon: true },
  ]);

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden text-[#f2f6ff]"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* big typographic mode tabs (branding lives in the transparent top strip) */}
      <div className="flex flex-wrap items-baseline gap-x-11 gap-y-2 px-8 pb-2 pt-10 lg:px-[11%]">
        {MODES.map((m) => {
          const on = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className="bg-transparent text-[38px] font-extralight tracking-[1px] transition-[color,text-shadow] duration-200"
              style={
                on
                  ? { color: "#f2f6ff", textShadow: `0 0 24px ${m.glow}` }
                  : { color: "#7e93bf" }
              }
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* active pane — one mode at a time, left-anchored */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-10 lg:px-[11%]">
        {mode === "surv" && (
          <div className="flex flex-wrap gap-x-[72px] gap-y-10">
            <Group title="Watch" accent="#67e8f9" tiles={survWatch} />
            <Group title="Respond" accent="#67e8f9" tiles={survRespond} />
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

      {/* GVD lockup */}
      <div className="flex items-center justify-end gap-2 px-8 pb-3 font-mono text-[9px] tracking-[1.3px] text-[#9fb2d8] lg:px-[11%]">
        <span>GENIUS VISION DIGITAL · GVD</span>
      </div>
    </div>
  );
}
