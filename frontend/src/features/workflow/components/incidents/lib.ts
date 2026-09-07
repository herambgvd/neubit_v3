"use client";

// Shared derivations for the alarm-monitor board/map. Centralises the incident
// field accessors and the SLA / elapsed / severity math so AlarmCard, StatHeader,
// PriorityBar and IncidentMap agree. Accessors mirror the ones already used in
// IncidentTable / IncidentMeta / IncidentActionBar so we never guess a field name.
// Every accessor reads `InstancePublic` (instances/schemas.py); the envelope
// look-ups go through `trigger_data`, whose payload is publisher-defined.

import { PRIORITIES } from "../../constants";
import { asStr, isRecord } from "../../types";
import type { InstancePublic, NameMap } from "../../types";

export type Incident = InstancePublic;

// ── Field accessors (match IncidentTable / IncidentMeta / IncidentActionBar) ──
export const incId = (it: Incident): string => it.instance_id;
export const incTitle = (it: Incident): string =>
  it.name || `Incident ${String(incId(it) || "").slice(0, 8)}`;
export const incSopName = (it: Incident, sopName: NameMap = {}): string | null =>
  it.sop_name || sopName[it.sop_id] || null;
export const incStateName = (it: Incident): string | null => it.current_state_name || null;
export const incSiteRef = (it: Incident): string | null => it.site_id ?? null;
export const incSiteName = (it: Incident, siteName: NameMap = {}): string | null => {
  const ref = incSiteRef(it);
  return (ref && siteName[ref]) || null;
};
export const incAssignedId = (it: Incident): string | null =>
  it.assigned_to ?? it.assignment?.assigned_to ?? null;
export const incAssigneeName = (it: Incident): string | null =>
  it.assignment?.assigned_to_name ||
  it.assignment?.assigned_to ||
  null;

// The envelope's payload, and its nested `data` block (ingest events), as dicts.
const envPayload = (it: Incident): Record<string, unknown> | null => {
  const p = it.trigger_data?.payload;
  return isRecord(p) ? p : null;
};
const envData = (it: Incident): Record<string, unknown> | null => {
  const d = envPayload(it)?.data;
  return isRecord(d) ? d : null;
};

// A best-effort camera id an incident is associated with. VMS camera events
// publish the camera under the trigger envelope's payload.camera_id (see vision
// events.normalize.event_payload); we also honour a few flatter shapes in case a
// future backend surfaces one. Used to add live camera media to the alarm card
// (P5-C). Returns null when the incident has no camera source.
export const incCameraId = (it: Incident): string | null =>
  asStr(envPayload(it)?.camera_id) ??
  asStr(it.trigger_data?.camera_id) ??
  asStr(envData(it)?.camera_id) ??
  null;

// A best-effort occurred-at ISO for an incident's source event — used to deep-link
// "View recording" to the event instant (falls back to the incident created_at).
export const incEventTime = (it: Incident): string | null =>
  asStr(envPayload(it)?.occurred_at) ||
  asStr(it.trigger_data?.occurred_at) ||
  it.created_at ||
  null;

// A best-effort zone *name* an incident is associated with. Seeded incidents
// carry it under trigger_data.payload.data.zone (e.g. "north"); we also honour a
// flat zone if a future backend sets one. Used only for map hinting.
export const incZoneHint = (it: Incident): string | null =>
  asStr(envData(it)?.zone) ||
  asStr(isRecord(it.trigger_data?.data) ? it.trigger_data.data.zone : undefined) ||
  asStr(it.metadata?.zone) ||
  null;

// ── Severity → v3 theme token buckets ────────────────────────────────────────
// PRIORITY_COLORS maps low→slate, medium→blue, high→amber, critical→red. We turn
// that into the concrete Tailwind tokens the cards / bar / markers use so the
// mapping lives in ONE place.
export interface SeverityStyle {
  band: string;
  text: string;
  ring: string;
  soft: string;
  dot: string;
  fill: string;
  label: string;
}

