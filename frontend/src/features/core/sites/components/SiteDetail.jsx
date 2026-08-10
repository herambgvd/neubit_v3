"use client";

// Right-pane detail for a selected site: header (name, code, type/status/threat
// pills, threat-level select + close/edit/delete actions), a shared TabBar, and
// the active tab body (info / floors / zones).
import { Icon } from "@iconify/react";
import { IconButton, PaneAction, PaneDeleteAction } from "@/components/console";
import { TabBar } from "@/components/common";
import { THREAT_PILL, THREAT_LEVELS, capitalize } from "../constants";
import SiteInfoPanel from "./SiteInfoPanel";
import FloorsPanel from "./FloorsPanel";
import ZonesPanel from "./ZonesPanel";
import SelectMenu from "@/components/common/SelectMenu";

const TABS = [
  { key: "info", label: "Site info", icon: "heroicons-outline:building-office-2" },
  { key: "floors", label: "Floors", icon: "heroicons-outline:square-3-stack-3d" },
  { key: "zones", label: "Zones", icon: "heroicons-outline:square-2-stack" },
];

export default function SiteDetail({ site, tab, onTabChange, onClose, onEdit, onDelete, onChangeThreat }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb shrink-0">
            <Icon icon="heroicons-outline:building-office-2" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{site.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-soft flex-wrap">
              {site.location_code && <span className="font-mono text-nb-faint">{site.location_code}</span>}
              {site.site_type && (
                <span className="rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb px-2 py-0.5 font-medium capitalize">
                  {capitalize(site.site_type)}
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 font-medium border ${
                  site.is_active !== false ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] text-nb-good" : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint"
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
          <span className="w-32" title="Set threat level">
            <SelectMenu
              value={site.threat_level || "normal"}
              onChange={(e) => onChangeThreat(e.target.value)}
              options={THREAT_LEVELS.map((t) => ({ value: t, label: capitalize(t) }))}
              className="!mt-0 !h-8 !text-xs"
            />
          </span>
          {/* Same header actions as UserDetail / RoleDetail. The × stays because
              here an empty selection is a real state (the list keeps a `closed`
              flag), unlike the other two consoles which re-select immediately. */}
          <IconButton icon="heroicons-outline:x-mark" title="Close" onClick={onClose} className="h-8 w-8" />
          <PaneAction icon="heroicons-outline:pencil-square" onClick={onEdit}>
            Edit
          </PaneAction>
          <PaneDeleteAction title="Delete site" onClick={onDelete} />
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
