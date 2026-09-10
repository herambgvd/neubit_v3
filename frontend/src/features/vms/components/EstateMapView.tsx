"use client";

// THE WALL'S MAP, WITH THE ESTATE IN FRONT OF IT.
//
// The map view opened straight onto a floor plan and made an operator pick the
// site from a dropdown — "where in this building" before anybody had asked "which
// building". The alarm console had the same fault and the same fix: the offline
// GIS basemap first, a pin per site carrying what a WALL operator cares about
// (cameras, and how many are dark), then that site's floor plan, then a camera
// onto the wall.
//
// ONE SITE IS NOT AN ESTATE. On a deployment with a single mappable site the extra
// step is a tax, not a feature, so the plan opens directly and the estate map is a
// button for when a second site exists. The screen adapts to the deployment rather
// than making every deployment pay for the largest one.
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { sites as sitesApi } from "@/lib/api/sites";
import { asItems } from "@/lib/format";
import type { SitePublic } from "@/lib/types";
import type { SiteWithCoords } from "@/features/core/sites/constants";
import { EMPTY_OPS, type SiteOps } from "@/features/core/sites/estateRollup";
import { useCameraSites } from "../hooks/useCameraSites";
import type { EstateCamera } from "../types";
import MapView from "./MapView";

// MapLibre reaches for `URL.createObjectURL` at module scope, so the basemap is
// loaded on demand — the wall must not pay for it until the map is opened.
const OfflineMapView = dynamic(
  () => import("@/features/core/sites/components/OfflineMapView"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-[12px] text-nb-muted">
        Loading the map…
      </div>
    ),
  },
);

export interface EstateMapViewProps {
  cameras?: EstateCamera[];
  onPick?: (camera: EstateCamera) => void;
}

/** Sites that can actually be drawn. A site without coordinates is not a pin. */
export function mappable(sites: SitePublic[]): SiteWithCoords[] {
  return sites.filter(
    (s): s is SiteWithCoords =>
      !!s.coordinates &&
      Number.isFinite(Number(s.coordinates.latitude)) &&
      Number.isFinite(Number(s.coordinates.longitude)),
  );
}

/** What a wall operator wants off a pin: how many cameras are there, and how many
 *  of them are dark. Alarms are somebody else's console and are left unsaid. */
export function cameraOps(camerasAt: (siteId: string) => EstateCamera[], siteId: string): SiteOps {
  const at = camerasAt(siteId);
  return {
    ...EMPTY_OPS,
    devices: at.length,
    cameras: at.length,
    offline: at.filter((c) => String(c.status).toLowerCase() !== "online").length,
  };
}

export default function EstateMapView({ cameras = [], onPick }: EstateMapViewProps) {
  const sitesQ = useQuery({
    queryKey: ["map-sites"],
    queryFn: () => sitesApi.list({ limit: 200 }),
  });
  const sites = useMemo<SitePublic[]>(() => asItems(sitesQ.data), [sitesQ.data]);
  const pins = useMemo(() => mappable(sites), [sites]);

  const { camerasAt } = useCameraSites();
  const ops = useMemo(() => {
    const m = new Map<string, SiteOps>();
    for (const s of pins) m.set(s.site_id, cameraOps(camerasAt, s.site_id));
    return m;
  }, [pins, camerasAt]);

  // A deep link (?site=…) is a request for that site's plan, and one mappable site
  // makes the estate step pointless. Either way the plan opens; `estate` is the
  // way back up, offered only when there is somewhere to go.
  const deepLinked = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("site");
  }, []);
  const [inPlan, setInPlan] = useState<boolean>(() => !!deepLinked);
  const single = pins.length === 1;
  const showPlan = inPlan || single || pins.length === 0;

  if (showPlan) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        {pins.length > 1 && (
          <button
            type="button"
            onClick={() => setInPlan(false)}
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-[rgba(150,180,245,.22)] px-2 py-1 text-[11.5px] text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
          >
            <Icon icon="heroicons-outline:arrow-left" className="text-xs" /> Estate map
          </button>
        )}
        <div className="min-h-0 flex-1">
          <MapView cameras={cameras} onPick={onPick} />
        </div>
      </div>
    );
  }

  const centre = pins[0];

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-[11px] border border-[rgba(150,180,245,.22)]">
      <OfflineMapView
        center={{
          lat: Number(centre.coordinates.latitude),
          lng: Number(centre.coordinates.longitude),
        }}
        zoom={5}
        sites={pins}
        selected={null}
        ops={ops}
        showAlarms={false}
        onSelect={() => setInPlan(true)}
        siteActions={(site) => (
          <button
            type="button"
            onClick={() => {
              // MapView reads ?site= once from the URL, so the drill-down sets it
              // there rather than inventing a second way to say the same thing.
              const url = new URL(window.location.href);
              url.searchParams.set("site", site.site_id);
              window.history.replaceState(null, "", url.toString());
              setInPlan(true);
            }}
            className="inline-flex items-center gap-1 rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
          >
            Floor plan
            <Icon icon="heroicons-outline:map" className="text-[10px]" />
          </button>
        )}
      />
    </div>
  );
}
