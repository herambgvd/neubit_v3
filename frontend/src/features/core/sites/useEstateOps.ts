"use client";

// The three feeds behind the estate map's pins, joined into one rollup.
//
// Cross-service on purpose and in the browser, not in a new backend endpoint:
// the placements live in core, the camera status and the events live in vision,
// and neither service may read the other's database. The join key is the device
// id — the SAME id a placement is registered under and a camera is streamed by.
//
// Every feed degrades on its own. A failed event query costs the alarm badge and
// nothing else; the map still draws, because a map that refuses to render
// because one count is unavailable is worse than a map with one count missing.
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { sites as sitesApi } from "@/lib/api/sites";
import type { DevicePlacementIndexRow } from "@/lib/types";
import { vms } from "@/features/vms/api";
import type { EstateCamera, VmsEventPublic } from "@/features/vms/types";

import { rollupBySite, type SiteOps } from "./estateRollup";

/** Unacknowledged events are the alarm count; 500 is the API's own ceiling. */
const EVENT_LIMIT = 500;

export interface EstateOps {
  bySite: Map<string, SiteOps>;
  /** True while the first pass is still loading — pins draw without badges. */
  isLoading: boolean;
  /** A feed that failed. The map still renders; the badge it feeds does not. */
  failed: string[];
}

export function useEstateOps(): EstateOps {
  const [placementsQ, camerasQ, eventsQ] = useQueries({
    queries: [
      {
        queryKey: ["estate-placements"],
        queryFn: () => sitesApi.devicePlacements.index(),
        staleTime: 60_000,
      },
      {
        // The same key the wall uses, so opening the map after the wall costs
        // nothing and both stay on one cached copy of the estate.
        queryKey: ["vms-wall-cameras"],
        queryFn: () => vms.cameras.list({ limit: 500 }),
        refetchInterval: 20_000,
      },
      {
        queryKey: ["estate-open-events"],
        queryFn: () => vms.events.list({ acknowledged: false, limit: EVENT_LIMIT }),
        refetchInterval: 20_000,
      },
    ],
  });

  const bySite = useMemo(
    () =>
      rollupBySite({
        placements: (placementsQ.data?.items || []) as DevicePlacementIndexRow[],
        cameras: (camerasQ.data?.items || []) as EstateCamera[],
        events: (eventsQ.data?.items || []) as VmsEventPublic[],
      }),
    [placementsQ.data, camerasQ.data, eventsQ.data],
  );

  const failed = [
    placementsQ.isError ? "placements" : null,
    camerasQ.isError ? "cameras" : null,
    eventsQ.isError ? "events" : null,
  ].filter(Boolean) as string[];

  return {
    bySite,
    isLoading: placementsQ.isLoading || camerasQ.isLoading || eventsQ.isLoading,
    failed,
  };
}

export default useEstateOps;
