"use client";

// Incident meta badge row — status/priority badges, site, assignee, SLA chip,
// escalation chip, and the created-at on the right. Computes the SLA remaining
// display from the deadline + status.
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/kit";
import { titleize, fmtDateTime } from "@/lib/format";
import { STATUS_COLOR, PRIORITY_COLOR } from "../../constants";

// SLA remaining vs a deadline. Returns null (no SLA), or {breached, label, color}.
export function slaInfo(deadline, status) {
  if (!deadline) return null;
  const end = new Date(deadline).getTime();
  if (Number.isNaN(end)) return null;
  const terminal = status === "resolved" || status === "completed" || status === "cancelled";
  const diffMin = (end - Date.now()) / 60000;
  const fmt = (m) => {
    const a = Math.abs(m);
    if (a < 60) return `${Math.round(a)}m`;
    if (a < 1440) return `${Math.floor(a / 60)}h ${Math.round(a % 60)}m`;
    return `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h`;
  };
  if (terminal) return { breached: false, label: `SLA ${fmt(diffMin)}`, color: "bg-hover text-muted" };
  if (diffMin < 0) return { breached: true, label: `SLA breached ${fmt(diffMin)} ago`, color: "bg-red-500/10 text-red-500" };
  if (diffMin < 60) return { breached: false, label: `SLA due in ${fmt(diffMin)}`, color: "bg-amber-500/10 text-amber-500" };
  return { breached: false, label: `SLA in ${fmt(diffMin)}`, color: "bg-green-500/10 text-green-500" };
}

export default function IncidentMeta({ instance }) {
  const inst = instance;
  const sla = slaInfo(inst.sla_deadline, inst.status);
  const escalationLevel = inst.escalation?.level ?? inst.escalation_level ?? 0;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Badge color={STATUS_COLOR[inst.status] || "neutral"}>{titleize(inst.status)}</Badge>
      <Badge color={PRIORITY_COLOR[inst.priority] || "neutral"}>{titleize(inst.priority)} priority</Badge>
      <span className="inline-flex items-center gap-1 rounded-full bg-hover border border-card-border px-2.5 py-0.5 text-xs text-muted">
        <Icon icon="heroicons-outline:map-pin" className="text-sm" />
        {inst.site_name || "No site"}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-hover border border-card-border px-2.5 py-0.5 text-xs text-muted">
        <Icon icon="heroicons-outline:user" className="text-sm" />
        {inst.assignee_name || inst.assignee?.full_name || inst.assignee?.email || "Unassigned"}
      </span>
      {sla && (
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${sla.color}`}>
          <Icon icon="heroicons-outline:clock" className="text-sm" />
          {sla.label}
        </span>
      )}
      {escalationLevel > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 text-red-500 px-2.5 py-0.5 text-xs font-medium">
          <Icon icon="heroicons-outline:arrow-trending-up" className="text-sm" />
          Escalated · L{escalationLevel}
        </span>
      )}
      <span className="ml-auto text-xs text-muted">Created {fmtDateTime(inst.created_at)}</span>
    </div>
  );
}
