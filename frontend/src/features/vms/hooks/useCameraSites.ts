"use client";

// WHICH SITE A CAMERA IS AT — the join nothing was making.
//
// An alarm raised from a camera event carried no site, so the alarm map could
// place none of them and every site-scoped filter missed. The estate has the
// answer in two halves and nobody was putting them together:
//
//   * a camera's identity. An event names the NODE-SIDE id the recorder reported;
//     the estate knows that camera by a composite `fed:<node>:<cam>` key. Both
//     have to resolve, or a federated camera — which is every camera here — never
//     matches.
//   * where it is. `device_placements` is the truth for that: a device pinned to
//     a floor of a site. The synthetic `site_id` an estate camera carries is
//     `nvr:<node>` — the RECORDER, not a building — and using it would have put
//     alarms at a site that does not exist.
//
// So this resolves an event's camera id to a real site_id, or to null. Null is a
// real answer: a camera nobody has placed on a floor plan has no site, and
// guessing one would put a pin on the wrong building.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { sites as sitesApi } from "@/lib/api/sites";
import { asItems } from "@/lib/format";
import { useEstateCameras } from "./useEstateCameras";
import type { EstateCamera } from "../types";

export interface CameraSites {
  /** The site a camera is placed at, or null when nobody has placed it. */
  siteOf: (cameraId: string | null | undefined) => string | null;
  /** Every camera placed at a site, as the ESTATE knows them. */
  camerasAt: (siteId: string | null | undefined) => EstateCamera[];
  loading: boolean;
}

/** Both ids a camera answers to: the estate's own, and the node-side one an
 *  event carries. */
export function cameraKeys(c: EstateCamera): string[] {
  const real = (c as { real_id?: string }).real_id;
  return real ? [c.id, real] : [c.id];
}

export function useCameraSites(): CameraSites {
  const { cameras } = useEstateCameras();

  // The estate-wide placement index: device_id → site_id, four columns. One
  // request for the whole estate, rather than one per floor.
  const placementsQ = useQuery({
    queryKey: ["device-placements-index"],
    queryFn: () => sitesApi.devicePlacements.index(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const siteByDevice = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of asItems(placementsQ.data)) {
      if (row.device_id && row.site_id) m.set(row.device_id, row.site_id);
    }
    return m;
  }, [placementsQ.data]);

  const siteByCameraKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cameras) {
      // A placement is keyed on the ESTATE id (that is what the floor plan
      // pinned); an event carries the node-side one. Index both at the answer.
      const site = siteByDevice.get(c.id);
      if (!site) continue;
      for (const k of cameraKeys(c)) m.set(k, site);
    }
    return m;
  }, [cameras, siteByDevice]);

  const camerasBySite = useMemo(() => {
    const m = new Map<string, EstateCamera[]>();
    for (const c of cameras) {
      const site = siteByDevice.get(c.id);
      if (!site) continue;
      m.set(site, [...(m.get(site) || []), c]);
    }
    return m;
  }, [cameras, siteByDevice]);

  return {
    siteOf: (cameraId) => (cameraId ? siteByCameraKey.get(cameraId) ?? null : null),
    camerasAt: (siteId) => (siteId ? camerasBySite.get(siteId) ?? [] : []),
    loading: placementsQ.isLoading,
  };
}

export default useCameraSites;
