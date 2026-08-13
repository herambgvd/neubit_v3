"use client";

// Click-a-point coordinate picker on the offline basemap — the air-gapped
// stand-in for Google's geocoder. Self-hosting a geocoder means a full OSM import
// (tens of GB and a second Postgres), which is out of proportion to picking a
// pin for a few dozen sites; and a hand-placed pin beats a geocoder that resolves
// a partial address to the middle of the wrong city.
import { useEffect, useRef, useState } from "react";
// maplibre-gl v6 dropped its default export — named imports only.
import { Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import { Icon } from "@iconify/react";

import "maplibre-gl/dist/maplibre-gl.css";

import { Spinner } from "@/components/ui/kit";
import { DEFAULT_TILES_URL, offlineStyle, probeTiles } from "@/lib/map";
import { PIN_H, PIN_SCALE, PIN_TIP_Y, PIN_W, pinSvg } from "./pin";

const PICK_COLOR = "#60a5fa";

function pickerMarkerElement() {
  const el = document.createElement("div");
  el.style.cssText = `width:${PIN_W * PIN_SCALE}px;height:${PIN_H * PIN_SCALE}px;pointer-events:none`;
  el.innerHTML = pinSvg(PICK_COLOR, false);
  const svg = el.firstElementChild;
  svg.setAttribute("width", `${PIN_W * PIN_SCALE}`);
  svg.setAttribute("height", `${PIN_H * PIN_SCALE}`);
  svg.style.display = "block";
  return el;
}

export default function OfflineMapPicker({
  tilesUrl = DEFAULT_TILES_URL,
  center,
  zoom = 4,
  value,
  onChange,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [status, setStatus] = useState({ state: "probing" });

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The pin the picker opens on, captured once — later `value` changes come from
  // this map's own clicks and must not re-centre it under the user.
  const initial = useRef(value);

  useEffect(() => {
    let cancelled = false;
    let map;

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
        container: containerRef.current,
        style: offlineStyle(tilesUrl, probe.header),
        center: [start.lng, start.lat],
        zoom: initial.current ? 13 : zoom,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("error", (e) => console.warn("[offline-map]", e?.error?.message || e));

      map.on("click", (e) => {
        const { lat, lng } = e.lngLat;
        if (markerRef.current) {
          markerRef.current.setLngLat([lng, lat]);
        } else {
          // setLngLat BEFORE addTo: a Marker added without a position throws out
          // of _update(), which aborted this handler before onChange ever fired —
          // the pin stuck to the map's top-left corner and "Use this point"
          // stayed disabled.
          markerRef.current = new Marker({
            element: pickerMarkerElement(),
            anchor: "bottom",
            offset: [0, (PIN_H - PIN_TIP_Y) * PIN_SCALE],
          })
            .setLngLat([lng, lat])
            .addTo(map);
        }
        onChangeRef.current?.({ latitude: lat, longitude: lng });
      });

      map.on("load", () => {
        if (cancelled) return;
        if (initial.current) {
          markerRef.current = new Marker({
            element: pickerMarkerElement(),
            anchor: "bottom",
            offset: [0, (PIN_H - PIN_TIP_Y) * PIN_SCALE],
          })
            .setLngLat([initial.current.lng, initial.current.lat])
            .addTo(map);
        }
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
      <div className="flex h-[420px] flex-col items-center justify-center gap-2 px-6 text-center">
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
    <div className="relative h-[420px] overflow-hidden rounded-lg border border-nb-line">
      <div ref={containerRef} className="h-full w-full" />
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
