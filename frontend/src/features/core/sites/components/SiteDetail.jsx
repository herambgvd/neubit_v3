"use client";

// Right-pane detail for a selected site: header (name, code, type/status/threat
// pills, threat-level select + close/edit/delete actions), a shared TabBar, and
// the active tab body (info / floors / zones).
import { Icon } from "@iconify/react";
import { TabBar } from "@/components/common";
import { THREAT_PILL, THREAT_LEVELS, capitalize } from "../constants";
import SiteInfoPanel from "./SiteInfoPanel";
import FloorsPanel from "./FloorsPanel";
import ZonesPanel from "./ZonesPanel";

const TABS = [
  { key: "info", label: "Site info", icon: "heroicons-outline:building-office-2" },
  { key: "floors", label: "Floors", icon: "heroicons-outline:square-3-stack-3d" },
  { key: "zones", label: "Zones", icon: "heroicons-outline:square-2-stack" },
];

export default function SiteDetail({ site, tab, onTabChange, onClose, onEdit, onDelete, onChangeThreat }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500 shrink-0">
            <Icon icon="heroicons-outline:building-office-2" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{site.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted flex-wrap">
              {site.location_code && <span className="font-mono">{site.location_code}</span>}
              {site.site_type && (
                <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 font-medium capitalize">
                  {capitalize(site.site_type)}
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  site.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
                }`}
              >
                {site.is_active !== false ? "Active" : "Inactive"}
              </span>
              <span className={`rounded-full border px-2 py-0.5 font-medium uppercase tracking-wide ${THREAT_PILL[site.threat_level] || THREAT_PILL.normal}`}>
                Threat: {capitalize(site.threat_level || "normal")}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={site.threat_level || "normal"}
            onChange={(e) => onChangeThreat(e.target.value)}
            className="h-8 rounded-md border border-field bg-transparent px-2 text-xs text-foreground outline-none focus:border-muted"
            title="Set threat level"
          >
            {THREAT_LEVELS.map((t) => (
              <option key={t} value={t} className="bg-card text-foreground">{capitalize(t)}</option>
            ))}
          </select>
          <button onClick={onClose} title="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      <TabBar tabs={TABS} active={tab} onChange={onTabChange} className="px-2" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "info" ? (
          <SiteInfoPanel site={site} />
        ) : tab === "floors" ? (
          <FloorsPanel site={site} />
        ) : (
          <ZonesPanel site={site} />
        )}
      </div>
    </div>
  );
}
