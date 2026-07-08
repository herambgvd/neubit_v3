"use client";

// Incident meta / overview — a badge row (status/priority/site/assignee + SLA and
// escalation chips) followed by a richer identity grid: SOP name + version,
// current state + when it was entered, priority, status, site, assignee, created,
// SLA deadline (with a remaining/breached indicator), escalation level, and tags.
// Resilient to missing keys — always falls back to "—".
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

function MetaField({ label, children, full }) {
  return (
    <div className={full ? "sm:col-span-2 lg:col-span-3" : ""}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 text-sm text-foreground">{children ?? "—"}</div>
    </div>
  );
}

export default function IncidentMeta({ instance, currentStateName }) {
  const inst = instance;
  const sla = slaInfo(inst.sla_deadline, inst.status);
  const escalationLevel = inst.escalation?.level ?? inst.escalation_level ?? 0;
  const stateName = currentStateName || inst.current_state_name || "—";
  const assignee =
    inst.assignee_name ||
    inst.assignee?.full_name ||
    inst.assignee?.email ||
    inst.assignment?.assigned_to_name ||
    inst.assignment?.assigned_to ||
    "Unassigned";
  const site = inst.site_name || inst.site_id || "No site";
  const tags = inst.tags?.length ? inst.tags : null;

  return (
    <div className="mb-4 rounded-xl border border-card-border bg-card">
      {/* Badge row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border px-5 py-3">
        <Badge color={STATUS_COLOR[inst.status] || "neutral"}>{titleize(inst.status)}</Badge>
        <Badge color={PRIORITY_COLOR[inst.priority] || "neutral"}>{titleize(inst.priority)} priority</Badge>
        <span className="inline-flex items-center gap-1 rounded-full bg-hover border border-card-border px-2.5 py-0.5 text-xs text-muted">
          <Icon icon="heroicons-outline:map-pin" className="text-sm" />
          {site}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-hover border border-card-border px-2.5 py-0.5 text-xs text-muted">
          <Icon icon="heroicons-outline:user" className="text-sm" />
          {assignee}
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

      {/* Identity grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetaField label="SOP">
          {inst.sop_name || "—"}
          {inst.sop_version != null && (
            <span className="ml-1 text-xs text-muted">v{inst.sop_version}</span>
          )}
        </MetaField>
        <MetaField label="Current state">{stateName}</MetaField>
        <MetaField label="State entered">{fmtDateTime(inst.state_entered_at)}</MetaField>
        <MetaField label="Status">{titleize(inst.status) || "—"}</MetaField>
        <MetaField label="Priority">{titleize(inst.priority) || "—"}</MetaField>
        <MetaField label="Site">{site}</MetaField>
        <MetaField label="Assignee">{assignee}</MetaField>
        <MetaField label="Created">{fmtDateTime(inst.created_at)}</MetaField>
        <MetaField label="SLA deadline">
          {inst.sla_deadline ? (
            <span className="inline-flex items-center gap-1.5">
              {fmtDateTime(inst.sla_deadline)}
              {sla && (
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${sla.color}`}>
                  {sla.breached ? "Breached" : sla.label.replace(/^SLA\s*/, "")}
                </span>
              )}
            </span>
          ) : (
            "—"
          )}
        </MetaField>
        <MetaField label="Escalation level">{`L${escalationLevel}`}</MetaField>
        {tags && (
          <MetaField label="Tags" full>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-card-border bg-hover px-2 py-0.5 text-[11px] text-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          </MetaField>
        )}
      </div>
    </div>
  );
}
