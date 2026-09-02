// Building Intelligence shared constants.
//
// The category vocabulary is the GATEWAY's, not ours: `points.category` carries
// what conflux classified the device as (contract §11/§12), and nothing on the
// platform can derive it. So this file only supplies PRESENTATION for the values
// that actually arrive — a label, an icon and an accent. A category that turns up
// here without an entry still renders, using its raw key. It is never invented.

// Permission key the backend gates every /bi route on
// (backend/reading-writer/app/api/router.py). Registered in core's catalog under
// "Building Intelligence" so a role can actually grant it.
export const PERM_READ = "bi.read";

// The WRITE key. It gates RETIRING a point — what is part of the estate at all —
// and never touches a measurement. It used to gate PLACING a device too; a device
// is now placed once, on the Sites floor plan, under core's own sites
// permissions. Registered in core's catalog beside bi.read, so it is grantable in
// the role editor rather than reachable only by a wildcard admin.
export const PERM_MANAGE = "bi.manage";

// Module the routes are gated by — "Dashboards & Reports" in the core module
// catalog. Building Intelligence is analytics over the reading store, so it rides
// that entitlement rather than inventing an eighth module.
export const MODULE = "analytics";

export interface CategoryMeta {
  key: string;
  label: string;
  icon: string;
  accent: string;
  /** The console route that owns this category, when one is built. */
  href?: string;
}

export const CATEGORY_META: Record<string, CategoryMeta> = {
  energy: {
    key: "energy",
    label: "Energy & Metering",
    icon: "heroicons:bolt",
    accent: "#fbbf24",
    href: "/bi/energy",
  },
  hvac: {
    key: "hvac",
    label: "HVAC & Assets",
    icon: "heroicons:cog-8-tooth",
    accent: "#67e8f9",
    href: "/bi/hvac",
  },
  water: {
    key: "water",
    label: "Water",
    icon: "heroicons:beaker",
    accent: "#60a5fa",
    // A console since 2026-08-31. This one line is what flips Portfolio's card
    // from inert, captioned "no console yet", to a link — the card was never
    // hiding the category, it just had nowhere to send anyone. `fire` still has
    // no href and must keep none: its one point has never produced a reading.
    href: "/bi/water",
  },
  fire: {
    key: "fire",
    label: "Fire & Safety",
    icon: "heroicons:fire",
    accent: "#f87171",
  },
};

export function categoryMeta(key: string | null | undefined): CategoryMeta {
  if (!key) {
    return {
      key: "",
      label: "Unclassified",
      icon: "heroicons:question-mark-circle",
      accent: "#9a92c8",
    };
  }
  return (
    CATEGORY_META[key] || {
      key,
      label: key,
      icon: "heroicons:cube",
      accent: "#a78bfa",
    }
  );
}

// Equipment-kind labels. Same rule: these come off the wire (`points.device_type`)
// and this only prettifies the spelling — an unknown kind renders as sent.
const DEVICE_TYPE_LABELS: Record<string, string> = {
  incomer: "Incomer",
  solar: "Solar",
  ups: "UPS",
  "distribution-board": "Distribution board",
  chiller: "Chiller",
  tfa: "TFA unit",
  "sump-pump": "Sump pump",
  "flow-meter": "Flow meter",
};

export const deviceTypeLabel = (t: string | null | undefined): string =>
  t ? DEVICE_TYPE_LABELS[t] || t : "Unclassified";

/** How a numeric reading is printed. NO unit is appended — there is none on the
 *  wire, and inventing one is the failure mode this whole feature must avoid.
 *  Text readings print verbatim; a point with nothing inside the API's lookback
 *  window prints an em dash rather than a stale number dressed as live. */
export function fmtReading(latest: any): string {
  if (!latest) return "—";
  if (latest.num === null || latest.num === undefined) {
    return latest.txt ?? "—";
  }
  const n = Number(latest.num);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 10) return n.toFixed(1);
  if (abs >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

/** Quality flag off the envelope (`q`). 0 = good; anything else is the device
 *  telling us the sample is suspect, and the UI must not hide that. */
export const qualityTone = (q: number | null | undefined) =>
  q === 0 || q === null || q === undefined ? "" : "text-nb-warn";
