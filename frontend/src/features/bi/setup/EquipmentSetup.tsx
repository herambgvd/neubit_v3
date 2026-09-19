"use client";

// Building Intelligence → Setup → EQUIPMENT (gate 4): the plant designer.
//
// Pick a building, then describe its plant — systems, equipment, nameplate
// design facts, and the gateway point behind each slot. It used to be a tab on
// Configurations → Sites → a site; it is BI configuration, so it lives here and
// rides BI's gate (`bi.read` + `analytics` to read, `bi.manage` to write).
//
// `?site=<uuid>&equipment=<uuid>` is the deep link `infraDesignerHref` builds;
// `?site=<uuid>&import=1` (`infraImportHref`) opens the I/O schedule import.
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ConsoleGrid, ConsolePage, ConsolePanel, EmptyPane } from "@/components/console";
import { useAuth } from "@/lib/auth";

import { MODULE, PERM_READ } from "../constants";
import BuildingList from "./BuildingList";
import SetupHeader from "./SetupHeader";
import InfraDesigner from "./equipment/InfraDesigner";
import { useBuildings } from "./useBuildings";

export default function EquipmentSetup() {
  return (
    <Suspense fallback={null}>
      <EquipmentSetupInner />
    </Suspense>
  );
}

function EquipmentSetupInner() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const params = useSearchParams();
  const linkedSite = params?.get("site") ?? null;
  const linkedEquipment = params?.get("equipment") ?? null;
  const linkedImport = params?.get("import") === "1";

  const [picked, setPicked] = useState<string | null>(null);
  const { items } = useBuildings(mayRead);
  const siteId = picked ?? linkedSite ?? items[0]?.site_id ?? null;
  const site = items.find((s) => s.site_id === siteId) ?? null;

  if (!mayRead) {
    return (
      <ConsolePage>
        <SetupHeader task="equipment" />
        <p className="text-[11.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <SetupHeader task="equipment" desc="systems · equipment · design facts · the point behind each slot" />
      <ConsoleGrid>
        <BuildingList selectedId={siteId} onSelect={setPicked} icon="heroicons-outline:cpu-chip" />
        <ConsolePanel>
          {!siteId ? (
            <EmptyPane icon="heroicons-outline:cpu-chip" title="No building selected" subtitle="Pick one from the list" />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <h2 className="truncate px-6 pt-4 text-base font-semibold text-nb-ink">
                {site?.site_name || siteId}
              </h2>
              <InfraDesigner
                key={siteId}
                siteId={siteId}
                // The linked equipment belongs to the linked building only.
                initialEquipmentId={siteId === linkedSite ? linkedEquipment : null}
                // So is the import — it opens only where the link pointed.
                initialImporting={siteId === linkedSite && linkedImport}
              />
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
