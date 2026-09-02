// Access-control shared constants — brands, status presets, filter option lists.
// Ported from neubit_v2 (lib/access-control/brands.js + per-tab STATUS maps),
// rethemed to neubit_v3's Vercel dark tokens (no light/dark class pairs; single
// token set that already flips with the theme).

// ── Onboardable brands (brand-picker) ────────────────────────────────
// Only DDS is available today; the rest render greyed with a "Coming soon" pill.
export const BRANDS = [
  {
    id: "dds",
    label: "DDS / Amadeus8",
    subtitle: "On-prem REST controller",
    icon: "heroicons-outline:server",
    accent: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    description:
      "DDS Amadeus8 servers with the API user enabled. Supports cardholders, cards, access groups and live event streaming.",
    available: true,
  },
  {
    id: "honeywell",
    label: "Honeywell ProWatch",
    subtitle: "Enterprise PAC",
    icon: "heroicons-outline:shield-check",
    accent: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    description:
      "Honeywell ProWatch SOAP/REST integration. Coming once the upstream API is finalized.",
    available: false,
  },
  {
    id: "lenel",
    label: "LenelS2",
    subtitle: "OnGuard / NetBox",
    icon: "heroicons-outline:key",
    accent: "bg-violet-500/10 text-violet-500 border-violet-500/20",
    description: "LenelS2 OnGuard or NetBox controllers. Roadmap.",
    available: false,
  },
  {
    id: "axis",
    label: "Axis A1001",
    subtitle: "Network door controller",
    icon: "heroicons-outline:signal",
    accent: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    description: "Axis VAPIX-based door controllers. Roadmap.",
    available: false,
  },
];

// ── Instance auth methods (onboard/edit) ─────────────────────────────
export const AUTH_METHODS = [
  { id: "basic", label: "Basic (user + API key)", icon: "heroicons-outline:key" },
  { id: "jwt", label: "JWT (user + password)", icon: "heroicons-outline:shield-check" },
];

// ── HealthBadge presets (instance.status) ────────────────────────────
export const HEALTH_PRESETS = {
  online: { label: "Online", icon: "heroicons-outline:check-circle", cls: "bg-emerald-500/10 text-emerald-500" },
  active: { label: "Online", icon: "heroicons-outline:check-circle", cls: "bg-emerald-500/10 text-emerald-500" },
  offline: { label: "Offline", icon: "heroicons-outline:x-circle", cls: "bg-hover text-muted" },
  inactive: { label: "Offline", icon: "heroicons-outline:x-circle", cls: "bg-hover text-muted" },
  error: { label: "Error", icon: "heroicons-outline:exclamation-circle", cls: "bg-red-500/10 text-red-500" },
  unknown: { label: "Unknown", icon: "heroicons-outline:question-mark-circle", cls: "bg-amber-500/10 text-amber-500" },
};

// ── Cardholder status → DDS display label + pill (matching v2) ───────
export const CARDHOLDER_STATUS = {
  active: { label: "Validated", cls: "bg-green-500/10 text-green-500" },
  suspended: { label: "Invalidated", cls: "bg-amber-500/10 text-amber-500" },
  expired: { label: "Archived", cls: "bg-hover text-muted" },
  terminated: { label: "Archived", cls: "bg-hover text-muted" },
};

export const CARDHOLDER_STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "active", label: "Validated" },
  { value: "suspended", label: "Invalidated" },
  { value: "expired", label: "Archived" },
  { value: "terminated", label: "Terminated" },
];

// ── Card statuses ────────────────────────────────────────────────────
export const CARD_STATUSES = ["Free", "Used", "Canceled", "Lost", "Stolen", "Archived"];

export const CARD_STATUS_FILTERS = [
  { value: "", label: "All" },
  ...CARD_STATUSES.map((s) => ({ value: s, label: s })),
];

export const CARD_STATUS_TONE = {
  Free: "bg-hover text-muted",
  Used: "bg-emerald-500/10 text-emerald-500",
  Canceled: "bg-amber-500/10 text-amber-500",
  Lost: "bg-red-500/10 text-red-500",
  Stolen: "bg-red-500/10 text-red-500",
  Archived: "bg-hover text-muted",
};

