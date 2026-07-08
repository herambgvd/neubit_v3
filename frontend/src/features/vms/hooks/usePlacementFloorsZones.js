"use client";

// Cascading placement options for camera onboarding/edit: fetch the selected
// SITE's floors, then the selected FLOOR's zones — server-side filtered
// (site_id / floor_id) so we never over-fetch or trip the floors/zones list
// cap (le=100). Global `floors?limit=500` / `zones?limit=500` 422'd and would
// not scale past 100 floors/zones anyway; this is the correct enterprise shape.
import { useQuery } from "@tanstack/react-query";

import { sites as sitesApi } from "@/lib/api/sites";
import { asItems } from "@/lib/format";

export function usePlacementFloorsZones(siteId, floorId) {
  const floorsQ = useQuery({
    queryKey: ["vms-floors", siteId],
    queryFn: () => sitesApi.floors.list({ site_id: siteId, limit: 100 }),
    enabled: !!siteId,
    staleTime: 60_000,
  });
  const zonesQ = useQuery({
    queryKey: ["vms-zones", floorId],
    queryFn: () => sitesApi.zones.list({ floor_id: floorId, limit: 100 }),
    enabled: !!floorId,
    staleTime: 60_000,
  });
  return {
    floors: siteId ? asItems(floorsQ.data) : [],
    zones: floorId ? asItems(zonesQ.data) : [],
  };
}

export default usePlacementFloorsZones;
