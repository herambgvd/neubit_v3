// Sites domain constants — backend canonical enums, threat-level color maps, and
// the small helpers (capitalize, location-code generator) shared across the sites
// feature's detail panels, forms, and the map view. Extracted from views/Sites.jsx
// + views/SitesMap.jsx so every component reads one source of truth.

/* Backend canonical enums */
export const SITE_TYPES = [
  "building", "campus", "facility", "warehouse", "headquarters",
  "branch", "retail", "office", "factory", "other",
];
export const ZONE_TYPES = [
  "entrance", "parking", "office", "lobby", "server_room",
  "common_area", "corridor", "cafeteria", "security", "emergency_exit", "other",
];
export const THREAT_LEVELS = ["normal", "elevated", "high", "critical", "lockdown"];

export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Threat pills — fixed tailwind colors (opacity variants read fine on light + dark).
export const THREAT_PILL = {
  normal: "bg-green-500/10 text-green-500 border-green-500/20",
  elevated: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  high: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  critical: "bg-red-500/10 text-red-500 border-red-500/20",
  lockdown: "bg-hover text-foreground border-card-border",
};

// Map-marker tones (raw hex — used for Google Maps SymbolPath fill + info-window).
export const THREAT_PIN = {
  normal: { color: "#22c55e", label: "Normal" },
  elevated: { color: "#eab308", label: "Elevated" },
  high: { color: "#f97316", label: "High" },
  critical: { color: "#ef4444", label: "Critical" },
  lockdown: { color: "#1f2937", label: "Lockdown" },
};

const SITE_TYPE_PREFIX = {
  building: "BLD", campus: "CMP", facility: "FAC", warehouse: "WHS",
  headquarters: "HQ", branch: "BRN", retail: "RTL", office: "OFC",
  factory: "FCT", other: "STE",
};

export function generateLocationCode(siteType) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${SITE_TYPE_PREFIX[siteType] || "STE"}-${rand}`;
}
