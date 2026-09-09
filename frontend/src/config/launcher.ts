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

// GATE KEYS ARE CATALOG KEYS.
//
// Every `perm` below must be a key core's permission catalog knows
// (`backend/core/app/auth/permissions.py`). A key the catalog does not carry can
// be held by NOBODY except a wildcard admin — the role editor cannot even offer
// it — so a tile naming one reads SOON to every real operator while the page
// behind it works perfectly. `dashboards.read` did exactly that once; so did
// `neubit.read`, which was never a catalog key at all and gated eight tiles
// including Live, Playback, Alarms and Sites. Each is now the key the ROUTE
// behind it actually enforces, so the tile and its data turn on one thing.

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
          { icon: "heroicons:play-circle", label: "Live", href: "/streaming", tone: "teal", perm: "vms.live.view", module: "vms" },
          { icon: "heroicons:backward", label: "Playback", href: "/playback", tone: "teal", perm: "vms.playback.view", module: "vms" },
          // PULSE IS THE ESTATE, NOT THE PLATFORM. This pointed at
          // /system-health — which redirects to the platform's container list —
          // so a surveillance operator clicking it got Docker services and their
          // logs: an admin surface, already reachable under Configurations →
          // Platform → Health, answering a question nobody on a wall is asking.
          // It now opens what the recorders report about the estate: cameras
          // down and where, whether footage is being written, storage headroom,
          // and the per-camera fault trace. Gated on `vms.camera.read` — the key
          // the recorders' own sysmon boards ride on — not `system.read`.
          { icon: "heroicons:heart", label: "Pulse", href: "/pulse", tone: "teal", perm: "vms.camera.read", module: "vms" },
        ],
      },
      {
        title: "Act",
        accent: "#67e8f9",
        tiles: [
          { icon: "heroicons:bell-alert", label: "Alarms", href: "/events", tone: "hot", perm: "workflow.instance.read" },
          { icon: "heroicons:chart-bar-square", label: "Video Analytics", soon: true },
        ],
      },
      {
        // Its OWN row, below Act, rather than a third tile wedged between Alarms
        // and Video Analytics — those two are what an operator reaches for while
        // something is happening, and a dashboard is not. Inserting it there also
        // moved Video Analytics along, which is how a launcher an operator knows
        // by position stops being one.
        title: "Review",
        accent: "#67e8f9",
        tiles: [
          // The surveillance-category dashboards. Same viewer as Building
          // Intelligence's tile, pinned to `vms` — which is what stops one strip
          // holding every console's dashboards in registration order.
          //
          // Gated on `dashforge.read` (the key that mints the embed token, so the
          // tile and the data behind it turn on one thing) plus the `analytics`
          // module the routes are mounted behind. NOT `vms`: the module gate is
          // the backend's, and naming a different one here would show a tile that
          // 403s.
          { icon: "heroicons:squares-2x2", label: "Dashboards", href: "/surveillance/dashboards", tone: "teal", perm: "dashforge.read", module: "analytics" },
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
    //   Ratings            — EPI where an operator has supplied unit + area
    //
    // Left SOON, and why — each is a data gap, not a schedule:
    //   IAQ & Environment      ZERO environment points exist in the store. There is
    //                          nothing to render, and a stand-in would be a lie.
    //
    // RATINGS, REWRITTEN 2026-08-31. The old entry said "a rating needs a
    // benchmark and a unit; the wire carries neither, so any score would be
    // invented". True about the score, wrong about the conclusion: the answer
    // was not to give up but to build the PATH by which an operator supplies
    // what the wire cannot. That path now exists end to end —
    //
    //   • UNIT      /bi/ratings → UNITS lets an operator confirm what a point
    //               measures, suggested from the tag (`_kwh`, `_Hz`, `_V`) with
    //               the pattern shown, and bulk-applied over rows they can see.
    //               `points.unit_source = 'operator'` records who said it, and
    //               the writer now refuses to overwrite such a unit at all —
    //               COALESCE alone only stopped a message that says NOTHING.
    //               Deriving a unit from a tag silently is still forbidden.
    //   • AREA      `sites.gross_floor_area_sqm` (+ tariff, occupancy), typed in
    //               Configurations → Sites → Building, beside the address —
    //               where this platform already keeps site facts, per the same
    //               reasoning that moved device placement onto the floor plan.
    //               Mirrored into `neubit_reporting.site_facts` over the sites
    //               event spine so BI never reads core's database.
    //   • BENCHMARK STILL ABSENT, and stated as such on the screen. BEE and
    //               IGBC bands are published documents this deployment does not
    //               hold; an invented threshold would be a fabricated grade
    //               wearing a real EPI's credibility. So the EPI ships as a
    //               MEASURED figure with its whole arithmetic beside it, and the
    //               band says what it would take to exist.
    //
    // A site with no area recorded renders "cannot rate", with a link to where
    // to record it — never a partial score, never a default area.
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
    // RETIRED, NOT MOVED: NeuBit's own no-code dashboard builder. This note used
    // to say it had moved to "Configurations → Reporting & Dashboards" — there is
    // no such group in this file and there never was, so the one comment a reader
    // consults before hunting for a missing tile sent them somewhere that does not
    // exist. What actually happened: the builder was retired on 2026-09-03 and
    // DashForge is the authoring surface. The Dashboards TILE is still in "Think"
    // below, gated on `dashforge.read`; it opens the dashboards this platform
    // shows rather than a builder.
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
          // (A note here claimed the Dashboards tile "has moved to Configurations
          // → Reporting & Dashboards". It did not: no such group exists in this
          // file, and the tile is still in THIS group, twenty lines down. The
          // builder behind it was retired on 2026-09-03 — see the RETIRED, NOT
          // MOVED note in this mode's header — and the tile now opens DashForge.)
          // BUILT 2026-08-31 — see the RATINGS note above for what it needed
          // and which of those inputs is still missing (the benchmark band, and
          // the screen says so rather than inventing one). `bi.read` +
          // `analytics` to read; recording a unit needs `bi.manage`, recording
          // an area needs `sites.update` on the Sites console.
          { icon: "heroicons:star", label: "Ratings", href: "/bi/ratings", tone: "att", perm: "bi.read", module: "analytics" },
          // BUILT 2026-08-31. Same gating as every Sense tile — `bi.read` +
          // `analytics` — so a caller without either sees SOON, not a 403.
          { icon: "heroicons:chart-pie", label: "Insights & Correlation", href: "/bi/insights", tone: "att", perm: "bi.read", module: "analytics" },
          // BUILT 2026-08-31. Where an operator binds a point to a metric ROLE
          // (inlet_water_temp, energy_register, …) the way the Ratings UNITS
          // tab binds a unit: suggestions from tag conventions, labelled as
          // suggestions; nothing stored without confirmation. The metric
          // registry (contract §20) evaluates only over confirmed roles, so
          // this screen is where a new sensor domain becomes configuration.
          // Writes need `bi.manage`; the tile gates like every Sense tile.
          { icon: "heroicons:adjustments-horizontal", label: "Metric Roles", href: "/bi/metrics", tone: "att", perm: "bi.read", module: "analytics" },
          // BUILT 2026-09-01, re-pointed at DashForge 2026-09-03. The door to the
          // dashboards this platform SHOWS: a strip of registered names, click,
          // open. There is no longer a second door for AUTHORING one — NeuBit's
          // own builder is gone and authoring happens in DashForge.
          //
          // `dashforge.read` is the correct gate and NOT a cosmetic swap from the
          // `dashboards.read` that stood here. That key is deleted, and a tile
          // naming a key no longer in the catalog is never satisfiable — the tile
          // would read SOON to everyone including an admin, with the page behind
          // it working perfectly. `dashforge.read` is also what mints the embed
          // token, so the tile and the data it leads to now turn on one thing.
          // The page behind this pins the `building` CATEGORY, so the tile opens
          // THIS console's dashboards rather than every dashboard registered on
          // the platform — Surveillance has its own tile onto its own category,
          // and Configurations → Dashboards is where they are filed.
          { icon: "heroicons:squares-2x2", label: "Dashboards", href: "/bi/dashboards", tone: "att", perm: "dashforge.read", module: "analytics" },
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
          { icon: "heroicons:map-pin", label: "Sites", href: "/sites", tone: "blue", perm: "sites.read" },
          { icon: "heroicons:adjustments-horizontal", label: "System", href: "/system", tone: "blue", perm: "settings.manage" },
          { icon: "heroicons:shield-exclamation", label: "Security", href: "/config/security", tone: "blue", perm: "security.manage" },
          { icon: "heroicons:squares-2x2", label: "Platform", href: "/platform", tone: "blue", perm: "settings.manage" },
          // Where a dashboard is REGISTERED, renamed, re-filed and removed. It
          // used to be a create form on the Building Intelligence viewer, which
          // meant managing a surveillance dashboard started by opening Building
          // Intelligence. Gated on `dashforge.read` rather than `manage` so an
          // operator can see what exists; every write on the screen is behind
          // `dashforge.manage` and the buttons are absent without it.
          { icon: "heroicons:rectangle-group", label: "Dashboards", href: "/config/dashboards", tone: "blue", perm: "dashforge.read", module: "analytics" },
          { icon: "heroicons:share", label: "Federation", href: "/federation", tone: "blue", perm: "vms.camera.read", module: "vms" },
        ],
      },
      {
        title: "Devices & Automation",
        accent: "#93c5fd",
        tiles: [
          { icon: "heroicons:video-camera", label: "Devices", href: "/devices/cameras", tone: "blue", perm: "vms.camera.read", module: "vms" },
          { icon: "heroicons:circle-stack", label: "Storage", href: "/storage", tone: "blue", perm: "vms.camera.read", module: "vms" },
          { icon: "heroicons:bolt", label: "Linkage & Policies", href: "/config/linkage", tone: "att", perm: "vms.camera.read", module: "vms" },
          { icon: "heroicons:computer-desktop", label: "Wall Layouts", href: "/config/video-wall", tone: "blue", perm: "vms.wall.manage", module: "vms" },
          // Beside Wall Layouts on purpose: a wall layout is where tiles GO, a pattern
          // is what rotates through them. Gated on vms.config.manage, matching
          // PERM_MANAGE on the patterns + camera-group routers.
          { icon: "heroicons-outline:rectangle-group", label: "Patterns", href: "/config/patterns", tone: "blue", perm: "vms.config.manage", module: "vms" },
          { icon: "heroicons:rectangle-stack", label: "Workflow", href: "/workflow-config", tone: "blue", perm: "workflow.sop.read", module: "workflow" },
          { icon: "heroicons:arrow-down-on-square-stack", label: "Ingest", href: "/ingest", tone: "blue", perm: "ingest.read", module: "workflow" },
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
