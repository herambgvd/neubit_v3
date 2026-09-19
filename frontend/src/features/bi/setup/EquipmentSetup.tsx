"use client";

// Building Intelligence → Setup → EQUIPMENT (gate 4): the building's plant,
// drawn, with every machine the platform recognised already on the drawing as a
// dashed box to confirm (equipment/PlantCanvas.tsx).
//
// Rides BI's gate (`bi.read` + `analytics` to read, `bi.manage` to write).
// `?site=<uuid>&equipment=<uuid>` is the deep link `infraDesignerHref` builds —
// it opens that equipment where it sits; `?site=<uuid>&import=1`
// (`infraImportHref`) opens the I/O schedule import.
import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

import { ConsoleGrid, ConsolePage, ConsolePanel, EmptyPane } from "@/components/console";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import { useAuth } from "@/lib/auth";
import type { InfraVocabulary } from "@/lib/types";

import { MODULE, PERM_MANAGE, PERM_READ } from "../constants";
import BuildingList from "./BuildingList";
import PlantCanvas from "./equipment/PlantCanvas";
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
  const mayWrite = mayRead && can(PERM_MANAGE);
  const params = useSearchParams();
  const linkedSite = params?.get("site") ?? null;
  const linkedEquipment = params?.get("equipment") ?? null;
  const linkedImport = params?.get("import") === "1";

  const [picked, setPicked] = useState<string | null>(null);
  const { items } = useBuildings(mayRead);
  const siteId = picked ?? linkedSite ?? items[0]?.site_id ?? null;

  const vocabQ = useQuery<InfraVocabulary>({
    queryKey: ["infra-vocabulary"],
    queryFn: siteInfrastructure.vocabulary,
    staleTime: Infinity,
    enabled: mayRead,
  });

  if (!mayRead) {
    return (
      <ConsolePage>
        <p className="pt-6 text-[12.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <ConsoleGrid className="pt-1">
        <BuildingList selectedId={siteId} onSelect={setPicked} icon="heroicons-outline:cpu-chip" />
        <ConsolePanel>
          {!siteId ? (
            <EmptyPane icon="heroicons-outline:cpu-chip" title="No building selected" subtitle="Pick one from the list" />
          ) : vocabQ.error ? (
            <p className="px-5 py-5 text-[12.5px] text-nb-crit">{apiError(vocabQ.error, "Could not read the equipment types")}</p>
          ) : !vocabQ.data ? (
            <p className="py-16 text-center text-[13px] text-nb-faint">Loading…</p>
          ) : (
            <PlantCanvas
              key={siteId}
              siteId={siteId}
              vocab={vocabQ.data}
              mayWrite={mayWrite}
              // The linked equipment and the import belong to the linked building only.
              initialEquipmentId={siteId === linkedSite ? linkedEquipment : null}
              initialImporting={siteId === linkedSite && linkedImport}
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
