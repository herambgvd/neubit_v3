"use client";

// Building Intelligence → Setup → ABOUT THE BUILDING: the few facts no sensor
// sends, one building at a time (facts/FactsRecord.tsx).
//
// What is missing leads as work, each saying which figure it holds up; what is
// on file sits below as a record with its source and date. The form that used to
// be here asked for occupancy and a city as well — nothing reads either, so
// neither is asked for any more.
//
// The facts are stored on the site, so every write needs `sites.update`; the
// record itself is read through BI's own mirror behind `bi.read` + analytics.
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ConsoleGrid, ConsolePage, ConsolePanel, EmptyPane } from "@/components/console";
import { useAuth } from "@/lib/auth";

import { MODULE, PERM_READ, PERM_SITES_UPDATE } from "../constants";
import BuildingList from "./BuildingList";
import FactsRecord from "./facts/FactsRecord";
import { useBuildings } from "./useBuildings";

export default function FactsSetup() {
  return (
    <Suspense fallback={null}>
      <FactsSetupInner />
    </Suspense>
  );
}

function FactsSetupInner() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const mayWrite = mayRead && can(PERM_SITES_UPDATE);
  const params = useSearchParams();
  const linked = params?.get("site") ?? null;

  const [picked, setPicked] = useState<string | null>(null);
  const { items } = useBuildings(mayRead);
  const siteId = picked ?? linked ?? items[0]?.site_id ?? null;

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
        <BuildingList selectedId={siteId} onSelect={setPicked} icon="heroicons-outline:building-office-2" />
        <ConsolePanel className="px-5 py-4">
          {siteId ? (
            <FactsRecord key={siteId} siteId={siteId} mayWrite={mayWrite} />
          ) : (
            <EmptyPane
              icon="heroicons-outline:building-office-2"
              title="No building selected"
              subtitle="Pick one from the list"
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
