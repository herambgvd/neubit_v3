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

// ── Shapes ────────────────────────────────────────────────────────────────
export type LauncherTone = "teal" | "blue" | "hot" | "att";

export interface LauncherTile {
  icon: string;
  label: string;
  /** Absent (or `soon`) → the dimmed "SOON" state. Never a broken link. */
  href?: string;
  tone?: LauncherTone;
  perm?: string;
  module?: string;
  soon?: boolean;
}

export interface LauncherGroup {
  title: string;
  accent: string;
  tiles: LauncherTile[];
}

export interface LauncherMode {
  id: string;
  label: string;
  glow: string;
  /** HOME's pane layout for this mode; the navigator's pills ignore it. */
  layout?: "row" | "column";
  /** The whole mode is unbuilt — every tile renders as SOON. */
  soon?: boolean;
  groups: LauncherGroup[];
}

/** The slice of `useAuth()` the gating needs. */
export interface LauncherGate {
  can: (perm: string) => boolean;
  hasModule: (key?: string) => boolean;
}

export const LAUNCHER_MODES: LauncherMode[] = [
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
    // Building Intelligence — the IoT reading store, surfaced. The mode is no longer
    // wholesale `soon`: most of it has real data behind it and is built.
    // The rest stay SOON, INDIVIDUALLY, and the rule that made the whole mode `soon`
    // still governs each one: never a fabricated destination or figure.
    //
    // Built (backed by `neubit_reporting`, served by the reading-writer's /bi API):
    //   Portfolio          — every category that has reported, with real counts
    //   Energy & Metering  — category=energy · 18 devices / 260 points
    //   HVAC & Assets      — category=hvac   ·  7 devices /  36 points
    //   Water              — category=water  ·  2 devices /  10 points
    //   Insights & Corr.   — Pearson r between any two reporting series
    //
    // Left SOON, and why — each is a data gap, not a schedule:
    //   IAQ & Environment      ZERO environment points exist in the store. There is
    //                          nothing to render, and a stand-in would be a lie.
    //   Ratings                See the Ratings note below — it is blocked on INPUTS
    //                          that have no home on this platform yet, not on the
    //                          readings.
    //
    // CORRECTED 2026-08-31 — the reason given here for Insights & Correlation was
    // WRONG, and it is worth saying so rather than quietly deleting it. It read:
    // "correlation across categories needs to know what each point MEASURES;
    // nothing on the wire says, so a correlation would be between two unnamed
    // numbers." Both halves are false:
    //
    //   • Pearson's r is DIMENSIONLESS — a covariance over two standard
    //     deviations — so the units cancel and a missing `points.unit` does not
    //     block it. (It does block a RATING: kWh/m²/yr is a unit statement.)
    //   • The series are not unnamed. Every one carries `device_tag` and
    //     `point_tag`, the SOURCE's own labels, stored as sent.
    //
    // What is genuinely forbidden is INTERPRETING the coefficient — naming a
    // driver, ranking causes, saying "because". The screen says that on itself,
    // shows n beside every r, prints which rollup answered, and renders a frozen
    // series as UNDEFINED rather than as 0.00. So the tile is BUILT.
    //
    // MOVED OUT: Dashboards. The no-code builder was filed here under "Think" and
    // it is not a Building Intelligence feature — it is domain-agnostic, it already
    // charts door-access events and IoT faults as readily as readings, and VMS and
    // fire register the same way. Filing it here labelled it as BI and sent anyone
    // looking for a door-access chart to the wrong mode. It now sits in
    // Configurations → Reporting & Dashboards, with its `perm`/`module` gating
    // unchanged.
    //
    // WATER IS LISTED as of 2026-08-31. It was held back pending agreement, not
    // pending data: 2 devices / 10 points (a sump pump and a flow meter) have
    // been reporting all along, and Portfolio showed the category with "no
    // console yet" on its card rather than hide it. The tile is the destination
    // that caption was waiting for.
    //
    // That change opened WATER and nothing else. IAQ still has no data behind
    // it, and a category having earned a tile is not an argument that it has.
    //
    // Gating: `bi.read` (registered in core's permission catalog under "Building
    // Intelligence" and enforced by the reading-writer) + the `analytics` module
    // ("Dashboards & Reports"), which is also what the backend router is mounted
    // behind. A caller without either sees SOON rather than a 403.
    id: "int",
    label: "Building Intelligence",
    glow: "rgba(167,139,250,.55)",
    layout: "row",
    groups: [
      {
        title: "Sense",
        accent: "#67e8f9",
        tiles: [
          { icon: "heroicons:building-office-2", label: "Portfolio", href: "/bi/portfolio", tone: "att", perm: "bi.read", module: "analytics" },
          { icon: "heroicons:cog-8-tooth", label: "HVAC & Assets", href: "/bi/hvac", tone: "teal", perm: "bi.read", module: "analytics" },
          { icon: "heroicons:bolt", label: "Energy & Metering", href: "/bi/energy", tone: "att", perm: "bi.read", module: "analytics" },
          // Same gating as its siblings — `bi.read` + the `analytics` module —
          // so a caller without either sees SOON here rather than a 403 there.
          { icon: "heroicons:beaker", label: "Water", href: "/bi/water", tone: "teal", perm: "bi.read", module: "analytics" },
          // NO "Placement" TILE. There was one, and it was a second way to say
          // where a device is. The first is Configurations → Sites → floor plan,
          // which pins a device at {x, y, rotation} on the drawing and now offers
          // IoT devices in the same palette as cameras and doors; the pin reaches
          // Building Intelligence over the sites event spine. Portfolio still
          // reports placed / unplaced and links to Sites.
          // No environment points exist. Stays SOON until some do.
          { icon: "heroicons:sparkles", label: "IAQ & Environment", soon: true },
        ],
      },
      {
        title: "Think",
        accent: "#c4b5fd",
        tiles: [
          // Dashboards USED to be here and has moved to Configurations → Reporting
          // & Dashboards. It is the domain-agnostic builder — it already charts
          // access-control events and IoT faults as readily as readings — so
          // filing it under Building Intelligence labelled it as a BI feature and
          // told an operator looking for a door-access chart to look in the wrong
          // place. Its gating went with it, unchanged.
          { icon: "heroicons:star", label: "Ratings", soon: true },
          // BUILT 2026-08-31. Same gating as every Sense tile — `bi.read` +
          // `analytics` — so a caller without either sees SOON, not a 403.
          { icon: "heroicons:chart-pie", label: "Insights & Correlation", href: "/bi/insights", tone: "att", perm: "bi.read", module: "analytics" },
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
        // Reporting & Dashboards. The builder is DOMAIN-AGNOSTIC: a widget names a
        // dataset from the registry, and the registry already carries IoT
        // readings, door-access events and IoT faults, with VMS and fire arriving
        // the same way (one row each, no release). It belongs beside the other
        // cross-cutting configuration surfaces, not inside the one domain it
        // happened to be built against first.
        title: "Reporting & Dashboards",
        accent: "#93c5fd",
        tiles: [
          // Gated by `dashboards.read` (the dashboards service — the definitions)
          // + the `analytics` module. A caller ALSO needs each dataset's own read
          // permission to see the widgets' DATA, which the reading-writer
          // enforces per dataset; that is deliberately NOT the gate here, because
          // "can open the console but the widgets say they could not run" is the
          // honest state to show, not a hidden tile. Unchanged by the move.
          { icon: "heroicons:squares-2x2", label: "Dashboards", href: "/dashboards", tone: "blue", perm: "dashboards.read", module: "analytics" },
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
export function gateTile(tile: LauncherTile, { can, hasModule }: LauncherGate): LauncherTile {
  if (tile.soon) return tile;
  const ok = (!tile.perm || can(tile.perm)) && (!tile.module || hasModule(tile.module));
  return ok ? tile : { ...tile, href: undefined, soon: true };
}

// Every launcher group, flattened across modes, with each tile gated for the caller.
// The ⊞ MENU navigator shows all modes at once, so it renders THIS.
export function launcherGroups(auth: LauncherGate): LauncherGroup[] {
  return LAUNCHER_MODES.flatMap((mode) =>
    mode.groups.map((group) => ({
      title: group.title,
      accent: group.accent,
      tiles: group.tiles.map((t) => gateTile(mode.soon ? { ...t, href: undefined, soon: true } : t, auth)),
    })),
  );
}
