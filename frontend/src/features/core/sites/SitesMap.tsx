"use client";

// The estate map — every site the tenant runs, on one geographic canvas, with
// what each one is doing right now.
//
// It used to be a picture of where the buildings are: a threat-level pin per
// site, a name card, nothing else. A command centre asks a different question —
// WHERE IS TROUBLE — so a pin now carries the site's unacknowledged alarms and
// dark cameras (see estateRollup), the estate clusters instead of piling
// hundreds of overlapping teardrops on one another, and a pin leads into the
// site's floor plan instead of dead-ending.
//
// TWO CANVASES, one choice: the default is the OFFLINE basemap (MapLibre over a
// self-hosted PMTiles planet archive), which needs no internet at all. A tenant
// that has explicitly enabled Google Maps and saved a key gets Google instead —
// that toggle is the only switch, so nothing changes for installs already on it.
// Clustering and the map-side chrome are MapLibre's; the Google canvas shows the
// same rollup in its card. Config comes from the platform settings store via GET
// /settings/maps, NOT a build-time env var.
//
// Both canvases are code-split: whichever provider is off never ships its SDK.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Icon } from "@iconify/react";

import { api } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { DEFAULT_TILES_URL } from "@/lib/map/config";
import type { SitePublic } from "@/lib/types";
import type { MapsConfigOut } from "../types";
import type { SiteWithCoords } from "./constants";
import { Loading } from "./components/MapChrome";
import type { MapFocus } from "./components/OfflineMapView";
import { needsAttentionOnly } from "./estateFilters";
import type { SiteOps } from "./estateRollup";
import { siteSettingsHref } from "./siteLinks";
import useEstateOps from "./useEstateOps";

// ssr:false — both SDKs touch `window`/`document` at module scope.
const GoogleMapView = dynamic(() => import("./components/MapView"), { ssr: false, loading: Loading });
const OfflineMapView = dynamic(() => import("./components/OfflineMapView"), {
  ssr: false,
  loading: Loading,
});

const DEFAULT_CENTER = { lat: 22.9734, lng: 78.6569 }; // India centre
const DEFAULT_ZOOM = 5;
/** The API's own ceiling. The old 100 silently truncated a larger estate — and a
 *  site missing from a map reads as a site that does not exist. */
const SITE_LIMIT = 500;

