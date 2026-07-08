// VMS shared constants — brands, status presets, filter option lists, config-tab
// enums. Kept JSX-free (data-only) so it stays importable anywhere. Rethemed to
// neubit_v3's Vercel dark tokens (single token set that flips with the theme).

// ── Camera / NVR brands (onboard brand selector) ─────────────────────────
// ONVIF is the universal default; the named brands add ISAPI/CGI extras. All are
// selectable — the backend driver factory keys off `brand`.
export const CAMERA_BRANDS = [
  { value: "onvif", label: "ONVIF (generic)", hint: "Profile S/G/T — works with most IP cameras" },
  { value: "hikvision", label: "Hikvision", hint: "ISAPI + ONVIF" },
  { value: "cpplus", label: "CP-Plus", hint: "Dahua-lineage HTTP/CGI + ONVIF" },
  { value: "lumina", label: "Lumina", hint: "Lumina API + ONVIF fallback" },
];

export const CONNECTION_TYPES = [
  { value: "onvif", label: "ONVIF" },
  { value: "rtsp", label: "RTSP (direct)" },
  { value: "nvr_channel", label: "NVR channel" },
];

export const RECORDING_MODES = [
  { value: "continuous", label: "Continuous", icon: "heroicons-outline:film" },
  { value: "schedule", label: "Schedule", icon: "heroicons-outline:calendar-days" },
  { value: "motion", label: "Motion", icon: "heroicons-outline:bolt" },
  { value: "manual", label: "Manual", icon: "heroicons-outline:hand-raised" },
];

// ── Status → pill preset (camera.status / nvr.status) ────────────────────
export const STATUS_PRESETS = {
  online: { label: "Online", dot: "bg-emerald-500", cls: "bg-emerald-500/10 text-emerald-500", icon: "heroicons-outline:check-circle" },
  offline: { label: "Offline", dot: "bg-muted", cls: "bg-hover text-muted", icon: "heroicons-outline:x-circle" },
  connecting: { label: "Connecting", dot: "bg-amber-500", cls: "bg-amber-500/10 text-amber-500", icon: "svg-spinners:180-ring" },
  error: { label: "Error", dot: "bg-red-500", cls: "bg-red-500/10 text-red-500", icon: "heroicons-outline:exclamation-circle" },
  unknown: { label: "Unknown", dot: "bg-amber-500", cls: "bg-amber-500/10 text-amber-500", icon: "heroicons-outline:question-mark-circle" },
};

// Filter option list for the status StatsStrip / dropdown ("" = all).
export const STATUS_FILTERS = [
  { key: "", label: "All", color: "text-foreground" },
  { key: "online", label: "Online", color: "text-emerald-500" },
  { key: "offline", label: "Offline", color: "text-muted" },
  { key: "connecting", label: "Connecting", color: "text-amber-500" },
  { key: "error", label: "Error", color: "text-red-500" },
];

export const BRAND_FILTERS = [
  { value: "", label: "All brands" },
  ...CAMERA_BRANDS.map((b) => ({ value: b.value, label: b.label })),
];

// ── Camera config tabs (onboard modal + detail) ──────────────────────────
export const CONFIG_TABS = [
  { key: "live", label: "Live", icon: "heroicons-outline:play-circle" },
  { key: "recording", label: "Recording", icon: "heroicons-outline:film" },
  { key: "onvif", label: "ONVIF", icon: "heroicons-outline:signal" },
  { key: "imaging", label: "Imaging", icon: "heroicons-outline:sun" },
  { key: "io", label: "I/O", icon: "heroicons-outline:arrows-right-left" },
  { key: "advanced", label: "Advanced", icon: "heroicons-outline:adjustments-horizontal" },
];

// ── ACL privileges (per-camera ACL editor) ───────────────────────────────
export const ACL_PRIVILEGES = [
  { value: "view_live", label: "View live" },
  { value: "playback", label: "Playback" },
  { value: "export", label: "Export" },
  { value: "ptz", label: "PTZ" },
  { value: "config", label: "Configure" },
];

// ── Default form shape for the onboard/edit modal ────────────────────────
export const DEFAULT_CAMERA_FORM = {
  name: "",
  brand: "onvif",
  connection_type: "onvif",
  is_enabled: true,
  // network
  ip: "",
  port: 80,
  rtsp_port: 554,
  // onvif creds
  onvif_host: "",
  onvif_port: 80,
  onvif_user: "admin",
  onvif_password: "",
  onvif_profile_token: "",
  // recording
  recording_mode: "continuous",
  recording_fps: "",
  record_substream: false,
  retention_days: 30,
  pre_buffer_seconds: 5,
  post_buffer_seconds: 5,
  anr_enabled: false,
  // ptz
  ptz_capable: false,
  // placement
  site_id: "",
  floor_id: "",
  zone_id: "",
};
