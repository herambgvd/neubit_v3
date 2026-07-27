"use client";

// NeuBit VMS — metro HOME launcher (Phase 0 shell).
// After login the operator lands here: quiet navy tiles grouped into Surveillance ·
// Building Intelligence · Configurations. Each live tile links to the EXISTING route
// that already implements it; surfaces with no destination yet are dimmed "Coming soon"
// tiles (never a broken link, never a faked number). Building Intelligence is entirely
// coming-soon in this phase.
//
// Faithful recreation (JSX + Tailwind) of design/mockups/neubit-vms-home.html.

import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { vms } from "@/features/vms/api";
import { useAuth } from "@/lib/auth";

/* ── One metro tile ─────────────────────────────────────────────────────
   Live tile: navy glass, mono-line icon, name bottom-left, optional count badge.
   Soon tile: dimmed, non-clickable, SOON chip.                              */
function Tile({ icon, label, href, tone = "teal", count, soon }) {
  const toneRing = {
    teal: "hover:border-[rgba(34,211,238,.6)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(34,211,238,.3)]",
    blue: "hover:border-[rgba(96,165,250,.6)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(96,165,250,.3)]",
    hot: "border-[rgba(248,113,113,.5)] hover:border-[rgba(248,113,113,.75)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(248,113,113,.35)]",
    att: "border-[rgba(251,191,36,.45)] hover:border-[rgba(251,191,36,.7)] hover:shadow-[0_14px_44px_rgba(3,10,28,.6),0_0_26px_rgba(251,191,36,.3)]",
  };
  const toneBg = {
    teal: "linear-gradient(155deg,rgba(34,211,238,.13),rgba(150,180,245,.05) 65%)",
    blue: "linear-gradient(155deg,rgba(96,165,250,.14),rgba(167,139,250,.06) 65%)",
    hot: "linear-gradient(155deg,rgba(248,113,113,.24),rgba(248,113,113,.07) 70%)",
    att: "linear-gradient(155deg,rgba(251,191,36,.20),rgba(251,191,36,.06) 70%)",
  };
  const toneIcon = {
    teal: "#67e8f9",
    blue: "#93c5fd",
    hot: "#fca5a5",
    att: "#fcd34d",
  };
  const countColor = { teal: "#67e8f9", blue: "#93c5fd", hot: "#f87171", att: "#fbbf24" };

  if (soon) {
    return (
      <div
        aria-disabled="true"
        title="Coming soon"
        className="relative h-[150px] w-full select-none rounded-[16px] border border-[rgba(167,139,250,.28)] opacity-50"
        style={{ background: "linear-gradient(155deg,rgba(167,139,250,.12),rgba(34,211,238,.04) 70%)" }}
      >
        <Icon icon={icon} className="absolute left-1/2 top-6 -translate-x-1/2 text-[46px] text-[#c4b5fd]" />
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
      className={`group relative block h-[150px] w-full rounded-[16px] border border-[rgba(160,150,245,.22)] backdrop-blur-sm transition-transform duration-150 hover:scale-[1.06] ${toneRing[tone]}`}
      style={{ background: toneBg[tone] }}
    >
      <Icon
        icon={icon}
        className="absolute left-1/2 top-6 -translate-x-1/2 text-[46px] transition-transform duration-150 group-hover:scale-110"
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
    <h4
      className="mb-4 flex items-center gap-2 text-[13px] font-light tracking-[.6px]"
      style={{ color: accent }}
    >
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
      />
      {children}
    </h4>
  );
}

export default function HomePage() {
  const { user, can, hasModule } = useAuth();

  const canVms = hasModule("vms");
  const canCam = canVms && can("vms.camera.read");

  // Cheap camera count for the Live tile — omit the badge entirely if unavailable
  // (never fake a number). Reads `total` from the list envelope.
  const camCountQ = useQuery({
    queryKey: ["home-camera-count"],
    queryFn: () => vms.cameras.list({ limit: 1 }),
    enabled: canCam,
    staleTime: 60_000,
    retry: false,
  });
  const cameraCount =
    typeof camCountQ.data?.total === "number" ? camCountQ.data.total : undefined;

  // Gate a live tile: reachable only when its permission + module allow it; otherwise
  // it degrades to a dimmed "soon"-style tile (honest — no broken links).
  const gate = (t) => {
    const ok = (!t.perm || can(t.perm)) && (!t.module || hasModule(t.module));
    return ok ? t : { ...t, href: undefined, soon: true };
  };

  const surveillance = [
    { icon: "heroicons:play-circle", label: "Live", href: "/streaming", tone: "teal", perm: "neubit.read", module: "vms", count: cameraCount },
    { icon: "heroicons:tv", label: "Video Walls", href: "/wall", tone: "teal", perm: "vms.wall.view", module: "vms" },
    { icon: "heroicons:cpu-chip", label: "Fleet", href: "/devices/recorders", tone: "att", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:heart", label: "Pulse", href: "/system-health", tone: "teal", perm: "system.read" },
    { icon: "heroicons:bell-alert", label: "Alarms", href: "/events", tone: "hot", perm: "neubit.read" },
    { icon: "heroicons:magnifying-glass-circle", label: "Investigate", href: "/playback", tone: "teal", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:chart-bar-square", label: "Video Analytics", soon: true },
  ].map((t) => (t.soon ? t : gate(t)));

  const intelligence = [
    { icon: "heroicons:building-office-2", label: "Portfolio" },
    { icon: "heroicons:cog-8-tooth", label: "HVAC & Assets" },
    { icon: "heroicons:bolt", label: "Energy & Metering" },
    { icon: "heroicons:sparkles", label: "IAQ & Environment" },
    { icon: "heroicons:star", label: "Ratings" },
    { icon: "heroicons:chart-pie", label: "Insights & Correlation" },
  ];

  const configurations = [
    { icon: "heroicons:video-camera", label: "Devices", href: "/devices/cameras", tone: "blue", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:map-pin", label: "Sites", href: "/sites", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:bolt", label: "Linkage & Policies", href: "/config/linkage", tone: "att", perm: "neubit.read", module: "vms" },
    { icon: "heroicons:squares-2x2", label: "Patterns", href: "/config/patterns", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:computer-desktop", label: "Wall Layouts", href: "/config/video-wall", tone: "blue", perm: "vms.wall.manage", module: "vms" },
    { icon: "heroicons:rectangle-stack", label: "Workflow", href: "/workflow-config", tone: "blue", perm: "neubit.read", module: "workflow" },
    { icon: "heroicons:users", label: "Users & Roles", href: "/users", tone: "blue", perm: "user.read" },
    { icon: "heroicons:circle-stack", label: "Storage & Resilience", href: "/config/storage", tone: "blue", perm: "neubit.read" },
    { icon: "heroicons:adjustments-horizontal", label: "System", href: "/general", tone: "blue", perm: "settings.manage" },
    { icon: "heroicons:share", label: "Federation", soon: true },
    { icon: "heroicons:queue-list", label: "Rules", soon: true },
  ].map((t) => (t.soon ? t : gate(t)));

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto text-[#f2f6ff]"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* masthead */}
      <div className="flex items-center gap-3 px-8 pt-7 lg:px-[8%]">
        <span className="text-[16px] font-bold tracking-[0.5px]">
          Neu<i className="not-italic text-[#67e8f9]">Bit</i>
        </span>
        <span className="border-l border-[rgba(160,150,245,.2)] pl-3 font-mono text-[10px] tracking-[2px] text-[#9a92c8]">
          VMS COMMAND
        </span>
        <span className="ml-auto font-mono text-[11px] text-[#9a92c8]">
          {user?.full_name || user?.email}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-10 px-8 pb-10 pt-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:px-[8%] xl:grid-cols-3">
        {/* Surveillance */}
        <section>
          <h3 className="mb-5 text-[26px] font-extralight tracking-[1px] text-[#f2f6ff]">Surveillance</h3>
          <GroupHeading accent="#67e8f9">Watch &amp; Act</GroupHeading>
          <div className="grid grid-cols-2 gap-[14px] sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            {surveillance.map((t) => (
              <Tile key={t.label} {...t} />
            ))}
          </div>
        </section>

        {/* Building Intelligence — entirely coming soon in Phase 0 */}
        <section>
          <h3 className="mb-5 text-[26px] font-extralight tracking-[1px] text-[#c4b5fd]">
            Building Intelligence
          </h3>
          <GroupHeading accent="#c4b5fd">Sense &amp; Think</GroupHeading>
          <div className="grid grid-cols-2 gap-[14px] sm:grid-cols-3 lg:grid-cols-2">
            {intelligence.map((t) => (
              <Tile key={t.label} {...t} soon />
            ))}
          </div>
        </section>

        {/* Configurations */}
        <section>
          <h3 className="mb-5 text-[26px] font-extralight tracking-[1px] text-[#93c5fd]">Configurations</h3>
          <GroupHeading accent="#93c5fd">System &amp; Policy</GroupHeading>
          <div className="grid grid-cols-2 gap-[14px] sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            {configurations.map((t) => (
              <Tile key={t.label} {...t} />
            ))}
          </div>
        </section>
      </div>

      {/* GVD lockup */}
      <div className="mt-auto flex items-center justify-end gap-2 px-8 pb-4 font-mono text-[9px] tracking-[1.3px] text-[#9fb2d8] lg:px-[8%]">
        <span>GENIUS VISION DIGITAL · GVD</span>
      </div>
    </div>
  );
}
