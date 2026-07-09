// Command Center — operator/tenant portal navigation.
//
// Mirrors neubit_v2's proven two-tier arrangement (clients preferred it), rethemed
// to neubit_v3's Vercel dark tokens:
//   • TOP horizontal nav  → domain surfaces (Home, Dashboard, Devices, …, Config)
//   • CONFIG sub-tab bar  → a SECOND horizontal bar shown under the header when you're
//     in the Config or Devices section (Sites, Users, …; Access Control, …) — see shell/SectionTabs.
//
// Items whose feature isn't built yet carry `disabled: true` — they render greyed with a
// "Soon" pill (visible but not clickable) so the full menu shape is present from day one.
//
// NOTE: "/" is the PUBLIC landing page (app/page.jsx → LandingClient), OUTSIDE the (app)
// auth group. In-app nav must always target /home and friends, never "/".

// ── Top horizontal nav (domain surfaces) ─────────────────────────────
export const menuItems = [
  { title: "Home", icon: "heroicons-outline:home", link: "/home", perm: "neubit.read" },
  { title: "Dashboard", icon: "heroicons-outline:chart-bar", link: "/dashboard", disabled: true },
  // Devices is a SECTION: clicking it enters the Devices sub-tab bar (Access Control now;
  // Cameras/NVR arrive with VMS). Mirrors neubit_v2's devices/ area.
  { title: "Devices", icon: "heroicons-outline:video-camera", section: "devices" },
  // Streaming = the live video-wall surface (VMS P2-D). Reads the camera estate.
  { title: "Streaming", icon: "heroicons:signal", link: "/streaming", perm: "neubit.read" },
  // Events = the incident surface (SOP-driven incidents live here, like neubit_v2).
  // Workflow itself is NOT a top-nav item — its config lives under Config → Workflow.
  { title: "Events", icon: "heroicons:calendar-days", link: "/events", perm: "neubit.read" },
  { title: "Network", icon: "heroicons:server-stack", link: "/network", disabled: true },
  { title: "Octosense", icon: "heroicons:rss", link: "/octosense", disabled: true },
  // Config is a SECTION: clicking it enters the Config sub-tab bar (first enabled tab).
  { title: "Config", icon: "heroicons-outline:cog-6-tooth", section: "config" },
];

// ── Config sub-tab bar (second horizontal bar) ───────────────────────
//   neubit_v2 order first (Sites…System), then neubit_v3's existing admin pages appended
//   so nothing is lost. Enabled tabs map to real neubit_v3 routes; the rest are disabled
//   placeholders until their feature ships.
export const configTabs = [
  { title: "Sites", icon: "heroicons:map-pin", link: "/sites", perm: "neubit.read" },
  { title: "Users", icon: "heroicons-outline:users", link: "/users", perm: "user.read" },
  { title: "Roles", icon: "heroicons-outline:shield-check", link: "/roles", perm: "role.read" },
  { title: "Tags", icon: "heroicons:tag", link: "/tags", perm: "tags.read" },
  { title: "Patterns", icon: "heroicons:squares-2x2", link: "/config/patterns", disabled: true },
  { title: "Video Wall", icon: "heroicons:computer-desktop", link: "/config/video-wall", disabled: true },
  { title: "Storage", icon: "heroicons:circle-stack", link: "/config/storage", perm: "neubit.read" },
  { title: "Workflow", icon: "heroicons:rectangle-stack", link: "/workflow-config", perm: "neubit.read" },
  { title: "Ingest", icon: "heroicons:arrow-down-on-square-stack", link: "/ingest", perm: "neubit.read" },
  { title: "Notifications", icon: "heroicons-outline:bell-alert", link: "/channels", perm: "settings.manage" },
  { title: "Activity", icon: "heroicons-outline:clipboard-document-list", link: "/audit", perm: "audit.read" },
  { title: "System", icon: "heroicons-outline:adjustments-horizontal", link: "/general", perm: "settings.manage" },
  // neubit_v3-only admin pages (no neubit_v2 config equivalent) — kept so they stay reachable.
  { title: "API Keys", icon: "heroicons-outline:key", link: "/api-keys", perm: "apikey.manage" },
  { title: "Branding", icon: "heroicons-outline:swatch", link: "/branding", perm: "branding.manage" },
  { title: "Email Templates", icon: "heroicons-outline:envelope", link: "/email-templates", perm: "settings.manage" },
  { title: "System Health", icon: "heroicons-outline:heart", link: "/system-health", perm: "system.read" },
  { title: "License", icon: "heroicons-outline:check-badge", link: "/license" },
];

// ── Devices sub-tab bar (second horizontal bar for the Devices section) ──
//   Access Control + Cameras + NVR ship now (VMS P1); Streaming stays "Soon" (P2).
export const deviceTabs = [
  { title: "Access Control", icon: "heroicons:lock-closed", link: "/access-control", perm: "neubit.read" },
  { title: "Cameras", icon: "heroicons-outline:video-camera", link: "/devices/cameras", perm: "neubit.read" },
  { title: "NVR", icon: "heroicons:server-stack", link: "/devices/nvr", perm: "neubit.read" },
  { title: "Recordings", icon: "heroicons:film", link: "/devices/recordings", perm: "neubit.read" },
];

// The route the Devices top-nav item jumps to (first enabled device tab).
export const DEVICES_ENTRY = "/access-control";

// True when the current path belongs to the Devices section (drives the sub-tab bar +
// the "Devices" top-nav active state). Matches any enabled device tab's route.
export function isDevicesRoute(pathname) {
  if (!pathname) return false;
  return deviceTabs.some(
    (t) => !t.disabled && (pathname === t.link || pathname.startsWith(`${t.link}/`)),
  );
}

// The route the Config top-nav item jumps to (first enabled config tab).
export const CONFIG_ENTRY = "/sites";

// True when the current path belongs to the Config section (drives the sub-tab bar +
// the "Config" top-nav active state). Matches any enabled config tab's route.
export function isConfigRoute(pathname) {
  if (!pathname) return false;
  if (pathname === "/config" || pathname.startsWith("/config/")) return true;
  return configTabs.some(
    (t) => !t.disabled && (pathname === t.link || pathname.startsWith(`${t.link}/`)),
  );
}
