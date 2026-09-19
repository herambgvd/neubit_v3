"use client";

// Building Intelligence → Setup → BUILDING FACTS: area, tariff (+ time-of-use
// slabs), occupancy and grid emission factors, one building at a time.
//
// The form moved here from Ratings; Ratings keeps DISPLAYING what it divides by
// and links here. The facts are stored on the site, so reading the whole record
// needs `sites.read` and every write `sites.update` — the keys the endpoints
// enforce. Without `sites.read` the building still shows what BI's own mirror
// holds, read-only.
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  InfoCell,
  LoadingBlock,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import sitesApi from "@/lib/api/sites";
import type { BiSiteFactsRow } from "@/lib/types";

import BuildingFactsPanel from "../components/building/BuildingFactsPanel";
import { MODULE, PERM_READ, PERM_SITES_READ } from "../constants";
import BuildingList from "./BuildingList";
import SetupHeader from "./SetupHeader";
import { useBuildings } from "./useBuildings";

const mark = (ok: boolean) => (ok ? "✓" : "✗");

function FactMarks({ row }: Readonly<{ row: BiSiteFactsRow }>) {
  const area = row.gross_floor_area_sqm != null;
  const tariff = row.energy_tariff_per_kwh != null;
  return (
    <>
      <span className={area ? "text-nb-good" : "text-nb-warn"}>area {mark(area)}</span>
      <span className={tariff ? "text-nb-good" : "text-nb-faint"} title="flat tariff; time-of-use slabs are on the building">
        tariff {mark(tariff)}
      </span>
    </>
  );
}

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
  const mayReadRecord = can(PERM_SITES_READ);
  const linkedSite = useSearchParams()?.get("site") ?? null;

  const [picked, setPicked] = useState<string | null>(null);
  const { items } = useBuildings(mayRead);
  const siteId = picked ?? linkedSite ?? items[0]?.site_id ?? null;
  const mirror = items.find((s) => s.site_id === siteId) ?? null;

  // The full site row: the mirror carries the headline numbers but not the
  // slabs or the factors, and the form writes back to `sites`.
  const recordQ = useQuery({
    queryKey: ["site", siteId],
    queryFn: () => sitesApi.get(siteId as string),
    enabled: mayRead && mayReadRecord && !!siteId,
  });

  if (!mayRead) {
    return (
      <ConsolePage>
        <SetupHeader task="facts" />
        <p className="text-[11.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <SetupHeader task="facts" desc="area · tariff · occupancy · emission factor — typed by a person, never defaulted" />
      <ConsoleGrid>
        <BuildingList selectedId={siteId} onSelect={setPicked} meta={(row) => <FactMarks row={row} />} />
        <ConsolePanel>
          {!siteId ? (
            <EmptyPane icon="heroicons-outline:building-office-2" title="No building selected" subtitle="Pick one from the list" />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <h2 className="truncate px-6 pt-4 text-base font-semibold text-nb-ink">
                {mirror?.site_name || recordQ.data?.name || siteId}
              </h2>
              {!mayReadRecord ? (
                <div className="space-y-2 px-6 py-4">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    <InfoCell
                      label="Gross floor area"
                      value={mirror?.gross_floor_area_sqm != null ? `${mirror.gross_floor_area_sqm.toLocaleString()} m²` : "not recorded"}
                      mono
                    />
                    <InfoCell
                      label="Tariff"
                      value={
                        mirror?.energy_tariff_per_kwh != null
                          ? `${mirror.energy_tariff_per_kwh} ${mirror.tariff_currency || ""}/kWh`
                          : "not recorded"
                      }
                      mono
                    />
                    <InfoCell label="Occupancy" value={mirror?.occupancy != null ? String(mirror.occupancy) : "not recorded"} mono />
                  </div>
                  <p className="text-[11px] text-nb-faint">
                    read-only · the full record needs <span className="font-mono">sites.read</span>
                  </p>
                </div>
              ) : recordQ.isLoading ? (
                <LoadingBlock label="Loading the building…" />
              ) : recordQ.error ? (
                // A failed read must not render an empty form: saving it would
                // write blanks over numbers that are actually there.
                <p className="px-6 py-4 text-[12px] text-nb-crit">
                  {apiError(recordQ.error, "Couldn't load this building's record")}
                </p>
              ) : recordQ.data ? (
                <BuildingFactsPanel site={recordQ.data} />
              ) : null}
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
