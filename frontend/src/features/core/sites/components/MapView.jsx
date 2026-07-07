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
// button, so hide them.
export function MapPopupStyleFix() {
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
  );
}
