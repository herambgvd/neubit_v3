"use client";

// IncidentMap — situational floor map for the alarm monitor.
//
// Flow: site selector (defaults to the first site) → floor selector (floors for
// that site) → a read-only SVG viewer that renders the floor-plan image + its
// zone polygons + incident markers.
//
// POSITIONING (and its documented fallbacks):
//   1. Only incidents whose `site_id` matches the selected site are candidates.
//   2. If an incident carries a zone hint (trigger_data.payload.data.zone, etc.)
//      that matches a zone on the floor by name, its marker is placed at that
//      zone's polygon centroid. Multiple incidents in one zone cluster into a
//      single counted marker.
//   3. Incidents for the site that have NO matching zone are "unplaced" — we do
//      NOT invent coordinates; instead they are listed in the side panel and can
//      still be opened.
//   4. Incidents with no `site_id` at all cannot be mapped to any site; a global
//      hint reports how many are unmapped so operators know the board is the
//      full picture. (All current seed incidents fall here — site_id is null.)
//
// The SVG viewBox is the floor image's natural pixel size, matching the
// floor-builder's coordinate space (zone polygons are image-pixel [x,y] pairs),
// so markers and polygons line up without extra transforms.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Badge } from "@/components/ui/kit";
import { fileUrl } from "@/lib/api";
import { asItems, titleize, fmtRelative } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { PRIORITY_COLOR } from "../../constants";
import MapMarker from "./MapMarker";
import { incId, incTitle, incZoneHint, incSiteRef, sev, prioWeight } from "./lib";

const DEFAULT_W = 1200;
const DEFAULT_H = 800;

function centroid(polygon = []) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of polygon) {
    sx += x;
    sy += y;
  }
  return [sx / polygon.length, sy / polygon.length];
}

// Match an incident's zone hint to a floor zone (case-insensitive, exact or
// substring on the zone name).
function matchZone(hint, zones) {
  if (!hint) return null;
  const h = String(hint).trim().toLowerCase();
  if (!h) return null;
  return (
    zones.find((z) => String(z.name || "").trim().toLowerCase() === h) ||
    zones.find((z) => String(z.name || "").toLowerCase().includes(h)) ||
    null
  );
}