// ── Events feed filters ──────────────────────────────────────────────
export const RESULT_OPTIONS = [
  { value: "", label: "All" },
  { value: "granted", label: "Granted" },
  { value: "denied", label: "Denied" },
  { value: "unknown_card", label: "Unknown card" },
  { value: "forced", label: "Forced" },
  { value: "held", label: "Held" },
  { value: "tamper", label: "Tamper" },
  { value: "opened", label: "Opened" },
  { value: "closed", label: "Closed" },
  { value: "other", label: "Other" },
];

export const EVENT_CATEGORIES = [
  { key: "all", label: "All" },
  { key: "access", label: "Access" },
  { key: "alarm", label: "Alarm" },
  { key: "comm", label: "Comm" },
  { key: "technical", label: "Technical" },
  { key: "audit", label: "Audit" },
  { key: "general", label: "General" },
  { key: "io", label: "I/O" },
  { key: "health", label: "Health" },
];

// ── Hardware sections (read-only mirror sets) ────────────────────────
export const HARDWARE_SECTIONS = [
  { key: "sites", label: "Sites" },
  { key: "controllers", label: "Controllers" },
  { key: "readers", label: "Readers" },
  { key: "inputs", label: "Inputs" },
  { key: "outputs", label: "Outputs" },
  { key: "alarm_zones", label: "Alarm Zones" },
  { key: "areas", label: "Areas" },
];

export const PURPOSE_MAP = { 1: "Standard", 2: "Lift", 3: "Parking", 4: "Alarm" };

// Per-section column configs (matching v2's reference layout). `render` keys are
// handled in HardwareTab (kept data-only here so this file stays JSX-free).
export const HARDWARE_COLUMNS = {
  sites: [
    { key: "Name", header: "Name" },
    { key: "Description", header: "Description" },
    { key: "ApiKey", header: "API Key", mono: true },
    { key: "IsPolling", header: "Polling", pill: "onoff", on: "Polling", off: "Idle" },
  ],
  controllers: [
    { key: "Name", header: "Name" },
    { key: "Address", header: "Address" },
    { key: "Purpose", header: "Purpose", pill: "purpose" },
    { key: "IsConnected", header: "Online", pill: "onoff", on: "Online", off: "Offline" },
    { key: "FirmwareVersion", header: "Firmware", mono: true },
  ],
  readers: [
    { key: "Name", header: "Name" },
    { key: "Number", header: "Port" },
    { key: "ApiKey", header: "API Key", mono: true },
    { key: "ControllerUID", header: "Controller", mono: true, truncate: 12 },
    { key: "Description", header: "Description" },
  ],
  inputs: [
    { key: "Name", header: "Name" },
    { key: "Number", header: "Port" },
    { key: "IsArm", header: "Armed", pill: "onoff", on: "Armed", off: "Disarmed" },
    { key: "IsBypassed", header: "Bypassed", pill: "bypass" },
    { key: "ControllerUID", header: "Controller", mono: true, truncate: 12 },
  ],
  outputs: [
    { key: "Name", header: "Name" },
    { key: "Number", header: "Port" },
    { key: "ApiKey", header: "API Key", mono: true },
    { key: "ConstantState", header: "Default" },
    { key: "ControllerUID", header: "Controller", mono: true, truncate: 12 },
  ],
  alarm_zones: [
    { key: "Name", header: "Name" },
    { key: "IsArm", header: "State", pill: "onoff", on: "Armed", off: "Disarmed" },
    { key: "AlarmStatus", header: "Alarm Status" },
    { key: "Description", header: "Description" },
  ],
  areas: [
    { key: "Name", header: "Name" },
    { key: "UID", header: "UID", mono: true, truncate: 12 },
  ],
};

// ── Schedule editor ──────────────────────────────────────────────────
export const SCHEDULE_DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "UTC",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
];
