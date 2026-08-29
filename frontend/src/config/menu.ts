// Command Center — operator/tenant portal navigation (header-less era).
//
// The global top-nav header is retired: the product moved to an immersive, chrome-free
// UI. This file is now the single source of truth for the ⊞ MENU navigator overlay
// (and the device/stream SectionTabs bars that still render under those pages):
//   • menuItems      → the overlay's "Jump to" group (Home, Devices, Streaming, Incidents)
//   • streamTabs     → the overlay's "Surveillance" group + the Streaming sub-tab bar
//   • deviceTabs     → the Devices sub-tab bar + part of the overlay's "Configurations"
//   • configConsoles → the rest of the overlay's "Configurations" group (standalone consoles)
//
// Items whose feature isn't built yet carry `disabled: true` — they render greyed with a
// "Soon" pill (visible but not clickable) so the full menu shape is present from day one.
//
// NOTE: "/" is the PUBLIC landing page (app/page.jsx → LandingClient), OUTSIDE the (app)
// auth group. In-app nav must always target /home and friends, never "/".

// ── Shapes ────────────────────────────────────────────────────────────────
/** A navigable surface. `disabled` marks a feature that is not built yet: it
 *  renders greyed with a "Soon" pill, so the full menu shape exists from day one.
 *  `perm` and `module` gate visibility (see `can` / `hasModule` in lib/auth). */
export interface NavItem {
  title: string;
  icon: string;
  link?: string;
  section?: string;
  perm?: string;
  module?: string;
  disabled?: boolean;
  /** Visible only to the platform superadmin. */
  superadmin?: boolean;
}

// ── Jump-to surfaces (⊞ MENU overlay "Jump to" group) ────────────────
export const menuItems: NavItem[] = [
  // Hidden for now (coming later) — uncomment to restore in the top nav.
  // { title: "Home", icon: "heroicons-outline:home", link: "/home", perm: "neubit.read" },
  // Devices → the estate zone (Access Control; federated Cameras view + Recorders with VMS).
  // Carries an explicit `link` so it surfaces as a "Jump to" cell in the ⊞ MENU overlay;
  // the full device tab list lives in the overlay's Configurations group.
  { title: "Devices", icon: "heroicons-outline:video-camera", section: "devices", link: "/access-control" },
  // Streaming → the immersive Live video wall (/streaming). Explicit `link` so Live is
  // directly reachable from the overlay (it is intentionally not a Surveillance sub-tab).
  { title: "Streaming", icon: "heroicons:signal", section: "streaming", module: "vms", link: "/streaming" },
  // "Incidents" = the PSIM alarm/incident surface (SOP-driven, cross-domain incidents
  // live here, like neubit_v2). Named distinctly from Streaming → "Camera events" (the
  // raw device-level event feed) to remove the "Events vs Camera events" confusion.
  // Route stays /events. Workflow config lives under Config → Workflow.
  { title: "Incidents", icon: "heroicons:calendar-days", link: "/events", perm: "neubit.read" },
  // Hidden for now (coming later) — uncomment to restore in the top nav.
  // { title: "Network", icon: "heroicons:server-stack", link: "/network", disabled: true, module: "nms" },
  // { title: "Octosense", icon: "heroicons:rss", link: "/octosense", disabled: true, module: "octosense" },
  // Config is no longer a top-nav section — every former Config surface is now its
  // own minimal-chrome console reached from the ⊞ menu navigator + the Home
  // Configurations launcher. The Config sub-tab bar is retired entirely.
];