export default function IncidentMap({ incidents = [], sites = [], siteName = {}, sopName = {} }: any) {
  const router = useRouter();
  const [siteId, setSiteId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [selectedId, setSelectedId] = useState<any>(null);
  const [img, setImg] = useState<any>({ w: DEFAULT_W, h: DEFAULT_H, ok: false });

  // Default to the first site once sites load.
  useEffect(() => {
    if (!siteId && sites.length) setSiteId(sites[0].site_id);
  }, [sites, siteId]);

  const floorsQ = useQuery<any>({
    queryKey: ["map-floors", siteId],
    queryFn: () => sitesApi.floors.list({ site_id: siteId, limit: 100 }),
    enabled: !!siteId,
  });
  const floors = asItems(floorsQ.data);

  // Default to the first floor of the selected site.
  useEffect(() => {
    if (floors.length && !floors.some((f) => f.floor_id === floorId)) {
      setFloorId(floors[0].floor_id);
    }
  }, [floors, floorId]);

  const floor = floors.find((f) => f.floor_id === floorId) || null;

  const zonesQ = useQuery<any>({
    queryKey: ["map-zones", floorId],
    queryFn: () => sitesApi.zones.list({ floor_id: floorId, limit: 200 }),
    enabled: !!floorId,
  });
  const zones = asItems(zonesQ.data);

  // Load the floor image to get its natural size for the viewBox.
  const planUrl = floor?.floorplan_url ? fileUrl(floor.floorplan_url) : null;
  useEffect(() => {
    setImg({ w: DEFAULT_W, h: DEFAULT_H, ok: false });
    if (!planUrl) return;
    const im = new Image();
    im.onload = () => setImg({ w: im.naturalWidth || DEFAULT_W, h: im.naturalHeight || DEFAULT_H, ok: true });
    im.onerror = () => setImg({ w: DEFAULT_W, h: DEFAULT_H, ok: false });
    im.src = planUrl;
  }, [planUrl]);

  // Split the site's incidents into placed (clustered by zone) + unplaced.
  const { clusters, unplaced, siteCount, unmappedNoSite } = useMemo(() => {
    const unmappedNoSite = incidents.filter((it) => !incSiteRef(it)).length;
    const forSite = incidents.filter((it) => incSiteRef(it) === siteId);
    const byZone = new Map<any, any>(); // zoneId -> { zone, items }
    const unplaced: any[] = [];
    for (const it of forSite) {
      const z = matchZone(incZoneHint(it), zones);
      if (z) {
        const c = byZone.get(z.zone_id) || { zone: z, items: [] };
        c.items.push(it);
        byZone.set(z.zone_id, c);
      } else {
        unplaced.push(it);
      }
    }
    const clusters: any[] = [];
    for (const { zone, items } of byZone.values()) {
      const ctr = centroid(zone.polygon);
      if (!ctr) {
        unplaced.push(...items);
        continue;
      }
      // Top priority in the cluster drives the marker color.
      const top = items.reduce((a, b) => (prioWeight(b.priority) > prioWeight(a.priority) ? b : a));
      clusters.push({ zone, items, x: ctr[0], y: ctr[1], priority: top.priority });
    }
    return { clusters, unplaced, siteCount: forSite.length, unmappedNoSite };
  }, [incidents, siteId, zones]);

  const openIncident = (it) => router.push(`/events/${incId(it)}`);

  const mapSelCls =
    "h-9 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(0,0,0,.28)] px-2.5 text-sm text-[#aec2e8] outline-hidden transition focus:border-[rgba(34,211,238,.5)]";

  return (
    <div className="overflow-hidden rounded-[13px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] backdrop-blur-xs">
      {/* Map toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[rgba(150,180,245,.22)] px-4 py-3">
        <Icon icon="heroicons-outline:map-pin" className="text-base text-[#67e8f9]" />
        <select
          value={siteId}
          onChange={(e) => { setSiteId(e.target.value); setFloorId(""); }}
          className={mapSelCls}
        >
          {sites.length === 0 && <option value="" className="bg-[#0c1530]">No sites</option>}
          {sites.map((s) => (
            <option key={s.site_id} value={s.site_id} className="bg-[#0c1530]">{s.name}</option>
          ))}
        </select>
        <select
          value={floorId}
          onChange={(e) => setFloorId(e.target.value)}
          disabled={!floors.length}
          className={`${mapSelCls} disabled:opacity-40`}
        >
          {floors.length === 0 && <option value="" className="bg-[#0c1530]">No floors</option>}
          {floors.map((f) => (
            <option key={f.floor_id} value={f.floor_id} className="bg-[#0c1530]">{f.name}</option>
          ))}
        </select>
        <span className="ml-auto font-mono text-[11px] uppercase tracking-[1px] text-[#7e93bf]">
          {siteCount} at this site · {clusters.reduce((n, c) => n + c.items.length, 0)} mapped
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_18rem]">
        {/* Canvas */}
        <div className="relative min-h-[420px] bg-[rgba(0,0,0,.28)]">
          {floorsQ.isLoading || zonesQ.isLoading ? (
            <div className="flex h-full items-center justify-center py-24"><Icon icon="svg-spinners:180-ring" className="text-2xl text-[#67e8f9]" /></div>
          ) : (
            <svg
              viewBox={`0 0 ${img.w} ${img.h}`}
              className="h-full max-h-[70vh] w-full"
              preserveAspectRatio="xMidYMid meet"
            >
              {/* Floor image or grid backdrop */}
              {planUrl && img.ok ? (
                <image href={planUrl} x="0" y="0" width={img.w} height={img.h} preserveAspectRatio="xMidYMid meet" />
              ) : (
                <>
                  <rect x="0" y="0" width={img.w} height={img.h} fill="transparent" />
                  <defs>
                    <pattern id="mapgrid" width="48" height="48" patternUnits="userSpaceOnUse">
                      <path d="M48 0H0V48" fill="none" stroke="currentColor" strokeWidth="1" className="text-card-border" opacity="0.5" />
                    </pattern>
                  </defs>
                  <rect x="0" y="0" width={img.w} height={img.h} fill="url(#mapgrid)" className="text-card-border" />
                </>
              )}

              {/* Zones */}
              {zones.map((z) =>
                Array.isArray(z.polygon) && z.polygon.length >= 3 ? (
                  <g key={z.zone_id}>
                    <polygon
                      points={z.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
                      fill={z.color || "#2563eb"}
                      fillOpacity="0.12"
                      stroke={z.color || "#2563eb"}
                      strokeOpacity="0.6"
                      strokeWidth="2"
                    />
                    {centroid(z.polygon) && (
                      <text
                        x={centroid(z.polygon)[0]}
                        y={centroid(z.polygon)[1] - 20}
                        textAnchor="middle"
                        fontSize="13"
                        className="fill-muted"
                      >
                        {z.name}
                      </text>
                    )}
                  </g>
                ) : null,
              )}

              {/* Incident markers */}
              {clusters.map((c) => (
                <MapMarker
                  key={c.zone.zone_id}
                  x={c.x}
                  y={c.y}
                  priority={c.priority}
                  count={c.items.length}
                  selected={c.items.some((it) => String(incId(it)) === String(selectedId))}
                  onClick={() =>
                    c.items.length === 1
                      ? openIncident(c.items[0])
                      : setSelectedId(String(incId(c.items[0])))
                  }
                  title={`${c.zone.name}: ${c.items.length} incident(s)`}
                />
              ))}
            </svg>
          )}

          {!planUrl && !floorsQ.isLoading && (
            <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(9,16,36,.9)] px-3 py-1.5 text-xs text-[#aec2e8] shadow-sm backdrop-blur-xs">
              <Icon icon="heroicons-outline:photo" className="mr-1 inline text-sm" />
              No floor plan uploaded — showing zones on a grid
            </div>
          )}
        </div>

        {/* Side panel: mapped clusters + unplaced fallback */}
        <div className="border-t border-[rgba(150,180,245,.22)] lg:border-l lg:border-t-0">
          <div className="max-h-[70vh] overflow-y-auto p-3">
            {unmappedNoSite > 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.1)] px-3 py-2 text-[11px] text-[#fbbf24]">
                <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
                <span className="text-[#aec2e8]">
                  <span className="font-medium text-[#fbbf24]">{unmappedNoSite}</span> incident(s) have no
                  site set and can&apos;t be placed on a map. See the Board for the full list.
                </span>
              </div>
            )}

            {/* Mapped clusters */}
            {clusters.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#7e93bf]">On this floor</div>
                <div className="space-y-1.5">
                  {clusters.map((c) =>
                    c.items.map((it) => (
                      <IncidentRow key={incId(it)} it={it} sopName={sopName} onOpen={() => openIncident(it)} zoneName={c.zone.name} />
                    )),
                  )}
                </div>
              </div>
            )}

            {/* Unplaced fallback */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#7e93bf]">
                Unplaced at this site
                <span className="rounded-sm border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1 text-[10px] text-[#aec2e8]">{unplaced.length}</span>
              </div>
              {unplaced.length === 0 ? (
                <p className="px-1 text-[11px] text-[#7e93bf]">
                  {siteCount === 0 ? "No incidents at this site." : "All site incidents are on a zone."}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {unplaced.map((it) => (
                    <IncidentRow key={incId(it)} it={it} sopName={sopName} onOpen={() => openIncident(it)} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function IncidentRow({ it, onOpen, zoneName, sopName = {} }: any) {
  const s = sev(it.priority);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-[10px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] px-2.5 py-2 text-left transition hover:border-[rgba(34,211,238,.4)] hover:bg-[rgba(150,180,245,.07)]"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[#f2f6ff]">{incTitle(it)}</span>
        <span className="block truncate font-mono text-[10px] text-[#7e93bf]">
          {zoneName ? `${zoneName} · ` : ""}{fmtRelative(it.created_at)}
        </span>
      </span>
      <Badge color={PRIORITY_COLOR[it.priority] || "neutral"}>{titleize(it.priority)}</Badge>
    </button>
  );
}
