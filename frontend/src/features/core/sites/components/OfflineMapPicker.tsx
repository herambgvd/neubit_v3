"use client";

// Click-a-point coordinate picker on the offline basemap — the air-gapped
// stand-in for Google's geocoder. Self-hosting a STREET geocoder means a full OSM
// import (tens of GB and a second Postgres), which is out of proportion to picking
// a pin for a few dozen sites; and a hand-placed pin beats a geocoder that
// resolves a partial address to the middle of the wrong city.
//
// What it does have is PlaceSearch: a committed city gazetteer that flies the map
// to the right place, so nobody has to drag the world from zoom 1.4 to find it.
// The last mile — which building — stays a click, which is the part a geocoder
// would have got wrong anyway.
import { useCallback, useEffect, useRef, useState } from "react";
// maplibre-gl v6 dropped its default export — named imports only.
import { Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import { Icon } from "@iconify/react";

import "maplibre-gl/dist/maplibre-gl.css";

import { Spinner } from "@/components/ui/kit";
import PlaceSearch from "./PlaceSearch";
import { DEFAULT_TILES_URL, offlineStyle, probeTiles } from "@/lib/map";
import { PIN_H, PIN_SCALE, PIN_TIP_Y, PIN_W, pinSvg } from "./pin";

const PICK_COLOR = "#60a5fa";

function pickerMarkerElement() {
  const el = document.createElement("div");
  el.style.cssText = `width:${PIN_W * PIN_SCALE}px;height:${PIN_H * PIN_SCALE}px;pointer-events:none`;
  el.innerHTML = pinSvg(PICK_COLOR, false);
  const svg = el.firstElementChild as SVGElement;
  svg.setAttribute("width", `${PIN_W * PIN_SCALE}`);
  svg.setAttribute("height", `${PIN_H * PIN_SCALE}`);
  svg.style.display = "block";
  return el;
}

/** What the map canvas is doing: probing the archive, missing it, or drawing. */
type MapStatus = { state: "probing" | "missing" | "ready"; reason?: string };

/** A point as MapLibre and the picker's chrome hold it. */
export interface LatLng {
  lat: number;
  lng: number;
}

export interface OfflineMapPickerProps {
  tilesUrl?: string;
  /** Where the map opens when there is no `value` yet. */
  center: LatLng;
  zoom?: number;
  /** The dropped pin, or null before the first click. */
  value: LatLng | null;
  onChange: (point: { latitude: number; longitude: number }) => void;
}

export default function OfflineMapPicker({
  tilesUrl = DEFAULT_TILES_URL,
  center,
  zoom = 4,
  value,
  onChange,
}: OfflineMapPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [status, setStatus] = useState<MapStatus>({ state: "probing" });

  const onChangeRef = useRef(onChange);
  // Refreshed after each commit, never during render (see OfflineMapView).
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // The pin the picker opens on, captured once — later `value` changes come from
  // this map's own clicks and must not re-centre it under the user.
  const initial = useRef(value);

  // setLngLat BEFORE addTo: a Marker added without a position throws out of
  // _update(), which used to abort the click handler before onChange ever fired —
  // the pin stuck to the map's top-left corner and "Use this point" stayed
  // disabled. Kept in one place now that three call sites drop a pin.
  const placeMarker = useCallback((map: MapLibreMap, lat: number, lng: number) => {
    if (markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
      return;
    }
    markerRef.current = new Marker({
      element: pickerMarkerElement(),
      anchor: "bottom",
      offset: [0, (PIN_H - PIN_TIP_Y) * PIN_SCALE],
    })
      .setLngLat([lng, lat])
      .addTo(map);
  }, []);

  const dropPin = useCallback(
    (map: MapLibreMap, lat: number, lng: number) => {
      placeMarker(map, lat, lng);
      onChangeRef.current?.({ latitude: lat, longitude: lng });
    },
    [placeMarker],
  );

  // Where the search box sends the map. A place name only FLIES — the pin still
  // has to be clicked, because a city centre is not a site. A pasted coordinate
  // is already the exact point, so that one drops the pin too.
  const goTo = useCallback(
    ({ lat, lng, zoom: to, drop }: { lat: number; lng: number; zoom: number; drop: boolean }) => {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({ center: [lng, lat], zoom: to, speed: 1.6 });
      if (drop) dropPin(map, lat, lng);
    },
    [dropPin],
  );

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | undefined;

    // See OfflineMapView: a re-run must not inherit the previous status, or the
    // container this effect needs may not be rendered.
    setStatus({ state: "probing" });

    (async () => {
      const probe = await probeTiles(tilesUrl);
      if (cancelled) return;
      if (!probe.ok) {
        setStatus({ state: "missing", reason: probe.reason });
        return;
      }

      const start = initial.current ?? center;
      map = new MapLibreMap({
        container: containerRef.current!,
        style: offlineStyle(tilesUrl, probe.header),
        center: [start.lng, start.lat],
        zoom: initial.current ? 13 : zoom,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("error", (e) => console.warn("[offline-map]", e?.error?.message || e));

      map.on("click", (e) => {
        dropPin(map!, e.lngLat.lat, e.lngLat.lng);
      });

      map.on("load", () => {
        if (cancelled) return;
        if (initial.current) placeMarker(map!, initial.current.lat, initial.current.lng);
        setStatus({ state: "ready" });
      });
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesUrl]);

  if (status.state === "missing") {
    return (
      <div className="flex h-[clamp(320px,58vh,760px)] flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon icon="heroicons-outline:exclamation-triangle" className="text-2xl text-amber-400" />
        <p className="text-sm font-semibold text-nb-ink">Offline basemap not installed</p>
        <p className="max-w-sm text-xs text-nb-muted">
          Without it there is no map to pick from — type the latitude and longitude by hand, or
          install the basemap (see frontend/README.md). Tile server said: {status.reason}.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-[clamp(320px,58vh,760px)] overflow-hidden rounded-lg border border-nb-line">
      <div ref={containerRef} className="h-full w-full" />
      {/* Above the canvas, left of MapLibre's zoom control. */}
      <div className="absolute left-3 top-3 z-10 w-[min(22rem,calc(100%-5rem))]">
        <PlaceSearch onGo={goTo} near={value ?? center} />
      </div>
      {status.state === "probing" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-nb-muted">
          <Spinner className="!h-4 !w-4" /> Loading map…
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-6">
        <span className="rounded-full border border-nb-line bg-[rgba(6,11,26,.85)] px-3 py-1 text-[11px] text-nb-muted">
          {value
            ? `${value.lat.toFixed(6)}, ${value.lng.toFixed(6)} — click again to move the pin`
            : "Click the map to drop a pin"}
        </span>
      </div>
    </div>
  );
}
