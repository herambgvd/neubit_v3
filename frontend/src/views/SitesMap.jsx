"use client";

// Sites Map — every site with coordinates rendered as a Google Maps marker, colored by
// threat level, with an info window showing site details. Ported from neubit_v2's
// app/(app)/map/page.jsx and adapted to neubit_v3:
//   • API key comes from process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (a build-time public
//     env var) instead of neubit_v2's platform-settings proxy. If it's unset we render a
//     graceful "Maps not configured" placeholder rather than crashing.
//   • Camera-count badges were dropped (no cameras backend in neubit_v3 yet).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from "@react-google-maps/api";
import { Icon } from "@iconify/react";

import { Button, PageHeader, Spinner } from "@/components/ui/kit";
import { sites as sitesApi } from "@/lib/api/sites";

const CONTAINER_STYLE = { width: "100%", height: "100%" };
const MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";

const THREAT_PIN = {
  normal: { color: "#22c55e", label: "Normal" },
  elevated: { color: "#eab308", label: "Elevated" },
  high: { color: "#f97316", label: "High" },
  critical: { color: "#ef4444", label: "Critical" },
  lockdown: { color: "#1f2937", label: "Lockdown" },
};

const DEFAULT_CENTER = { lat: 22.9734, lng: 78.6569 }; // India centre
const DEFAULT_ZOOM = 5;

export default function SitesMapPage() {
  const sitesQ = useQuery({
    queryKey: ["sites-map"],
    queryFn: () => sitesApi.list({ limit: 100 }),
  });

  const sites = sitesQ.data?.items || [];

  const sitesWithCoords = useMemo(
    () =>
      sites.filter(
        (s) =>
          typeof s.coordinates?.latitude === "number" && typeof s.coordinates?.longitude === "number",
      ),
    [sites],
  );

  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sitesWithCoords;
    return sitesWithCoords.filter((s) =>
      [s.name, s.location_code, s.address?.city, s.address?.state]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [sitesWithCoords, search]);

  const [selected, setSelected] = useState(null);

  const center = useMemo(() => {
    if (filtered.length === 0) return DEFAULT_CENTER;
    const lat = filtered.reduce((a, s) => a + s.coordinates.latitude, 0) / filtered.length;
    const lng = filtered.reduce((a, s) => a + s.coordinates.longitude, 0) / filtered.length;
    return { lat, lng };
  }, [filtered]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Sites Map"
        subtitle={`${sites.length} sites · ${sitesWithCoords.length} with coordinates`}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-sm" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter sites…"
                className="h-9 w-56 rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
              />
            </div>
            <Link
              href="/sites"
              className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
            >
              <Icon icon="heroicons-outline:cog-6-tooth" className="text-base" />
              Configure
            </Link>
          </div>
        }
      />

      <section className="sites-map-root relative min-h-0 flex-1 overflow-hidden rounded-xl border border-card-border bg-hover/40" style={{ minHeight: "60vh" }}>
        <MapPopupStyleFix />
        {!MAPS_API_KEY ? (
          <Disabled />
        ) : sitesQ.isLoading ? (
          <Loading />
        ) : (
          <SitesMap
            apiKey={MAPS_API_KEY}
            center={center}
            zoom={DEFAULT_ZOOM}
            sites={filtered}
            selected={selected}
            onSelect={setSelected}
            onClose={() => setSelected(null)}
          />
        )}
      </section>
    </div>
  );
}

