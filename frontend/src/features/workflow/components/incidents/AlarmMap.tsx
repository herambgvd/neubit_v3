"use client";

// WHERE THE ALARMS ARE, ON THE ESTATE.
//
// The map view opened straight onto a FLOOR PLAN — one building, one level, a
// grid of zones — which answers "where in this building" before anybody has
// asked "which building". On an estate with more than one site that is the wrong
// first question, and on this one it showed an empty grid for a level nothing had
// been placed on.
//
// So the map is the estate: the same offline GIS basemap the Sites console uses,
// a pin per site, and on each pin the number of OPEN alarms there. Picking a site
// narrows the queue to it — the rail beside the map is the list, so a click on
// the map and a click in the rail mean the same thing.
//
// The floor plan is still reachable, one step in, from the site card. It is the
// second question, and it is asked after the first.
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@iconify/react";

import type { SitePublic } from "@/lib/types";
import type { SiteWithCoords } from "@/features/core/sites/constants";
import { EMPTY_OPS, type SiteOps } from "@/features/core/sites/estateRollup";
import type { InstancePublic, NameMap } from "../../types";
import IncidentMap from "./IncidentMap";
import { incId, isOpen } from "./lib";

// Loaded on demand, like the Sites console does it: MapLibre reaches for
// `URL.createObjectURL` at module scope, so a static import drags a WebGL basemap
// into every render of the queue — and into every test that only wanted the list.
const OfflineMapView = dynamic(
  () => import("@/features/core/sites/components/OfflineMapView"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-[12px] text-muted">
        Loading the map…
      </div>
    ),
  },
);

export interface AlarmMapProps {
  incidents: InstancePublic[];
  sites: SitePublic[];
  selectedSiteId?: string;
  onSelectSite?: (siteId: string) => void;
  siteName?: NameMap;
  sopName?: NameMap;
}

/** A site is mappable when it carries real coordinates. Anything else cannot be
 *  drawn, and pretending otherwise puts a pin in the sea. */
export function mappableSites(sites: SitePublic[]): SiteWithCoords[] {
  return sites.filter(
    (s): s is SiteWithCoords =>
      !!s.coordinates &&
      Number.isFinite(Number(s.coordinates.latitude)) &&
      Number.isFinite(Number(s.coordinates.longitude)),
  );
}

/** Open alarms per site. The pin's badge is what would make somebody click it. */
export function alarmsBySite(incidents: InstancePublic[]): Map<string, SiteOps> {
  const by = new Map<string, SiteOps>();
  for (const it of incidents) {
    if (!it.site_id || !isOpen(it.status)) continue;
    const prev = by.get(it.site_id) ?? { ...EMPTY_OPS };
    by.set(it.site_id, { ...prev, alarms: prev.alarms + 1 });
  }
  return by;
}

export default function AlarmMap({
  incidents,
  sites,
  selectedSiteId = "",
  onSelectSite,
  siteName = {},
  sopName = {},
}: AlarmMapProps) {
  // INSIDE Alarms, not off in the video wall. The pin's "Floor plan" used to be a
  // link to /streaming?view=map — which left the console the operator was working
  // in, and landed on a screen that says "No floor plan uploaded" for a level
  // nothing was placed on. The plan is a view of THIS map now, with a way back.
  const [planFor, setPlanFor] = useState<string>("");
  const mappable = useMemo(() => mappableSites(sites), [sites]);
  const ops = useMemo(() => alarmsBySite(incidents), [incidents]);

  // Alarms the map CANNOT show: no site on the incident, or a site with no
  // coordinates. Said out loud, with the count, because a map that quietly omits
  // half the queue is worse than no map.
  const unmappable = useMemo(() => {
    const placed = new Set(mappable.map((s) => s.site_id));
    return incidents.filter((it) => isOpen(it.status) && (!it.site_id || !placed.has(it.site_id)));
  }, [incidents, mappable]);

  const selected = mappable.find((s) => s.site_id === selectedSiteId) ?? null;
  const centre = selected ?? mappable[0] ?? null;
  const planSite = sites.find((s) => s.site_id === planFor) ?? null;

  if (planSite) {
    return (
      <div className="grid h-full min-h-[24rem] content-start gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPlanFor("")}
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrow-left" className="text-xs" /> Back to the estate
          </button>
          <span className="text-[12px] text-foreground">{planSite.name}</span>
        </div>
        <IncidentMap
          incidents={incidents.filter((it) => it.site_id === planSite.site_id)}
          sites={[planSite]}
          siteName={siteName}
          sopName={sopName}
        />
      </div>
    );
  }

  if (mappable.length === 0) {
    return (
      <div className="flex h-full min-h-[20rem] flex-col items-center justify-center gap-2 rounded-xl border border-card-border bg-card p-8 text-center">
        <Icon icon="heroicons-outline:map" className="text-3xl text-muted opacity-40" />
        <p className="text-[13px] text-foreground">No site on the map yet</p>
        <p className="max-w-sm text-[11.5px] text-muted">
          A site appears here once it has coordinates. Set them under Configurations ·
          Sites, and the alarms raised there land on the map.
        </p>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-[24rem] gap-2">
      <div className="relative min-h-[20rem] flex-1 overflow-hidden rounded-xl border border-card-border">
        <OfflineMapView
          center={{
            lat: Number(centre!.coordinates.latitude),
            lng: Number(centre!.coordinates.longitude),
          }}
          zoom={selected ? 14 : 5}
          sites={mappable}
          selected={selected}
          ops={ops}
          onSelect={(site) => onSelectSite?.(site.site_id)}
          onClose={() => onSelectSite?.("")}
          siteActions={(site) => (
            <>
              <button
                type="button"
                onClick={() => setPlanFor(site.site_id)}
                className="inline-flex items-center gap-1 rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
              >
                Floor plan
                <Icon icon="heroicons-outline:map" className="text-[10px]" />
              </button>
              <button
                type="button"
                onClick={() => onSelectSite?.(site.site_id)}
                className="inline-flex items-center gap-1 rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
              >
                Alarms here
                <Icon icon="heroicons-outline:funnel" className="text-[10px]" />
              </button>
            </>
          )}
        />
      </div>

      {unmappable.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-200">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
          <span>
            {unmappable.length} open alarm{unmappable.length === 1 ? "" : "s"} cannot be placed —
            {unmappable.some((it) => !it.site_id)
              ? " raised with no site, or "
              : " "}
            at a site with no coordinates. They are all in the queue beside this map.
          </span>
        </p>
      )}
    </div>
  );
}

/** Exported for the queue: which incidents a map selection narrows to. */
export const atSite = (incidents: InstancePublic[], siteId: string): string[] =>
  incidents.filter((it) => it.site_id === siteId).map(incId);