// ── Config surfaces ──────────────────────────────────────────────────
// The Config sub-tab bar is fully retired: every former Config surface is now its
// own minimal-chrome console (Users/Roles, Sites, Audit, Workflow, Ingest, System,
// Security(+API Keys), Platform, Video Wall, Linkage, External Access), reached via
// the ⊞ MENU navigator's "Configurations" group + the Home Configurations launcher.
// The former Config surfaces, now standalone consoles — the ⊞ menu navigator's
// "Configurations" column is built from THIS list.
export const configConsoles: NavItem[] = [
  { title: "Users & Roles", icon: "heroicons-outline:users", link: "/users", perm: "user.read" },
  { title: "Sites", icon: "heroicons-outline:map-pin", link: "/sites", perm: "neubit.read" },
  { title: "Video Wall", icon: "heroicons-outline:computer-desktop", link: "/config/video-wall", perm: "vms.wall.manage", module: "vms" },
  { title: "Linkage", icon: "heroicons-outline:bolt", link: "/config/linkage", perm: "neubit.read", module: "vms" },
  { title: "Workflow", icon: "heroicons-outline:rectangle-stack", link: "/workflow-config", perm: "neubit.read", module: "workflow" },
  { title: "Ingest", icon: "heroicons-outline:arrow-down-on-square-stack", link: "/ingest", perm: "neubit.read", module: "workflow" },
  { title: "Security", icon: "heroicons-outline:shield-exclamation", link: "/config/security", perm: "security.manage" },
  // Federation is a System & Policy console on the HOME launcher — list it here too
  // so the ⌘K command palette can reach it like every other Configurations surface.
  { title: "Federation", icon: "heroicons-outline:share", link: "/federation", perm: "vms.camera.read", module: "vms" },
  // Storage is a read-only, node-scoped view of each recorder's storage (single
  // ownership — the recorder owns + manages it). Listed here so ⌘K can reach it.
  { title: "Storage", icon: "heroicons-outline:circle-stack", link: "/storage", perm: "vms.camera.read", module: "vms" },
  { title: "System", icon: "heroicons-outline:adjustments-horizontal", link: "/general", perm: "settings.manage" },
  { title: "Platform", icon: "heroicons-outline:squares-2x2", link: "/platform", perm: "settings.manage" },
  { title: "Audit", icon: "heroicons-outline:clipboard-document-list", link: "/audit", perm: "audit.read" },
  { title: "External Access", icon: "heroicons-outline:signal", link: "/config/onvif-server", perm: "vms.config.manage", superadmin: true },
];

// ── Devices sub-tab bar — the ONBOARDING zone only (onboard devices here) ──
export const deviceTabs: NavItem[] = [
  { title: "Access Control", icon: "heroicons:lock-closed", link: "/access-control", perm: "neubit.read", module: "access" },
  // Cameras = a FEDERATED, read-only view of every recorder-owned camera (single
  // ownership: the standalone recorder owns all cameras — direct + 3rd-party NVRs
  // onboarded on the recorder edge). The VMS never onboards cameras; management
  // happens on the owning recorder.
  { title: "Cameras", icon: "heroicons-outline:video-camera", link: "/devices/cameras", perm: "neubit.read", module: "vms" },
  // Recorders = our recorder NODE registry (federated standalone recorders). This is
  // the only Devices onboarding surface — 3rd-party NVRs are onboarded ON a recorder,
  // so the old VMS-side "NVR" onboarding tab has been retired.
  { title: "Recorders", icon: "heroicons:cpu-chip", link: "/devices/recorders", perm: "neubit.read", module: "vms" },
];

// The route the Devices top-nav item jumps to (first enabled device tab).
export const DEVICES_ENTRY = "/access-control";

// True when the current path belongs to the Devices section (drives the sub-tab bar +
// the "Devices" top-nav active state). Matches any enabled device tab's route.
export function isDevicesRoute(pathname?: string | null): boolean {
  if (!pathname) return false;
  return deviceTabs.some(
    (t) => !t.disabled && (pathname === t.link || pathname.startsWith(`${t.link}/`)),
  );
}

// ── Streaming sub-tab bar — the video-viewing surfaces (VMS) ──────────────
//   Video Wall (live), Playback, Camera events. Onboarding stays under Devices.
//   (Recordings folded into Playback — its calendar/timeline covers estate browse +
//   clip extract, and evidence-lock lives in Playback's focus player.)
export const streamTabs: NavItem[] = [
  // The video wall IS the Live console at /streaming (immersive, reached from
  // Home) — the separate shared "Wall Console" surface was merged into it, so it's
  // intentionally NOT a sub-tab here.
  { title: "Playback", icon: "heroicons-outline:play", link: "/playback", perm: "neubit.read", module: "vms" },
  { title: "Camera events", icon: "heroicons:bell-alert", link: "/camera-events", perm: "neubit.read", module: "vms" },
  { title: "Reports", icon: "heroicons:chart-bar-square", link: "/reports", perm: "vms.playback.view", module: "vms" },
];

// The route the Streaming top-nav item jumps to (first enabled stream tab).
export const STREAMING_ENTRY = "/streaming";

// True when the current path belongs to the Streaming section.
export function isStreamingRoute(pathname?: string | null): boolean {
  if (!pathname) return false;
  // /streaming (immersive Live) is no longer a sub-tab but still belongs to the
  // Streaming section (for top-nav highlight).
  if (pathname === STREAMING_ENTRY || pathname.startsWith(`${STREAMING_ENTRY}/`)) return true;
  return streamTabs.some(
    (t) => !t.disabled && (pathname === t.link || pathname.startsWith(`${t.link}/`)),
  );
}
