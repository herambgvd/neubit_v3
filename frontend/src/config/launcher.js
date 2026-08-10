// The LAUNCHER information architecture — the ONE definition of the metro launcher's
// modes, groups and tiles.
//
// Both surfaces that present "everything you can go to" render from this list:
//   • the HOME launcher (/home)            → big metro tiles, one mode at a time
//   • the ⊞ MENU navigator overlay          → the same groups as compact pill cells
// so the two can never drift apart. Add a surface here and it appears in both, under
// the same heading, with the same gating. (config/menu.js stays the source of truth
// for the header's section tabs and the navigator's "Jump to" quick row — a different
// job: those are per-section tab bars, not launcher surfaces.)
//
// Tile shape: { icon, label, href?, tone?, perm?, module?, soon? }
//   • no `href`, or `soon: true`  → the dimmed "SOON" state. Never a broken link.
//   • `perm` / `module`           → gated at render by gateTile(): a caller who can't
//                                   reach the surface sees it as SOON rather than a
//                                   dead link, so operators can see what their plan
//                                   could unlock. Identical on both surfaces.
//
// `tone` picks the tile's colour on HOME (teal / blue / hot / att); the navigator's
// pills ignore it. `layout` is HOME's pane layout for that mode.

export const LAUNCHER_MODES = [
  {
    id: "surv",
    label: "Surveillance",
    glow: "rgba(34,211,238,.5)",
    layout: "row",
    groups: [
      {
        title: "Watch",
        accent: "#67e8f9",
        tiles: [
          { icon: "heroicons:play-circle", label: "Live", href: "/streaming", tone: "teal", perm: "neubit.read", module: "vms" },
          { icon: "heroicons:backward", label: "Playback", href: "/playback", tone: "teal", perm: "neubit.read", module: "vms" },
          { icon: "heroicons:heart", label: "Pulse", href: "/system-health", tone: "teal", perm: "system.read" },
        ],
      },
      {
        title: "Act",
        accent: "#67e8f9",
        tiles: [
          { icon: "heroicons:bell-alert", label: "Alarms", href: "/events", tone: "hot", perm: "neubit.read" },
          { icon: "heroicons:chart-bar-square", label: "Video Analytics", soon: true },
        ],
      },
    ],
  },
  {
    // Building Intelligence is entirely coming-soon in this phase — every tile renders
    // SOON on both surfaces (never a fabricated destination or figure).
    id: "int",
    label: "Building Intelligence",
    glow: "rgba(167,139,250,.55)",
    layout: "row",
    soon: true,
    groups: [
      {
        title: "Sense",
        accent: "#67e8f9",
        tiles: [
          { icon: "heroicons:building-office-2", label: "Portfolio" },
          { icon: "heroicons:cog-8-tooth", label: "HVAC & Assets" },
          { icon: "heroicons:bolt", label: "Energy & Metering" },
          { icon: "heroicons:sparkles", label: "IAQ & Environment" },
        ],
      },
      {
        title: "Think",
        accent: "#c4b5fd",
        tiles: [
          { icon: "heroicons:star", label: "Ratings" },
          { icon: "heroicons:chart-pie", label: "Insights & Correlation" },
        ],
      },
    ],
  },
  {
    id: "conf",
    label: "Configurations",
    glow: "rgba(96,165,250,.5)",
    layout: "column",
    groups: [
      {
        title: "System & Policy",
        accent: "#93c5fd",
        tiles: [
          { icon: "heroicons:users", label: "Users & Roles", href: "/users", tone: "blue", perm: "user.read" },
          { icon: "heroicons:map-pin", label: "Sites", href: "/sites", tone: "blue", perm: "neubit.read" },
          { icon: "heroicons:adjustments-horizontal", label: "System", href: "/general", tone: "blue", perm: "settings.manage" },
          { icon: "heroicons:shield-exclamation", label: "Security", href: "/config/security", tone: "blue", perm: "security.manage" },
          { icon: "heroicons:squares-2x2", label: "Platform", href: "/platform", tone: "blue", perm: "settings.manage" },
          { icon: "heroicons:share", label: "Federation", href: "/federation", tone: "blue", perm: "vms.camera.read", module: "vms" },
        ],
      },
      {
        title: "Devices & Automation",
        accent: "#93c5fd",
        tiles: [
          { icon: "heroicons:video-camera", label: "Devices", href: "/devices/cameras", tone: "blue", perm: "neubit.read", module: "vms" },
          { icon: "heroicons:circle-stack", label: "Storage", href: "/storage", tone: "blue", perm: "vms.camera.read", module: "vms" },
          { icon: "heroicons:bolt", label: "Linkage & Policies", href: "/config/linkage", tone: "att", perm: "neubit.read", module: "vms" },
          { icon: "heroicons:computer-desktop", label: "Wall Layouts", href: "/config/video-wall", tone: "blue", perm: "vms.wall.manage", module: "vms" },
          { icon: "heroicons:rectangle-stack", label: "Workflow", href: "/workflow-config", tone: "blue", perm: "neubit.read", module: "workflow" },
          { icon: "heroicons:arrow-down-on-square-stack", label: "Ingest", href: "/ingest", tone: "blue", perm: "neubit.read", module: "workflow" },
          { icon: "heroicons:signal", label: "External Access", href: "/config/onvif-server", tone: "blue", perm: "vms.config.manage" },
        ],
      },
    ],
  },
];

// Gate one tile against the caller. An unreachable surface keeps its label but loses
// its destination — it renders SOON instead of a link that would 403. Tiles already
// marked `soon` pass straight through (there is nothing to gate).
export function gateTile(tile, { can, hasModule }) {
  if (tile.soon) return tile;
  const ok = (!tile.perm || can(tile.perm)) && (!tile.module || hasModule(tile.module));
  return ok ? tile : { ...tile, href: undefined, soon: true };
}

// Every launcher group, flattened across modes, with each tile gated for the caller.
// The ⊞ MENU navigator shows all modes at once, so it renders THIS.
export function launcherGroups(auth) {
  return LAUNCHER_MODES.flatMap((mode) =>
    mode.groups.map((group) => ({
      title: group.title,
      accent: group.accent,
      tiles: group.tiles.map((t) => gateTile(mode.soon ? { ...t, href: undefined, soon: true } : t, auth)),
    })),
  );
}
