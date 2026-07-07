"use client";

// Incident list filter row — status / priority / site / SOP selects, a Clear
// button (only when a filter is set), and the count on the right. Fully
// controlled: parent owns the values and the setters.
import { Icon } from "@iconify/react";
import { titleize } from "@/lib/format";
import { INCIDENT_STATUSES, PRIORITIES } from "../../constants";

const selCls =
  "h-9 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted";

export default function IncidentFilters({
  status,
  priority,
  siteId,
  sopId,
  onStatus,
  onPriority,
  onSite,
  onSop,
  onClear,
  sites = [],
  sops = [],
  total,
}) {
  const hasFilter = status || priority || siteId || sopId;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select value={status} onChange={(e) => onStatus(e.target.value)} className={selCls}>
        <option value="" className="bg-card">All statuses</option>
        {INCIDENT_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-card">{titleize(s)}</option>
        ))}
      </select>
      <select value={priority} onChange={(e) => onPriority(e.target.value)} className={selCls}>
        <option value="" className="bg-card">All priorities</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p} className="bg-card">{titleize(p)}</option>
        ))}
      </select>
      <select value={siteId} onChange={(e) => onSite(e.target.value)} className={selCls}>
        <option value="" className="bg-card">All sites</option>
        {sites.map((s) => (
          <option key={s.site_id} value={s.site_id} className="bg-card">{s.name}</option>
        ))}
      </select>
      <select value={sopId} onChange={(e) => onSop(e.target.value)} className={selCls}>
        <option value="" className="bg-card">All SOPs</option>
        {sops.map((s) => (
          <option key={s.id ?? s.sop_id} value={s.id ?? s.sop_id} className="bg-card">{s.name}</option>
        ))}
      </select>
      {hasFilter && (
        <button
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-lg border border-card-border px-2.5 h-9 text-xs text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-sm" /> Clear
        </button>
      )}
      <span className="ml-auto text-xs text-muted">{total} incident(s)</span>
    </div>
  );
}
