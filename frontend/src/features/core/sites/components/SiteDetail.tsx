"use client";

// Right-pane detail for a selected site: header (name, code, type/status/threat
// pills, threat-level select + close/edit/delete actions), a shared TabBar, and
// the active tab body (info / floors / zones).
import { Icon } from "@iconify/react";
import { IconButton, PaneAction, PaneDeleteAction } from "@/components/console";
import { TabBar } from "@/components/common";
import type { SitePublic, ThreatLevel } from "@/lib/types";
import { THREAT_PILL, THREAT_LEVELS, capitalize } from "../constants";
import SiteInfoPanel from "./SiteInfoPanel";
import FloorsPanel from "./FloorsPanel";
import ZonesPanel from "./ZonesPanel";
import SelectMenu from "@/components/common/SelectMenu";

const TABS: { key: SiteDetailTab; label: string; icon: string }[] = [
  // `information-circle`, not a second building glyph: Site info is the address
  // and contact card, and it sat next to Building wearing the same icon.
  { key: "info", label: "Site info", icon: "heroicons:information-circle" },
  { key: "floors", label: "Floors", icon: "heroicons:square-3-stack-3d" },
  { key: "zones", label: "Zones", icon: "heroicons-outline:square-2-stack" },
];

export type SiteDetailTab = "info" | "floors" | "zones";

export interface SiteDetailProps {
  site: SitePublic;
  tab: SiteDetailTab;
  onTabChange: (tab: SiteDetailTab) => void;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onChangeThreat: (level: ThreatLevel) => void;
}

export default function SiteDetail({ site, tab, onTabChange, onClose, onEdit, onDelete, onChangeThreat }: SiteDetailProps) {
  /**
   * BUILDING FACTS ARE NOT HERE ANY MORE.
   *
   * Area, tariff, occupancy and the emission factors used to be a "Building" tab
   * on this pane. They are Building Intelligence inputs — the EPI's denominator
   * and the cost of a kWh — and nothing in Sites, Floors, Zones or the VMS reads
   * one of them. An operator configuring a site was being asked, halfway through
   * the address and the floor plan, for a tariff whose only consumer is a screen
   * in another console; and the console that DID consume them showed them
   * read-only with a link back here. Two surfaces, one fact, and the reader had
   * to know which was which.
   *
   * They now live where they are used and read: Building Intelligence → Ratings
   * → BUILDING. Recording one still needs `sites.update`, because `sites` is
   * still where the fact is STORED — what moved is the form, not the ownership.
   */

  // A remembered "building" tab from before that move would render no body at
  // all; fall back to the first one rather than an empty pane.
  const activeTab = TABS.some((t) => t.key === tab) ? tab : "info";

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
              // The options are THREAT_LEVELS, so the picked string is a ThreatLevel.
              onChange={(e) => onChangeThreat(e.target.value as ThreatLevel)}
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

      <TabBar tabs={TABS} active={activeTab} onChange={onTabChange} className="px-2" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === "info" ? (
          <SiteInfoPanel site={site} />
        ) : activeTab === "floors" ? (
          <FloorsPanel site={site} />
        ) : (
          <ZonesPanel site={site} />
        )}
      </div>
    </div>
  );
}
