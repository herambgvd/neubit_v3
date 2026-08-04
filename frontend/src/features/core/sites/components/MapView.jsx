"use client";

// The Google Maps canvas itself — loads the JS API, renders one threat-colored
// circle marker per site, auto-fits bounds, and shows a SiteCard info-window for
// the selected site. Plus the small Loading / Disabled placeholders and the
// popup-style fix shared by the SitesMap page.
import { useEffect, useState } from "react";
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from "@react-google-maps/api";
import { Icon } from "@iconify/react";

import { Spinner } from "@/components/ui/kit";
import { THREAT_PIN } from "../constants";
import SiteCard from "./SiteCard";

const CONTAINER_STYLE = { width: "100%", height: "100%" };

// Teardrop pin (Material "place", 24×24 with the tip at 12,22) — a plain circle
// marker disappeared against the map's own POI dots, so sites get a real pin in
// their threat colour with a white outline plus the site name underneath.
const PIN_PATH = "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z";
const LABEL_MAX = 26;

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
      <Spinner className="!h-4 !w-4" /> Loading map…
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center py-20">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
        <Icon icon="heroicons-outline:map" className="text-xl" />
      </span>
      <p className="text-sm font-semibold text-foreground">Google Maps not configured</p>
      <p className="max-w-md text-xs text-muted">
        A super-admin must enable Google Maps and save an API key under{" "}
        <span className="font-medium text-foreground">Platform Settings → Google Maps</span>. Once a
        key is saved and the toggle is on, this map populates from sites whose coordinates have been
        set under Config → Sites.
      </p>
    </div>
  );
}

// Google's default info-window close icon + top padding can duplicate our in-card close
// button, so hide them. The marker label gets a white halo so a site's name stays
// readable over roads, parks and satellite-ish tiles alike.
export function MapPopupStyleFix() {
  return (
    <style jsx global>{`
      .sites-map-root .gm-style .gm-style-iw-chr {
        display: none !important;
      }
      .sites-map-root .gm-style .gm-style-iw-c {
        padding-top: 8px !important;
      }
      .sites-map-root .gm-style .site-marker-label {
        white-space: nowrap;
        text-shadow:
          0 0 3px #fff,
          0 0 3px #fff,
          0 0 4px #fff,
          0 1px 3px rgba(255, 255, 255, 0.95);
      }
    `}</style>
  );
}

export default function MapView({ apiKey, center, zoom, sites, selected, onSelect, onClose }) {
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
    <GoogleMap
      mapContainerStyle={CONTAINER_STYLE}
      center={center}
      zoom={zoom}
      onLoad={setMapInstance}
      options={{ fullscreenControl: false, mapTypeControl: false, streetViewControl: false }}
    >
      {sites.map((s) => {
        const tone = THREAT_PIN[s.threat_level] || THREAT_PIN.normal;
        const isSelected = selected?.site_id === s.site_id;
        const scale = isSelected ? 2 : 1.6;
        return (
          <Marker
            key={s.site_id}
            position={{ lat: s.coordinates.latitude, lng: s.coordinates.longitude }}
            onClick={() => onSelect(s)}
            zIndex={isSelected ? 1000 : 1}
            icon={{
              path: PIN_PATH,
              fillColor: tone.color,
              fillOpacity: 1,
              strokeWeight: 1.5,
              strokeColor: "#ffffff",
              scale,
              anchor: new window.google.maps.Point(12, 22),
              // Below the tip, in the path's own 24×24 space — keeps the name
              // clear of the pin at every scale.
              labelOrigin: new window.google.maps.Point(12, 30),
            }}
            label={{
              text: s.name.length > LABEL_MAX ? `${s.name.slice(0, LABEL_MAX - 1)}…` : s.name,
              className: "site-marker-label",
              color: "#0f172a",
              fontSize: "12px",
              fontWeight: "600",
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
  );
}