export default function SitesMapPage() {
  const cfgQ = useQuery({
    queryKey: ["maps-config"],
    queryFn: () => api.get<MapsConfigOut>("/settings/maps").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const sitesQ = useQuery({
    queryKey: ["sites-map"],
    queryFn: () => sitesApi.list({ limit: SITE_LIMIT }),
  });

  const sites = useMemo(() => sitesQ.data?.items ?? [], [sitesQ.data]);
  const ops = useEstateOps();

  const apiKey = cfgQ.data?.api_key || "";
  // Google only when a tenant has BOTH turned it on and saved a key; every other
  // configuration — including a fresh install — gets the offline basemap.
  const useGoogle = !!cfgQ.data?.enabled && !!apiKey;
  const tilesUrl = cfgQ.data?.tiles_url || DEFAULT_TILES_URL;
  const defaultZoom = cfgQ.data?.default_zoom || DEFAULT_ZOOM;

  const sitesWithCoords = useMemo(
    () =>
      sites.filter(
        (s: SitePublic): s is SiteWithCoords =>
          typeof s.coordinates?.latitude === "number" && typeof s.coordinates?.longitude === "number",
      ),
    [sites],
  );

  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showLabels, setShowLabels] = useState(true);

  const filtered = useMemo(
    () => (attentionOnly ? needsAttentionOnly(sitesWithCoords, ops.bySite) : sitesWithCoords),
    [attentionOnly, sitesWithCoords, ops.bySite],
  );

  const [selected, setSelected] = useState<SiteWithCoords | null>(null);
  // A site picked from the header's lists. The seq makes a second pick of the
  // same site a fresh request (SCRUM-311).
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const showSite = (site: SiteWithCoords) => {
    // A filtered-out site would be focused on nothing.
    if (attentionOnly && !needsAttentionOnly([site], ops.bySite).length) setAttentionOnly(false);
    setSelected(site);
    setFocus((f) => ({ siteId: site.site_id, seq: (f?.seq ?? 0) + 1 }));
  };

  const center = useMemo(() => {
    if (sitesWithCoords.length === 0) {
      return cfgQ.data?.default_lat != null && cfgQ.data?.default_lng != null
        ? { lat: cfgQ.data.default_lat, lng: cfgQ.data.default_lng }
        : DEFAULT_CENTER;
    }
    const lat = sitesWithCoords.reduce((a, s) => a + s.coordinates.latitude, 0) / sitesWithCoords.length;
    const lng = sitesWithCoords.reduce((a, s) => a + s.coordinates.longitude, 0) / sitesWithCoords.length;
    return { lat, lng };
    // Centre off the WHOLE estate, not the filtered subset: toggling a filter
    // must not fly the camera somewhere else.
  }, [sitesWithCoords, cfgQ.data]);

  const attentionSites = useMemo(
    () => needsAttentionOnly(sitesWithCoords, ops.bySite),
    [sitesWithCoords, ops.bySite],
  );
  const unplacedSites = useMemo(
    () => sites.filter((s) => !sitesWithCoords.some((w) => w.site_id === s.site_id)),
    [sites, sitesWithCoords],
  );

  return (
    <div className="flex h-full flex-col gap-2">
      <EstateBar
        total={sitesWithCoords.length}
        unplacedSites={unplacedSites}
        attentionSites={attentionSites}
        ops={ops.bySite}
        onShowSite={showSite}
        failed={ops.failed}
        attentionOnly={attentionOnly}
        onAttentionOnly={setAttentionOnly}
        showLabels={showLabels}
        onShowLabels={setShowLabels}
      />

      <section className="sites-map-root relative min-h-0 flex-1 overflow-hidden rounded-xl border border-nb-line bg-white/5">
        {cfgQ.isLoading || sitesQ.isLoading ? (
          <Loading />
        ) : useGoogle ? (
          <GoogleMapView
            apiKey={apiKey}
            center={center}
            zoom={defaultZoom}
            sites={filtered}
            selected={selected}
            ops={ops.bySite}
            onSelect={setSelected}
            onClose={() => setSelected(null)}
            focus={focus}
          />
        ) : (
          <OfflineMapView
            tilesUrl={tilesUrl}
            center={center}
            zoom={defaultZoom}
            sites={filtered}
            selected={selected}
            ops={ops.bySite}
            showLabels={showLabels}
            onSelect={setSelected}
            onClose={() => setSelected(null)}
            focus={focus}
          />
        )}
      </section>
    </div>
  );
}

interface EstateBarProps {
  total: number;
  /** Sites with no coordinates — they have no pin, so this list is the only
   *  place on the map they can be found. */
  unplacedSites: SitePublic[];
  /** Sites with unacknowledged alarms or dark cameras. */
  attentionSites: SiteWithCoords[];
  ops: Map<string, SiteOps>;
  onShowSite: (site: SiteWithCoords) => void;
  failed: string[];
  attentionOnly: boolean;
  onAttentionOnly: (v: boolean) => void;
  showLabels: boolean;
  onShowLabels: (v: boolean) => void;
}

/** "2 alarms · 1 offline" — why a site is on the attention list. */
function attentionReason(o: SiteOps | undefined): string {
  if (!o) return "";
  const parts = [];
  if (o.alarms) parts.push(`${o.alarms} alarm${o.alarms === 1 ? "" : "s"}`);
  if (o.offline) parts.push(`${o.offline} offline`);
  return parts.join(" · ");
}

/** The map's own header: what is on it, what is wrong, and the two switches that
 *  change what is drawn.
 *
 *  Each count is a door, not a caption (SCRUM-311). "1 need attention" said there
 *  was trouble without saying where; "1 without coordinates" named a site the map
 *  cannot draw. Both now open the list they count: an attention site jumps the
 *  map to its pin, an unplaced one links to where its location is set. */
function EstateBar({
  total,
  unplacedSites,
  attentionSites,
  ops,
  onShowSite,
  failed,
  attentionOnly,
  onAttentionOnly,
  showLabels,
  onShowLabels,
}: Readonly<EstateBarProps>) {
  const [open, setOpen] = useState<"attention" | "unplaced" | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // A list closes on Escape or a click anywhere else, like every menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (which: "attention" | "unplaced") => setOpen((o) => (o === which ? null : which));

  return (
    <div
      ref={barRef}
      className="relative z-20 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)] px-3 py-2"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[1.2px] text-nb-muted">
        <Icon icon="heroicons-outline:globe-alt" className="text-sm text-nb-blueb" />
        Estate
        <span className="font-mono text-nb-faint">{total}</span>
      </span>

      {attentionSites.length > 0 ? (
        <span className="relative">
          <button
            type="button"
            onClick={() => toggle("attention")}
            aria-expanded={open === "attention"}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-nb-crit hover:bg-nb-crit/10"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-nb-crit shadow-[0_0_5px_#f87171]" />
            <span>{attentionSites.length} need attention</span>
            <Icon icon="heroicons-outline:chevron-down" className="text-[11px]" />
          </button>
          {open === "attention" && (
            <SiteList title="Need attention">
              {attentionSites.map((site) => (
                <li key={site.site_id}>
                  <button
                    type="button"
                    onClick={() => {
                      onShowSite(site);
                      setOpen(null);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-nb-blue/10"
                  >
                    <Icon icon="heroicons-outline:map-pin" className="shrink-0 text-[13px] text-nb-crit" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-nb-ink">{site.name}</span>
                    <span className="shrink-0 text-[10.5px] text-nb-muted">
                      {attentionReason(ops.get(site.site_id))}
                    </span>
                  </button>
                </li>
              ))}
            </SiteList>
          )}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[11px] text-nb-good">
          <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
          <span>All clear</span>
        </span>
      )}

      {unplacedSites.length > 0 && (
        <span className="relative">
          <button
            type="button"
            onClick={() => toggle("unplaced")}
            aria-expanded={open === "unplaced"}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-nb-warn hover:bg-nb-warn/10"
          >
            {unplacedSites.length} without coordinates
            <Icon icon="heroicons-outline:chevron-down" className="text-[11px]" />
          </button>
          {open === "unplaced" && (
            <SiteList title="Not on the map — no coordinates">
              {unplacedSites.map((site) => (
                <li key={site.site_id}>
                  <a
                    href={siteSettingsHref(site.site_id)}
                    title="Open the site, then Edit → Pick on map"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-nb-blue/10"
                  >
                    <Icon icon="heroicons-outline:building-office-2" className="shrink-0 text-[13px] text-nb-warn" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-nb-ink">{site.name}</span>
                    <span className="shrink-0 text-[10.5px] text-nb-blueb">Set location</span>
                  </a>
                </li>
              ))}
            </SiteList>
          )}
        </span>
      )}

      {failed.length > 0 && (
        <span
          className="text-[11px] text-nb-warn"
          title={`Could not read: ${failed.join(", ")}. The pins are drawn; the counts these feeds provide are not.`}
        >
          {failed.join(", ")} unavailable
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <BarToggle
          on={attentionOnly}
          onClick={() => onAttentionOnly(!attentionOnly)}
          icon="heroicons-outline:funnel"
          label="Needs attention"
        />
        <BarToggle
          on={showLabels}
          onClick={() => onShowLabels(!showLabels)}
          icon="heroicons-outline:tag"
          label="Labels"
        />
      </div>
    </div>
  );
}

function SiteList({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-nb-line bg-[rgb(8,15,34)] p-1 shadow-xl">
      <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-muted">{title}</p>
      <ul className="scroll-themed max-h-72 overflow-y-auto">{children}</ul>
    </div>
  );
}

function BarToggle({
  on,
  onClick,
  icon,
  label,
}: Readonly<{
  on: boolean;
  onClick: () => void;
  icon: string;
  label: string;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition ${
        on
          ? "border-nb-blue/50 bg-nb-blue/12 text-nb-blueb"
          : "border-nb-line text-nb-muted hover:border-nb-blue/30 hover:text-nb-soft"
      }`}
    >
      <Icon icon={icon} className="text-[13px]" />
      {label}
    </button>
  );
}
