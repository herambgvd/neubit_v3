"use client";

// Floor-builder shared constants — ported from neubit_v2.
export const EDITOR_MODES = {
  VIEW: "view",
  ZONE_DRAW: "zone_draw",
  ZONE_EDIT: "zone_edit",
  // DEVICE_* modes are retained for the deferred device-placement phase (no devices
  // backend yet in neubit_v3). The Devices toolbar button is disabled — see toolbar.
  DEVICE_PLACE: "device_place",
  DEVICE_MOVE: "device_move",
};

export const TOOL_TYPES = {
  SELECT: "select",
  ZONE_POLYGON: "zone_polygon",
  CAMERA_PLACE: "camera_place",
  NVR_PLACE: "nvr_place",
  PAN: "pan",
  ZOOM_IN: "zoom_in",
  ZOOM_OUT: "zoom_out",
};

export const DEFAULT_ZONE_COLOR = "#2563eb";

// Backend canonical zone types (mirrors the sites config page enum).
export const ZONE_TYPES = [
  { value: "entrance", label: "Entrance" },
  { value: "parking", label: "Parking" },
  { value: "office", label: "Office" },
  { value: "lobby", label: "Lobby" },
  { value: "server_room", label: "Server room" },
  { value: "common_area", label: "Common area" },
  { value: "corridor", label: "Corridor" },
  { value: "cafeteria", label: "Cafeteria" },
  { value: "security", label: "Security" },
  { value: "emergency_exit", label: "Emergency exit" },
  { value: "other", label: "Other" },
];

export const THREAT_LEVELS = [
  { value: "normal", label: "Normal", dot: "bg-green-500" },
  { value: "elevated", label: "Elevated", dot: "bg-amber-500" },
  { value: "high", label: "High", dot: "bg-orange-500" },
  { value: "critical", label: "Critical", dot: "bg-red-500" },
  { value: "lockdown", label: "Lockdown", dot: "bg-slate-500" },
];

export const ZONE_PRESET_COLORS = [
  "#2563eb", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#0ea5e9", "#14b8a6",
];
