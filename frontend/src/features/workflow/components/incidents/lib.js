"use client";

// Shared derivations for the alarm-monitor board/map. Centralises the incident
// field accessors (which vary by backend shape) and the SLA / elapsed / severity
// math so AlarmCard, StatHeader, PriorityBar and IncidentMap agree. Accessors
// mirror the ones already used in IncidentTable / IncidentMeta / IncidentActionBar
// so we never guess a field name.

import { PRIORITIES } from "../../constants";

// ── Field accessors (match IncidentTable / IncidentMeta / IncidentActionBar) ──
export const incId = (it) => it.instance_id ?? it.id;
export const incTitle = (it) =>
  it.name || it.title || it.reference || `Incident ${String(incId(it) || "").slice(0, 8)}`;
export const incSopName = (it, sopName = {}) =>
  it.sop_name || sopName[it.sop_id ?? it.sop?.id] || null;
export const incStateName = (it) => it.current_state_name || it.state_name || null;
export const incSiteRef = (it) => it.site_id ?? it.site?.site_id ?? null;
export const incSiteName = (it, siteName = {}) =>
  it.site_name || siteName[incSiteRef(it)] || null;
export const incAssignedId = (it) =>
  it.assigned_to ?? it.assignee_id ?? it.assignment?.assigned_to ?? null;
export const incAssigneeName = (it) =>
  it.assignee_name ||
  it.assignee?.full_name ||
  it.assignee?.email ||
  it.assignment?.assigned_to_name ||
  it.assignment?.assigned_to ||
  null;

// A best-effort zone *name* an incident is associated with. Seeded incidents
// carry it under trigger_data.payload.data.zone (e.g. "north"); we also honour a
// flat zone_name / zone if a future backend sets one. Used only for map hinting.
export const incZoneHint = (it) =>
  it.zone_name ||
  it.zone ||
  it.trigger_data?.payload?.data?.zone ||
  it.trigger_data?.data?.zone ||
  it.metadata?.zone ||
  null;

// ── Severity → v3 theme token buckets ────────────────────────────────────────
// PRIORITY_COLORS maps low→slate, medium→blue, high→amber, critical→red. We turn
// that into the concrete Tailwind tokens the cards / bar / markers use so the
// mapping lives in ONE place.
export const SEVERITY = {
  critical: { band: "bg-red-500", text: "text-red-500", ring: "border-red-500/30", soft: "bg-red-500/10", dot: "bg-red-500", fill: "#ef4444", label: "Critical" },
  high: { band: "bg-amber-500", text: "text-amber-500", ring: "border-amber-500/30", soft: "bg-amber-500/10", dot: "bg-amber-500", fill: "#f59e0b", label: "High" },
  medium: { band: "bg-blue-500", text: "text-blue-500", ring: "border-blue-500/30", soft: "bg-blue-500/10", dot: "bg-blue-500", fill: "#3b82f6", label: "Medium" },
  low: { band: "bg-slate-400", text: "text-muted", ring: "border-card-border", soft: "bg-hover", dot: "bg-slate-400", fill: "#94a3b8", label: "Low" },
};
export const sev = (p) => SEVERITY[p] || SEVERITY.low;

// A rough weight so we can sort "most urgent first".
const PRIO_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };
export const prioWeight = (p) => PRIO_WEIGHT[p] || 0;

const TERMINAL = new Set(["resolved", "completed", "cancelled"]);
export const isTerminal = (status) => TERMINAL.has(status);
export const isOpen = (status) => !TERMINAL.has(status);

// ── SLA ───────────────────────────────────────────────────────────────────
// Prefer an explicit sla_deadline; else derive a deadline from sla_hours +
// created_at (the shape the prompt guarantees). Returns null when there is no
// SLA at all, else { deadline, remainingMin, breached, overdue, label, tone }.
// `tone`: "ok" | "warn" | "breach" | "done".
export function slaFor(it, now = Date.now()) {
  const status = it.status;
  const deadline = it.sla_deadline
    ? new Date(it.sla_deadline).getTime()
    : it.sla_hours != null && it.created_at
      ? new Date(it.created_at).getTime() + Number(it.sla_hours) * 3600000
      : null;
  if (deadline == null || Number.isNaN(deadline)) return null;

  const remainingMin = (deadline - now) / 60000;
  const done = isTerminal(status);
  const breached = it.is_sla_breached === true || (!done && remainingMin < 0);
  const overdue = remainingMin < 0;

  const abs = (m) => {
    const a = Math.abs(m);
    if (a < 60) return `${Math.round(a)}m`;
    if (a < 1440) return `${Math.floor(a / 60)}h ${Math.round(a % 60)}m`;
    return `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h`;
  };

  if (done) return { deadline, remainingMin, breached: false, overdue, label: `SLA ${abs(remainingMin)}`, tone: "done" };
  if (overdue) return { deadline, remainingMin, breached: true, overdue, label: `Overdue ${abs(remainingMin)}`, tone: "breach" };
  if (remainingMin < 60) return { deadline, remainingMin, breached: false, overdue, label: `${abs(remainingMin)} left`, tone: "warn" };
  return { deadline, remainingMin, breached: false, overdue, label: `${abs(remainingMin)} left`, tone: "ok" };
}

// Is this incident breaching its SLA right now (open + past-deadline, or the
// backend flag)? Used for the "SLA breaching" stat tile.
export function isSlaBreaching(it, now = Date.now()) {
  if (!isOpen(it.status)) return false;
  const s = slaFor(it, now);
  return !!(s && s.overdue);
}

// "NEW" window: created (or first seen) within the last N seconds.
export const NEW_WINDOW_MS = 90000;
export function isNew(it, seenAt, now = Date.now()) {
  const created = it.created_at ? new Date(it.created_at).getTime() : null;
  if (created && now - created < NEW_WINDOW_MS) return true;
  if (seenAt && now - seenAt < NEW_WINDOW_MS) return true;
  return false;
}

// Order open incidents by priority, then SLA urgency, then recency. Terminal
// ones sink to the bottom.
export function sortForBoard(rows, now = Date.now()) {
  return [...rows].sort((a, b) => {
    const ao = isOpen(a.status) ? 1 : 0;
    const bo = isOpen(b.status) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const pw = prioWeight(b.priority) - prioWeight(a.priority);
    if (pw) return pw;
    const sa = slaFor(a, now)?.remainingMin ?? Infinity;
    const sb = slaFor(b, now)?.remainingMin ?? Infinity;
    if (sa !== sb) return sa - sb;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return cb - ca;
  });
}

// Priority mix (open only) → ordered [{priority,count,pct}] for the bar.
export function priorityMix(byPriority = {}) {
  const counts = PRIORITIES.map((p) => ({ priority: p, count: Number(byPriority[p]) || 0 }));
  const total = counts.reduce((s, c) => s + c.count, 0) || 0;
  return {
    total,
    // critical → low, left to right (most severe first).
    segments: [...counts]
      .reverse()
      .map((c) => ({ ...c, pct: total ? (c.count / total) * 100 : 0 })),
  };
}
