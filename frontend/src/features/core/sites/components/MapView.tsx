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

const LABEL_MAX = 26;

// Site pin, drawn as an SVG data-URI rather than a SymbolPath so it can carry a
// ground shadow, a gradient body and a white "hole" — the flat Material teardrop
// read as just another POI dot. Authored in a 44×52 box with the tip at (22,44);
// everything below scales off those three numbers.
const PIN_W = 44;
const PIN_H = 52;
const PIN_TIP_Y = 44;

function pinSvg(color, selected) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_W}" height="${PIN_H}" viewBox="0 0 ${PIN_W} ${PIN_H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".35"/>
      <stop offset=".55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <ellipse cx="22" cy="46.5" rx="${selected ? 7.5 : 6}" ry="${selected ? 3 : 2.4}" fill="#0f172a" opacity=".3"/>
  <path d="M22 4c-7.73 0-14 6.27-14 14 0 9.9 11.9 24.6 12.9 25.9a1.4 1.4 0 0 0 2.2 0C24.1 42.6 36 27.9 36 18c0-7.73-6.27-14-14-14z"
        fill="${color}" stroke="#ffffff" stroke-width="${selected ? 3 : 2.5}" stroke-linejoin="round"/>
  <path d="M22 4c-7.73 0-14 6.27-14 14 0 9.9 11.9 24.6 12.9 25.9a1.4 1.4 0 0 0 2.2 0C24.1 42.6 36 27.9 36 18c0-7.73-6.27-14-14-14z"
        fill="url(#g)"/>
  <circle cx="22" cy="18" r="5.6" fill="#ffffff"/>
  <circle cx="22" cy="18" r="2.4" fill="${color}" opacity=".85"/>
</svg>`;
}

// Google needs a fresh Size/Point per icon, so this must run after the JS API is
// loaded (i.e. inside the rendered map, never at module scope).
function pinIcon(color, selected) {
  const s = selected ? 1.15 : 0.9;
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

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-nb-muted">
      <Spinner className="!h-4 !w-4" /> Loading map…
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center py-20">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-nb-muted">
        <Icon icon="heroicons-outline:map" className="text-xl" />
      </span>
      <p className="text-sm font-semibold text-nb-ink">Google Maps not configured</p>
      <p className="max-w-md text-xs text-nb-muted">
        A super-admin must enable Google Maps and save an API key under{" "}
        <span className="font-medium text-nb-ink">Platform Settings → Google Maps</span>. Once a
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

export default function MapView({ apiKey, center, zoom, sites, selected, onSelect, onClose }: any) {
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: apiKey,
    id: "neubit-google-map",
  });

  const [mapInstance, setMapInstance] = useState<any>(null);

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
          options={{ pixelOffset: new window.google.maps.Size(0, -PIN_TIP_Y * 1.15) }}
        >
          <SiteCard site={selected} onClose={onClose} />
        </InfoWindow>
      )}
    </GoogleMap>
  );
}
