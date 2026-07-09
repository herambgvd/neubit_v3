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
  // Streaming is a SECTION: the video surfaces — Video Wall (live), Recordings,
  // Playback. (Devices stays a pure onboarding zone; viewing lives here.)
  { title: "Streaming", icon: "heroicons:signal", section: "streaming" },
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
  { title: "Patterns", icon: "heroicons:squares-2x2", link: "/config/patterns", perm: "neubit.read" },
  { title: "Video Wall", icon: "heroicons:computer-desktop", link: "/config/video-wall", disabled: true },
  { title: "Storage", icon: "heroicons:circle-stack", link: "/config/storage", perm: "neubit.read" },
  { title: "Linkage", icon: "heroicons:bolt", link: "/config/linkage", perm: "neubit.read" },
  { title: "Workflow", icon: "heroicons:rectangle-stack", link: "/workflow-config", perm: "neubit.read" },
  { title: "Ingest", icon: "heroicons:arrow-down-on-square-stack", link: "/ingest", perm: "neubit.read" },
  { title: "Notifications", icon: "heroicons-outline:bell-alert", link: "/channels", perm: "settings.manage" },
  { title: "Activity", icon: "heroicons-outline:clipboard-document-list", link: "/audit", perm: "audit.read" },
  { title: "System", icon: "heroicons-outline:adjustments-horizontal", link: "/general", perm: "settings.manage" },
  // VMS enterprise surfaces (P6-C/P6-D).
  { title: "ONVIF Server", icon: "heroicons:signal", link: "/config/onvif-server", perm: "vms.config.manage" },
  { title: "Security", icon: "heroicons-outline:shield-exclamation", link: "/config/security", perm: "security.manage" },
  // neubit_v3-only admin pages (no neubit_v2 config equivalent) — kept so they stay reachable.
  { title: "API Keys", icon: "heroicons-outline:key", link: "/api-keys", perm: "apikey.manage" },
  { title: "Branding", icon: "heroicons-outline:swatch", link: "/branding", perm: "branding.manage" },
  { title: "Email Templates", icon: "heroicons-outline:envelope", link: "/email-templates", perm: "settings.manage" },
  { title: "System Health", icon: "heroicons-outline:heart", link: "/system-health", perm: "system.read" },
  { title: "License", icon: "heroicons-outline:check-badge", link: "/license" },
];

// ── Devices sub-tab bar — the ONBOARDING zone only (onboard devices here) ──
export const deviceTabs = [
  { title: "Access Control", icon: "heroicons:lock-closed", link: "/access-control", perm: "neubit.read" },
  { title: "Cameras", icon: "heroicons-outline:video-camera", link: "/devices/cameras", perm: "neubit.read" },
  { title: "NVR", icon: "heroicons:server-stack", link: "/devices/nvr", perm: "neubit.read" },
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

// ── Streaming sub-tab bar — the video-viewing surfaces (VMS) ──────────────
//   Video Wall (live), Recordings, Playback, Camera events. Onboarding stays under Devices.
export const streamTabs = [
  { title: "Video Wall", icon: "heroicons:computer-desktop", link: "/streaming", perm: "neubit.read" },
  { title: "Recordings", icon: "heroicons:film", link: "/recordings", perm: "neubit.read" },
  { title: "Playback", icon: "heroicons-outline:play", link: "/playback", perm: "neubit.read" },
  { title: "Camera events", icon: "heroicons:bell-alert", link: "/camera-events", perm: "neubit.read" },
  { title: "Reports", icon: "heroicons:chart-bar-square", link: "/reports", perm: "vms.playback.view" },
];

// The route the Streaming top-nav item jumps to (first enabled stream tab).
export const STREAMING_ENTRY = "/streaming";

// True when the current path belongs to the Streaming section.
export function isStreamingRoute(pathname) {
  if (!pathname) return false;
  return streamTabs.some(
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