function SitesMap({ apiKey, center, zoom, sites, selected, onSelect, onClose }) {
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: apiKey,
    id: "neubit-google-map",
  });

  const [mapInstance, setMapInstance] = useState(null);
  useEffect(() => {
    if (!mapInstance || sites.length === 0 || !window.google?.maps) return;
    const bounds = new window.google.maps.LatLngBounds();
    for (const s of sites) {
      bounds.extend({ lat: s.coordinates.latitude, lng: s.coordinates.longitude });
    }
    if (sites.length === 1) {
      mapInstance.setCenter(bounds.getCenter());
      mapInstance.setZoom(14);
    } else {
      mapInstance.fitBounds(bounds, 64);
    }
  }, [mapInstance, sites]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon icon="heroicons-outline:exclamation-triangle" className="text-3xl text-red-500" />
        <p className="text-sm font-semibold text-foreground">Could not load Google Maps</p>
        <p className="max-w-md text-xs text-muted">
          Check the API key restrictions in Google Cloud Console — the key must be allowed for
          the Maps JavaScript API and accept this origin as a referrer.
        </p>
      </div>
    );
  }

  if (!isLoaded) return <Loading />;

  return (
    <>
      <GoogleMap
        mapContainerStyle={CONTAINER_STYLE}
        center={center}
        zoom={zoom}
        onLoad={setMapInstance}
        options={{ fullscreenControl: false, mapTypeControl: false, streetViewControl: false }}
      >
        {sites.map((s) => {
          const tone = THREAT_PIN[s.threat_level] || THREAT_PIN.normal;
          return (
            <Marker
              key={s.site_id}
              position={{ lat: s.coordinates.latitude, lng: s.coordinates.longitude }}
              onClick={() => onSelect(s)}
              icon={{
                path: window.google.maps.SymbolPath.CIRCLE,
                fillColor: tone.color,
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "#ffffff",
                scale: 8,
              }}
              title={`${s.name} · ${tone.label}`}
            />
          );
        })}

        {selected && (
          <InfoWindow
            position={{ lat: selected.coordinates.latitude, lng: selected.coordinates.longitude }}
            onCloseClick={onClose}
          >
            <SiteCard site={selected} onClose={onClose} />
          </InfoWindow>
        )}
      </GoogleMap>
    </>
  );
}

function SiteCard({ site, onClose }) {
  const tone = THREAT_PIN[site.threat_level] || THREAT_PIN.normal;
  return (
    // Info-window content renders inside Google's own light popup, so this card keeps
    // explicit light colors rather than theme tokens.
    <div className="relative min-w-[240px] max-w-[280px] space-y-2 rounded-lg border border-slate-200 bg-white p-2 text-slate-800">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
      >
        <Icon icon="heroicons-outline:x-mark" className="text-sm" />
      </button>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-white" style={{ backgroundColor: tone.color }}>
          <Icon icon="heroicons-outline:building-office-2" className="text-base" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-slate-900">{site.name}</h3>
          {site.location_code && <p className="font-mono text-[10px] text-slate-500">{site.location_code}</p>}
        </div>
      </div>
      <div className="space-y-1 rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: tone.color }} />
          <span>Threat: <strong>{tone.label}</strong></span>
        </div>
        {site.address?.city && (
          <div className="flex items-center gap-1.5">
            <Icon icon="heroicons-outline:map-pin" className="text-slate-500 text-xs" />
            <span>{[site.address.city, site.address.state, site.address.country].filter(Boolean).join(", ")}</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <a
          href="/sites"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
        >
          Configure
          <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-[10px]" />
        </a>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
      <Spinner className="!h-4 !w-4" /> Loading map…
    </div>
  );
}

function Disabled() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center py-20">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
        <Icon icon="heroicons-outline:map" className="text-xl" />
      </span>
      <p className="text-sm font-semibold text-foreground">Google Maps not configured</p>
      <p className="max-w-md text-xs text-muted">
        Set <span className="font-mono text-foreground">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</span> in the
        frontend environment and rebuild. Once a key is present, this map populates from sites
        whose coordinates have been set under Config → Sites.
      </p>
    </div>
  );
}

// Google's default info-window close icon + top padding can duplicate our in-card close
// button, so hide them.
function MapPopupStyleFix() {
  return (
    <style jsx global>{`
      .sites-map-root .gm-style .gm-style-iw-chr {
        display: none !important;
      }
      .sites-map-root .gm-style .gm-style-iw-c {
        padding-top: 8px !important;
      }
    `}</style>
  );
}
