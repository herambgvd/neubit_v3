"use client";

// Right-pane detail for a selected site: header (name, code, type/status/threat
// pills, threat-level select + close/edit/delete actions), a shared TabBar, and
// the active tab body (info / building / floors / zones).
import { useMemo } from "react";
import { Icon } from "@iconify/react";
import { IconButton, PaneAction, PaneDeleteAction } from "@/components/console";
import { useAuth } from "@/lib/auth";
import { TabBar } from "@/components/common";
import type { SitePublic, ThreatLevel } from "@/lib/types";
import { THREAT_PILL, THREAT_LEVELS, capitalize } from "../constants";
import SiteInfoPanel from "./SiteInfoPanel";
import BuildingFactsPanel from "./BuildingFactsPanel";
import FloorsPanel from "./FloorsPanel";
import ZonesPanel from "./ZonesPanel";
import SelectMenu from "@/components/common/SelectMenu";

const TABS: { key: SiteDetailTab; label: string; icon: string }[] = [
  // `information-circle`, not a second building glyph: Site info is the address
  // and contact card, and it sat next to Building wearing the same icon.
  { key: "info", label: "Site info", icon: "heroicons:information-circle" },
  // The physical/commercial facts about the building — area, tariff, occupancy.
  // They live beside the address rather than on a Building Intelligence screen
  // for the same reason device placement lives on the floor plan (pipeline
  // contract §18): one place per fact.
  { key: "building", label: "Building", icon: "heroicons:building-office-2" },
  { key: "floors", label: "Floors", icon: "heroicons:square-3-stack-3d" },
  { key: "zones", label: "Zones", icon: "heroicons-outline:square-2-stack" },
];

export type SiteDetailTab = "info" | "building" | "floors" | "zones";

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
  const { can, hasModule } = useAuth();

  /**
   * BUILDING FACTS ARE A BUILDING-INTELLIGENCE SURFACE, not a site-management one.
   *
   * Area, tariff, occupancy and the emission factors exist to feed BI — nothing
   * in Sites, Floors, Zones or the VMS reads them. A tenant without that module
   * was being asked to fill in a form whose only consumer they do not have, and
   * the answer is the same gate every BI surface already uses (see
   * config/launcher.ts): the `analytics` module plus `bi.read`.
   *
   * `hasModule` is permissive while entitlements load, so the tab does not flash
   * out from under someone mid-render.
   */
  const showBuilding = hasModule("analytics") && can("bi.read");
  const tabs = useMemo(
    () => TABS.filter((t) => t.key !== "building" || showBuilding),
    [showBuilding],
  );
  // A tab can be selected and THEN become unavailable — an entitlement arriving
  // late, or a remembered tab from a tenant that had the module. Fall back rather
  // than render a body for a tab that is no longer in the bar.
  const activeTab = tab === "building" && !showBuilding ? "info" : tab;

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

      <TabBar tabs={tabs} active={activeTab} onChange={onTabChange} className="px-2" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === "info" ? (
          <SiteInfoPanel site={site} />
        ) : activeTab === "building" ? (
          <BuildingFactsPanel site={site} />
        ) : activeTab === "floors" ? (
          <FloorsPanel site={site} />
        ) : (
          <ZonesPanel site={site} />
        )}
      </div>
    </div>
  );
}
