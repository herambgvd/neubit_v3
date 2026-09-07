"use client";

// Cascading placement options for camera onboarding/edit: fetch the selected
// SITE's floors, then the selected FLOOR's zones — server-side filtered
// (site_id / floor_id) so we never over-fetch or trip the floors/zones list
// cap (le=100). Global `floors?limit=500` / `zones?limit=500` 422'd and would
// not scale past 100 floors/zones anyway; this is the correct enterprise shape.
import { useQuery } from "@tanstack/react-query";

import { sites as sitesApi } from "@/lib/api/sites";
import type { FloorPublic, ZonePublic } from "@/lib/types";

export function usePlacementFloorsZones(
  siteId: string | null | undefined,
  floorId: string | null | undefined,
): { floors: FloorPublic[]; zones: ZonePublic[] } {
  const floorsQ = useQuery({
    queryKey: ["vms-floors", siteId],
    queryFn: () => sitesApi.floors.list({ site_id: siteId ?? "", limit: 100 }),
    enabled: !!siteId,
    staleTime: 60_000,
  });
  const zonesQ = useQuery({
    queryKey: ["vms-zones", floorId],
    queryFn: () => sitesApi.zones.list({ floor_id: floorId ?? "", limit: 100 }),
    enabled: !!floorId,
    staleTime: 60_000,
  });
  // Read the envelope directly rather than through asItems: the queries are
  // typed, so `.items` is already FloorPublic[] / ZonePublic[], and asItems'
  // pass-through branch widened `undefined` (query not yet resolved) to unknown[].
  return {
    floors: siteId ? (floorsQ.data?.items ?? []) : [],
    zones: floorId ? (zonesQ.data?.items ?? []) : [],
  };
}

export default usePlacementFloorsZones;
