"use client";

// Sites Map — page-entry orchestrator. Every site with coordinates renders as a
// marker colored by threat level, with an info window.
//
// TWO CANVASES, one choice: the default is the OFFLINE basemap (MapLibre over a
// self-hosted PMTiles planet archive), which needs no internet at all. A tenant
// that has explicitly enabled Google Maps and saved a key gets Google instead —
// that toggle is the only switch, so nothing changes for installs already on it.
// Config (enabled flag, key, default centre, tiles URL) comes from the platform
// settings store via GET /settings/maps, NOT a build-time env var. The browser
// receives the api_key because the Google Maps JS loader needs it; the real
// security boundary is the HTTP-referrer restriction on the key.
//
// Both canvases are code-split: whichever provider is off never ships its SDK.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";

import { api } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { DEFAULT_TILES_URL } from "@/lib/map/config";
import { Loading } from "./components/MapChrome";

// ssr:false — both SDKs touch `window`/`document` at module scope.
const GoogleMapView = dynamic(() => import("./components/MapView"), { ssr: false, loading: Loading });
const OfflineMapView = dynamic(() => import("./components/OfflineMapView"), {
  ssr: false,
  loading: Loading,
});

const DEFAULT_CENTER = { lat: 22.9734, lng: 78.6569 }; // India centre
const DEFAULT_ZOOM = 5;

export default function SitesMapPage() {
  const cfgQ = useQuery({
    queryKey: ["maps-config"],
    queryFn: () => api.get("/settings/maps").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const sitesQ = useQuery({
    queryKey: ["sites-map"],
    queryFn: () => sitesApi.list({ limit: 100 }),
  });

  const sites = sitesQ.data?.items || [];

  const apiKey = cfgQ.data?.api_key || "";
  // Google only when a tenant has BOTH turned it on and saved a key; every other
  // configuration — including a fresh install — gets the offline basemap.
  const useGoogle = !!cfgQ.data?.enabled && !!apiKey;
  const tilesUrl = cfgQ.data?.tiles_url || DEFAULT_TILES_URL;
  const defaultZoom = cfgQ.data?.default_zoom || DEFAULT_ZOOM;

  const sitesWithCoords = useMemo(
    () =>
      sites.filter(
        (s) =>
          typeof s.coordinates?.latitude === "number" && typeof s.coordinates?.longitude === "number",
      ),
    [sites],
  );

  const filtered = sitesWithCoords;

  const [selected, setSelected] = useState(null);

  const center = useMemo(() => {
    if (filtered.length === 0) {
      return cfgQ.data?.default_lat != null && cfgQ.data?.default_lng != null
        ? { lat: cfgQ.data.default_lat, lng: cfgQ.data.default_lng }
        : DEFAULT_CENTER;
    }
    const lat = filtered.reduce((a, s) => a + s.coordinates.latitude, 0) / filtered.length;
    const lng = filtered.reduce((a, s) => a + s.coordinates.longitude, 0) / filtered.length;
    return { lat, lng };
  }, [filtered, cfgQ.data]);

  return (
    <div className="flex h-full flex-col">
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
            onSelect={setSelected}
            onClose={() => setSelected(null)}
          />
        ) : (
          <OfflineMapView
            tilesUrl={tilesUrl}
            center={center}
            zoom={defaultZoom}
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
