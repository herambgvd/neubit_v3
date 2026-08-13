"use client";

// The Google Maps canvas — loads the JS API, renders one threat-colored marker
// per site, auto-fits bounds, and shows a SiteCard info-window for the selected
// site. Only reached when a tenant has explicitly enabled Google Maps and saved a
// key; the default is the offline basemap in OfflineMapView.
import { useEffect, useState } from "react";
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from "@react-google-maps/api";
import { Icon } from "@iconify/react";

import { THREAT_PIN } from "../constants";
import { Loading } from "./MapChrome";
import { PIN_H, PIN_SCALE, PIN_SCALE_SELECTED, PIN_TIP_Y, PIN_W, pinSvg } from "./pin";
import SiteCard from "./SiteCard";

const CONTAINER_STYLE = { width: "100%", height: "100%" };

const LABEL_MAX = 26;

// Google needs a fresh Size/Point per icon, so this must run after the JS API is
// loaded (i.e. inside the rendered map, never at module scope).
function pinIcon(color, selected) {
  const s = selected ? PIN_SCALE_SELECTED : PIN_SCALE;
  const w = PIN_W * s;
  const h = PIN_H * s;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(pinSvg(color, selected))}`,
    scaledSize: new window.google.maps.Size(w, h),
    anchor: new window.google.maps.Point(w / 2, PIN_TIP_Y * s),
    // Below the tip — keeps the site name clear of the pin at either size.
    labelOrigin: new window.google.maps.Point(w / 2, h + 6),
  };
}

// Google's default info-window close icon + top padding can duplicate our in-card close
// button, so hide them. The marker label gets a white halo so a site's name stays
// readable over roads, parks and satellite-ish tiles alike. Rendered by this
// component rather than the page, so the CSS ships with the canvas that needs it.
function MapPopupStyleFix() {
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

  // Bumped on every marker click so the InfoWindow below remounts even when the
  // same site is picked twice. Without it, clicking a site → clicking elsewhere
  // (which tears the window down outside React) → clicking that same site again
  // left `selected` referentially unchanged, so React re-rendered nothing and the
  // card never came back until a page refresh.
  const [openNonce, setOpenNonce] = useState(0);
  const openSite = (s) => {
    setOpenNonce((n) => n + 1);
    onSelect(s);
  };

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
        <p className="text-sm font-semibold text-nb-ink">Could not load Google Maps</p>
        <p className="max-w-md text-xs text-nb-muted">
          Google Maps needs internet access. On an air-gapped site, turn{" "}
          <span className="font-medium text-nb-ink">Enable Google Maps</span> off under Platform
          Settings — the console then falls back to the self-hosted offline basemap. Otherwise,
          check the API key restrictions in Google Cloud Console: the key must be allowed for the
          Maps JavaScript API and accept this origin as a referrer.
        </p>
      </div>
    );
  }

  if (!isLoaded) return <Loading />;

  return (
    <>
      <MapPopupStyleFix />
      <GoogleMap
        mapContainerStyle={CONTAINER_STYLE}
        center={center}
        zoom={zoom}
        onLoad={setMapInstance}
        onClick={onClose}
        options={{
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          // Google's own POI labels open a native info window that fights ours for
          // the map's single popup slot; turning them off keeps site pins the only
          // clickable thing on the canvas.
          clickableIcons: false,
        }}
      >
        {sites.map((s) => {
          const tone = THREAT_PIN[s.threat_level] || THREAT_PIN.normal;
          const isSelected = selected?.site_id === s.site_id;
          return (
            <Marker
              key={s.site_id}
              position={{ lat: s.coordinates.latitude, lng: s.coordinates.longitude }}
              onClick={() => openSite(s)}
              zIndex={isSelected ? 1000 : 1}
              icon={pinIcon(tone.color, isSelected)}
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
            key={`${selected.site_id}-${openNonce}`}
            position={{ lat: selected.coordinates.latitude, lng: selected.coordinates.longitude }}
            onCloseClick={onClose}
            // Position sits on the pin's tip, so lift the card clear of the pin head.
            options={{ pixelOffset: new window.google.maps.Size(0, -PIN_TIP_Y * PIN_SCALE_SELECTED) }}
          >
            <SiteCard site={selected} onClose={onClose} />
          </InfoWindow>
        )}
      </GoogleMap>
    </>
  );
}
