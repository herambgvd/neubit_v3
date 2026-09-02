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
  { value: "event", label: "Event", icon: "heroicons-outline:bell-alert" },
  { value: "manual", label: "Manual", icon: "heroicons-outline:hand-raised" },
];

// ── Recording trigger → pill preset (recording.trigger_type) ─────────────
export const TRIGGER_PRESETS = {
  continuous: { label: "Continuous", cls: "bg-blue-500/10 text-blue-500 border-blue-500/20", icon: "heroicons-outline:film" },
  schedule: { label: "Schedule", cls: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20", icon: "heroicons-outline:calendar-days" },
  motion: { label: "Motion", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20", icon: "heroicons-outline:bolt" },
  event: { label: "Event", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20", icon: "heroicons-outline:bell-alert" },
  manual: { label: "Manual", cls: "bg-hover text-muted border-card-border", icon: "heroicons-outline:hand-raised" },
};

// ── Integrity status → dot color (recording.integrity_status) ────────────
export const INTEGRITY_PRESETS = {
  verified: { label: "Verified", dot: "bg-emerald-500", text: "text-emerald-500" },
  ok: { label: "Verified", dot: "bg-emerald-500", text: "text-emerald-500" },
  pending: { label: "Not verified", dot: "bg-muted", text: "text-muted" },
  unverified: { label: "Not verified", dot: "bg-muted", text: "text-muted" },
  failed: { label: "Corrupt", dot: "bg-red-500", text: "text-red-500" },
  corrupt: { label: "Corrupt", dot: "bg-red-500", text: "text-red-500" },
};

// ── Recording-schedule grid modes (weekly day×hour painter) ──────────────
// The schedule stores per-day 24-slot arrays; a slot value picks its cell color.
export const SCHEDULE_MODES = {
  record: { label: "Record", color: "bg-blue-500", swatch: "bg-blue-500" },
  motion: { label: "Motion", color: "bg-emerald-500", swatch: "bg-emerald-500" },
  off: { label: "Off", color: "bg-card-border", swatch: "bg-card-border" },
};

// ── Storage pool types (add-pool selector) ───────────────────────────────
export const POOL_TYPES = [
  { value: "local", label: "Local disk", icon: "heroicons-outline:server", hint: "A directory on the host filesystem" },
  { value: "nfs", label: "NFS", icon: "heroicons-outline:server-stack", hint: "Network File System export" },
  { value: "smb", label: "SMB / CIFS", icon: "heroicons-outline:server-stack", hint: "Windows / Samba share" },
  { value: "s3", label: "S3 / MinIO", icon: "heroicons-outline:cloud", hint: "S3-compatible object storage (cold tier)" },
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
  recording_schedule: null, // { Mon: [24 slots], … } — set when mode = schedule
  recording_fps: "",
  record_substream: false,
  retention_days: 30,
  pre_buffer_seconds: 5,
  post_buffer_seconds: 5,
  anr_enabled: false,
  audio_enabled: false,
  // recorder (media node) — "" = Auto / default node
  media_node_id: "",
  // ptz
  ptz_capable: false,
  // placement
  site_id: "",
  floor_id: "",
  zone_id: "",
};

// ── VMS camera device-event types (P5-A/C) ───────────────────────────────
// The normalized, brand-neutral vocabulary the whole platform speaks (see
// vision events.normalize.NORMALIZED_TYPES). Each carries a heroicon + a v3
// theme preset (chip class) so the Events feed / timeline markers / linkage
// editor all render a type identically.
export const EVENT_TYPE_PRESETS = {
  motion: { label: "Motion", icon: "heroicons-outline:bolt", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  tamper: { label: "Tamper", icon: "heroicons-outline:hand-raised", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  video_loss: { label: "Video loss", icon: "heroicons-outline:video-camera-slash", cls: "bg-red-500/10 text-red-500 border-red-500/20" },
  camera_online: { label: "Camera online", icon: "heroicons-outline:check-circle", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  camera_offline: { label: "Camera offline", icon: "heroicons-outline:x-circle", cls: "bg-red-500/10 text-red-500 border-red-500/20" },
  io_input: { label: "I/O input", icon: "heroicons-outline:arrows-right-left", cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  line_crossing: { label: "Line crossing", icon: "heroicons-outline:arrow-trending-up", cls: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" },
  zone_intrusion: { label: "Zone intrusion", icon: "heroicons-outline:shield-exclamation", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  audio: { label: "Audio alarm", icon: "heroicons-outline:speaker-wave", cls: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  recording_error: { label: "Recording error", icon: "heroicons-outline:exclamation-triangle", cls: "bg-red-500/10 text-red-500 border-red-500/20" },
  storage_low: { label: "Storage low", icon: "heroicons-outline:circle-stack", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  system: { label: "System", icon: "heroicons-outline:cog-6-tooth", cls: "bg-hover text-muted border-card-border" },
};

// A stable ORDER for selectors (feed filter + linkage trigger picker).
export const EVENT_TYPES = [
  "motion", "tamper", "video_loss", "camera_online", "camera_offline",
  "io_input", "line_crossing", "zone_intrusion", "audio",
  "recording_error", "storage_low", "system",
];

// Type-filter option list for the events feed ("" = all).
export const EVENT_TYPE_FILTERS = [
  { value: "", label: "All types" },
  ...EVENT_TYPES.map((t) => ({ value: t, label: EVENT_TYPE_PRESETS[t]?.label || t })),
];

// ── Event severity → v3 theme preset (P5-A/C) ────────────────────────────
// The driver/system severity (info|warning|critical) drives the row band, the
// scrub-bar marker color, and the severity filter.
export const SEVERITY_PRESETS = {
  critical: { label: "Critical", dot: "bg-red-500", text: "text-red-500", band: "bg-red-500", cls: "bg-red-500/10 text-red-500", fill: "#ef4444", rank: 3 },
  warning: { label: "Warning", dot: "bg-amber-500", text: "text-amber-500", band: "bg-amber-500", cls: "bg-amber-500/10 text-amber-500", fill: "#f59e0b", rank: 2 },
  info: { label: "Info", dot: "bg-blue-500", text: "text-blue-500", band: "bg-blue-500", cls: "bg-blue-500/10 text-blue-500", fill: "#3b82f6", rank: 1 },
};

export const SEVERITY_FILTERS = [
  { value: "", label: "All severities" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
];

// The action types the linkage editor offers (mirrors vision linkage ACTION_TYPES).
export const LINKAGE_ACTION_TYPES = [
  { value: "start_recording", label: "Start recording", icon: "heroicons-outline:film", hint: "Cut an event-clip with pre/post buffer" },
  { value: "notify", label: "Notify", icon: "heroicons-outline:bell-alert", hint: "Send on a channel (email / webhook / push)" },
  { value: "ptz_preset", label: "PTZ preset", icon: "heroicons-outline:viewfinder-circle", hint: "Move a PTZ camera to a preset" },
  { value: "trigger_output", label: "Trigger output", icon: "heroicons-outline:arrows-right-left", hint: "Pulse a camera relay / digital output" },
  { value: "popup", label: "Operator popup", icon: "heroicons-outline:window", hint: "Pop the camera live for the operator" },
];
