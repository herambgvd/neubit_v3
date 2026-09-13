// Audit-specific formatting helpers: badge color per action, human-readable
// phrasing per action code, and a one-line sentence describing an entry.
import type { AuditLogOut } from "../types";

/** The badge tones an action can map to — a subset of the kit's BadgeColor. */
export type AuditColor = "green" | "amber" | "red" | "blue" | "slate";

const ACTION_COLORS: Record<string, AuditColor> = {
  create: "green",
  update: "amber",
  delete: "red",
  revoke: "red",
  login: "blue",
  logout: "slate",
};

export function actionColor(action: string | null | undefined): AuditColor {
  const key = (action || "").toLowerCase();
  for (const [needle, color] of Object.entries(ACTION_COLORS)) {
    if (key.includes(needle)) return color;
  }
  return "slate";
}

// Human-readable phrasing per action code.
const ACTION_VERB: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "user.create": "Created user",
  "user.update": "Updated user",
  "user.delete": "Deleted user",
  "role.create": "Created role",
  "role.update": "Updated role",
  "role.delete": "Deleted role",
  "apikey.create": "Created API key",
  "apikey.revoke": "Revoked API key",
  "branding.update": "Updated branding",
};

function humanizeAction(action: string | null | undefined): string {
  if (!action) return "Activity";
  const [obj, verb] = action.split(".");
  const v = verb ? verb.charAt(0).toUpperCase() + verb.slice(1) : "";
  return `${v} ${obj}`.trim();
}

// Turn a raw entry into a plain-English sentence, pulling the specific target
// (name/email) out of `meta` so it reads like "Created user jane@example.com".
export function describe(r: Pick<AuditLogOut, "action" | "meta">): string {
  const base = ACTION_VERB[r.action] || humanizeAction(r.action);
  const m = r.meta || {};
  // `meta` is free-form, and one writer (the vision report endpoint) spreads a
  // caller-supplied dict into it — so the target is only a target when it is
  // scalar. Anything else has no name to print and the sentence drops it.
  const detail = [m.email, m.name, m.title].find((v) => typeof v === "string" || typeof v === "number");
  return detail === undefined ? base : `${base} · ${detail}`;
}

export function formatTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}
