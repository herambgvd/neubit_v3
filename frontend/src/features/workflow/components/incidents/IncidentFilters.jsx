"use client";

// Incident list filter row — status / priority / site / SOP selects, a Clear
// button (only when a filter is set), and the count on the right. Fully
// controlled: parent owns the values and the setters.
import { Icon } from "@iconify/react";
import { titleize } from "@/lib/format";
import { INCIDENT_STATUSES, PRIORITIES, INCIDENT_SOURCES } from "../../constants";

const selCls =
  "h-9 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(0,0,0,.28)] px-2.5 text-sm text-[#aec2e8] outline-hidden transition focus:border-[rgba(34,211,238,.5)]";

export default function IncidentFilters({
  qInput,
  onQInput,
  status,
  priority,
  siteId,
  sopId,
  source,
  onStatus,
  onPriority,
  onSite,
  onSop,
  onSource,
  onClear,
  sites = [],
  sops = [],
  total,
}) {
  const hasFilter = qInput || status || priority || siteId || sopId || source;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <label className="relative min-w-[220px] flex-1">
        <Icon
          icon="heroicons-outline:magnifying-glass"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#7e93bf]"
        />
        <input
          value={qInput}
          onChange={(e) => onQInput(e.target.value)}
          placeholder="camera · rule · plate…"
          className="h-9 w-full rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(0,0,0,.28)] pl-8 pr-7 font-mono text-[12px] text-[#f2f6ff] placeholder:text-[#7e93bf] outline-hidden transition focus:border-[rgba(34,211,238,.5)]"
        />
        {qInput ? (
          <button
            type="button"
            onClick={() => onQInput("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[#7e93bf] hover:text-[#67e8f9]"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-sm" />
          </button>
        ) : null}
      </label>

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
      <select
        value={source}
        onChange={(e) => onSource(e.target.value)}
        className={selCls}
        title="Originating source of the incident"
      >
        {INCIDENT_SOURCES.map((s) => (
          <option key={s.value} value={s.value} className="bg-card">{s.label}</option>
        ))}
      </select>
      {hasFilter && (
        <button
          onClick={onClear}
          className="inline-flex h-9 items-center gap-1 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2.5 text-xs text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-sm" /> Clear
        </button>
      )}
      <span className="ml-auto font-mono text-[11px] uppercase tracking-[1px] text-[#7e93bf]">
        Showing <b className="text-[#f2f6ff]">{total}</b> incident(s)
      </span>
    </div>
  );
}
