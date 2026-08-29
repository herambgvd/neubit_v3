"use client";

// Sites Map — page-entry orchestrator. Every site with coordinates renders as a
// Google Maps marker colored by threat level, with an info window. The Maps API
// key + enabled flag + default centre come from the platform settings store via
// GET /settings/maps (super-admin-configurable), NOT a build-time env var. The
// browser receives the api_key because the Google Maps JS loader needs it; the
// real security boundary is the HTTP-referrer restriction on the key. If Maps is
// disabled or the key is empty we render a graceful "not configured" placeholder.
// The map canvas, markers, info-window and placeholders live in components/MapView.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import MapView, { Loading, Disabled, MapPopupStyleFix } from "./components/MapView";

const DEFAULT_CENTER = { lat: 22.9734, lng: 78.6569 }; // India centre
const DEFAULT_ZOOM = 5;

export default function SitesMapPage() {
  const cfgQ = useQuery<any>({
    queryKey: ["maps-config"],
    queryFn: () => api.get("/settings/maps").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const sitesQ = useQuery<any>({
    queryKey: ["sites-map"],
    queryFn: () => sitesApi.list({ limit: 100 }),
  });

  const sites = sitesQ.data?.items || [];

  const enabled = !!cfgQ.data?.enabled;
  const apiKey = cfgQ.data?.api_key || "";
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

  const [selected, setSelected] = useState<any>(null);

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
        <MapPopupStyleFix />
        {cfgQ.isLoading ? (
          <Loading />
        ) : !enabled || !apiKey ? (
          <Disabled />
        ) : sitesQ.isLoading ? (
          <Loading />
        ) : (
          <MapView
            apiKey={apiKey}
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