export const SEVERITY: Record<string, SeverityStyle> = {
  critical: { band: "bg-red-500", text: "text-red-500", ring: "border-red-500/30", soft: "bg-red-500/10", dot: "bg-red-500", fill: "#ef4444", label: "Critical" },
  high: { band: "bg-amber-500", text: "text-amber-500", ring: "border-amber-500/30", soft: "bg-amber-500/10", dot: "bg-amber-500", fill: "#f59e0b", label: "High" },
  medium: { band: "bg-blue-500", text: "text-blue-500", ring: "border-blue-500/30", soft: "bg-blue-500/10", dot: "bg-blue-500", fill: "#3b82f6", label: "Medium" },
  low: { band: "bg-slate-400", text: "text-muted", ring: "border-card-border", soft: "bg-hover", dot: "bg-slate-400", fill: "#94a3b8", label: "Low" },
};
export const sev = (p: string | null | undefined): SeverityStyle => (p && SEVERITY[p]) || SEVERITY.low;

// A rough weight so we can sort "most urgent first".
const PRIO_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
export const prioWeight = (p: string | null | undefined): number => (p && PRIO_WEIGHT[p]) || 0;

const TERMINAL = new Set<string>(["resolved", "completed", "cancelled"]);
export const isTerminal = (status: string | null | undefined): boolean => !!status && TERMINAL.has(status);
export const isOpen = (status: string | null | undefined): boolean => !isTerminal(status);

// ── SLA ───────────────────────────────────────────────────────────────────
// Prefer an explicit sla_deadline; else derive a deadline from sla_hours +
// created_at (the shape the prompt guarantees). Returns null when there is no
// SLA at all, else { deadline, remainingMin, breached, overdue, label, tone }.
// `tone`: "ok" | "warn" | "breach" | "done".
export interface SlaInfo {
  deadline: number;
  remainingMin: number;
  breached: boolean;
  overdue: boolean;
  label: string;
  tone: "ok" | "warn" | "breach" | "done";
}

export function slaFor(it: Incident, now = Date.now()): SlaInfo | null {
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

  const abs = (m: number): string => {
    const a = Math.abs(m);
    if (a < 60) return `${Math.round(a)}m`;
    if (a < 1440) return `${Math.floor(a / 60)}h ${Math.round(a % 60)}m`;
    return `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h`;
  };

  // `breached` carries the SERVER's is_sla_breached as well as the local clock
  // check; the four returns used to hardcode it from `overdue` alone, so an
  // incident the backend had marked breached read as on-time here.
  if (done) return { deadline, remainingMin, breached, overdue, label: `SLA ${abs(remainingMin)}`, tone: "done" };
  if (overdue) return { deadline, remainingMin, breached: true, overdue, label: `Overdue ${abs(remainingMin)}`, tone: "breach" };
  if (remainingMin < 60) return { deadline, remainingMin, breached, overdue, label: `${abs(remainingMin)} left`, tone: "warn" };
  return { deadline, remainingMin, breached, overdue, label: `${abs(remainingMin)} left`, tone: "ok" };
}

// Is this incident breaching its SLA right now (open + past-deadline, or the
// backend flag)? Used for the "SLA breaching" stat tile.
export function isSlaBreaching(it: Incident, now = Date.now()): boolean {
  if (!isOpen(it.status)) return false;
  const s = slaFor(it, now);
  return !!(s && s.overdue);
}

// "NEW" window: created (or first seen) within the last N seconds.
export const NEW_WINDOW_MS = 90000;
export function isNew(it: Incident, seenAt: number | null | undefined, now = Date.now()): boolean {
  const created = it.created_at ? new Date(it.created_at).getTime() : null;
  if (created && now - created < NEW_WINDOW_MS) return true;
  if (seenAt && now - seenAt < NEW_WINDOW_MS) return true;
  return false;
}

// Order open incidents by priority, then SLA urgency, then recency. Terminal
// ones sink to the bottom.
export function sortForBoard(rows: Incident[], now = Date.now()): Incident[] {
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

export interface PrioritySegment {
  priority: string;
  count: number;
  pct: number;
}

// Priority mix (open only) → ordered [{priority,count,pct}] for the bar.
export function priorityMix(byPriority: Record<string, number> | null | undefined = {}): {
  total: number;
  segments: PrioritySegment[];
} {
  const counts = PRIORITIES.map((p) => ({ priority: p, count: Number(byPriority?.[p]) || 0 }));
  const total = counts.reduce((s, c) => s + c.count, 0) || 0;
  return {
    total,
    // critical → low, left to right (most severe first).
    segments: [...counts]
      .reverse()
      .map((c) => ({ ...c, pct: total ? (c.count / total) * 100 : 0 })),
  };
}
