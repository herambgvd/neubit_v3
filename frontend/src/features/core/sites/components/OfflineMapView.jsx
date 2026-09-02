"use client";

// The OFFLINE sites map — MapLibre GL over a self-hosted PMTiles planet basemap.
// Feature-for-feature the same surface as the Google canvas next door (threat
// coloured pins, auto-fit bounds, a SiteCard popup), but every byte comes from
// our own origin, so it works on an air-gapped install.
//
// Markers are managed imperatively: they are static SVG, they can number in the
// hundreds, and MapLibre wants real DOM nodes. The popup goes the other way —
// SiteCard stays a React component, portalled into the node MapLibre owns.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// maplibre-gl v6 dropped its default export — named imports only.
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, Popup } from "maplibre-gl";
import { Icon } from "@iconify/react";

import "maplibre-gl/dist/maplibre-gl.css";

import { Spinner } from "@/components/ui/kit";
import { DEFAULT_TILES_URL, offlineStyle, probeTiles } from "@/lib/map";
import { THREAT_PIN } from "../constants";
import { PIN_H, PIN_SCALE, PIN_SCALE_SELECTED, PIN_TIP_Y, PIN_W, pinSvg } from "./pin";
import SiteCard from "./SiteCard";

const LABEL_MAX = 26;
const SINGLE_SITE_ZOOM = 14;

const lngLat = (site) => [site.coordinates.longitude, site.coordinates.latitude];

// One marker's DOM: the pin art, plus the site name pinned below it. The label is
// absolutely positioned so it never grows the element box — MapLibre anchors on
// that box, and a taller box would lift the pin tip off its coordinate.
function markerElement(site) {
  const label = site.name.length > LABEL_MAX ? `${site.name.slice(0, LABEL_MAX - 1)}…` : site.name;

  const el = document.createElement("div");
  el.className = "site-pin";
  // NO `position` here. MapLibre's own `.maplibregl-marker` class supplies
  // `position: absolute`, and an inline `position: relative` beats it — the
  // markers then stack in normal document flow, each pushed down by the previous
  // one's height, so every pin sat a constant ~47px below the last regardless of
  // zoom. Absolute still establishes the containing block the label needs.
  el.style.cssText = "cursor:pointer";

  const art = document.createElement("div");
  art.className = "site-pin-art";
  el.appendChild(art);

  const caption = document.createElement("span");
  caption.className = "site-marker-label";
  caption.textContent = label;
  el.appendChild(caption);
  return el;
}

// Re-draw an existing marker at the selected/unselected size, in place. Selection
// changes on every click, and tearing down and rebuilding all the markers for it
// made the whole pin layer blink.
function paintMarker(marker, site, isSelected) {
  const tone = THREAT_PIN[site.threat_level] || THREAT_PIN.normal;
  const scale = isSelected ? PIN_SCALE_SELECTED : PIN_SCALE;
  const el = marker.getElement();

  el.title = `${site.name} · ${tone.label}`;
  el.style.width = `${PIN_W * scale}px`;
  el.style.height = `${PIN_H * scale}px`;
  el.style.zIndex = isSelected ? "2" : "1";

  const art = el.querySelector(".site-pin-art");
  art.innerHTML = pinSvg(tone.color, isSelected);
  const svg = art.firstElementChild;
  svg.setAttribute("width", `${PIN_W * scale}`);
  svg.setAttribute("height", `${PIN_H * scale}`);
  svg.style.display = "block";

  // The artwork has 8px of shadow below the tip; push the element down by that
  // much so the tip — not the box bottom — lands on the coordinate.
  marker.setOffset([0, (PIN_H - PIN_TIP_Y) * scale]);
}

function OfflineDisabled({ reason }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-nb-muted">
        <Icon icon="heroicons-outline:map" className="text-xl" />
      </span>
      <p className="text-sm font-semibold text-nb-ink">Offline basemap not installed</p>
      <p className="max-w-md text-xs text-nb-muted">
        The map needs a PMTiles planet archive served at{" "}
        <span className="font-mono text-nb-ink">{DEFAULT_TILES_URL}</span>. Build one with{" "}
        <span className="font-mono text-nb-ink">npm run map:tiles</span> and mount it into the{" "}
        <span className="font-mono text-nb-ink">tiles</span> service — see frontend/README.md.
        {reason ? <> (Tile server said: {reason}.)</> : null}
      </p>
    </div>
  );
}

// MapLibre's chrome is built for a light page; these pull it into the console's
// dark palette and strip the parts SiteCard already provides (its own close
// button, its own padding and background). Rendered by this component rather than
// the page, so the CSS ships with the canvas that needs it.
function OfflineMapStyleFix() {
  return (
    <style jsx global>{`
      .sites-map-root .maplibregl-popup-close-button {
        display: none;
      }
      .sites-map-root .maplibregl-popup-content {
        padding: 0;
        background: transparent;
        box-shadow: none;
      }
      .sites-map-root .maplibregl-popup-anchor-bottom .maplibregl-popup-tip {
        border-top-color: #fff;
      }
      .sites-map-root .maplibregl-popup-anchor-top .maplibregl-popup-tip {
        border-bottom-color: #fff;
      }
      /* Site names sit over dark tiles — a dark halo keeps them legible without
         the white glow the Google canvas needs. */
      .sites-map-root .site-marker-label {
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-top: 2px;
        white-space: nowrap;
        font-size: 12px;
        font-weight: 600;
        color: #e2e8f0;
        text-shadow:
          0 0 3px #0f172a,
          0 0 3px #0f172a,
          0 1px 4px rgba(15, 23, 42, 0.95);
        pointer-events: none;
      }
      .sites-map-root .maplibregl-ctrl-attrib,
      .sites-map-root .maplibregl-ctrl-attrib a {
        background: rgba(6, 11, 26, 0.7);
        color: #94a3b8;
      }
    `}</style>
  );
}

export default function OfflineMapView({
  tilesUrl = DEFAULT_TILES_URL,
  center,
  zoom,
  sites,
  selected,
  onSelect,
  onClose,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const popupRef = useRef(null);

  const [status, setStatus] = useState({ state: "probing" });

  // A node MapLibre owns and React renders into, so the popup body can stay a
  // component instead of an innerHTML string.
  const popupNode = useMemo(
    () => (typeof document === "undefined" ? null : document.createElement("div")),
    [],
  );

  // Latest callbacks, without making them dependencies of effects that must not
  // re-run: the map is built once per tiles URL, markers once per `sites` change.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // ── map lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let map;

    // Back to square one whenever this re-runs. Without it a tiles-URL change
    // leaves `status` at its previous value: from "ready" the marker and auto-fit
    // effects (keyed on status.state) never re-run, so the rebuilt map comes up
    // with no pins; from "missing" the container div isn't even rendered and
    // MapLibre throws on a null container.
    setStatus({ state: "probing" });

    (async () => {
      const probe = await probeTiles(tilesUrl);
      if (cancelled) return;
      if (!probe.ok) {
        setStatus({ state: "missing", reason: probe.reason });
        return;
      }

      map = new MapLibreMap({
        container: containerRef.current,
        style: offlineStyle(tilesUrl, probe.header),
        center: [center.lng, center.lat],
        zoom,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      // Without an 'error' listener MapLibre swallows tile/style failures into a
      // console message that is easy to miss — and a blank canvas looks identical
      // to a slow one. Surface them.
      map.on("error", (e) => console.warn("[offline-map]", e?.error?.message || e));
      // Clicking bare map closes the card, matching the Google canvas.
      map.on("click", () => onCloseRef.current?.());
      map.on("load", () => !cancelled && setStatus({ state: "ready" }));
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      popupRef.current?.remove();
      popupRef.current = null;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current.clear();
      map?.remove();
      mapRef.current = null;
    };
    // Rebuilding the map on a centre/zoom change would fight the user's panning;
    // those are initial-view inputs only, exactly as the Google canvas treats them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesUrl]);

  // ── markers ──────────────────────────────────────────────────────────────
  // Rebuilt only when the site list itself changes. Selection is a repaint, below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status.state !== "ready") return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current.clear();

    for (const site of sites) {
      const el = markerElement(site);
      el.addEventListener("click", (e) => {
        e.stopPropagation(); // else the map's own click handler closes the card we just opened
        onSelectRef.current?.(site);
      });
      const marker = new Marker({ element: el, anchor: "bottom" }).setLngLat(lngLat(site)).addTo(map);
      paintMarker(marker, site, selectedRef.current?.site_id === site.site_id);
      markersRef.current.set(site.site_id, marker);
    }
  }, [sites, status.state]);

  // ── selection repaint ────────────────────────────────────────────────────
  useEffect(() => {
    if (status.state !== "ready") return;
    for (const site of sites) {
      const marker = markersRef.current.get(site.site_id);
      if (marker) paintMarker(marker, site, selected?.site_id === site.site_id);
    }
  }, [selected, sites, status.state]);

  // ── auto-fit ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status.state !== "ready" || sites.length === 0) return;

    if (sites.length === 1) {
      map.setCenter(lngLat(sites[0]));
      map.setZoom(SINGLE_SITE_ZOOM);
      return;
    }
    const bounds = sites.reduce(
      (b, s) => b.extend(lngLat(s)),
      new LngLatBounds(lngLat(sites[0]), lngLat(sites[0])),
    );
    map.fitBounds(bounds, { padding: 64, maxZoom: SINGLE_SITE_ZOOM, animate: false });
  }, [sites, status.state]);

  // ── popup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status.state !== "ready" || !popupNode) return;

    if (!selected) {
      popupRef.current?.remove();
      popupRef.current = null;
      return;
    }
    if (!popupRef.current) {
      popupRef.current = new Popup({
        closeButton: false,
        closeOnClick: false,
        maxWidth: "none",
        anchor: "bottom",
        offset: [0, -PIN_TIP_Y * PIN_SCALE_SELECTED],
      }).setDOMContent(popupNode);
    }
    popupRef.current.setLngLat(lngLat(selected)).addTo(map);
  }, [selected, status.state, popupNode]);

  if (status.state === "missing") return <OfflineDisabled reason={status.reason} />;

  return (
    <>
      <OfflineMapStyleFix />
      <div ref={containerRef} className="h-full w-full" />
      {status.state === "probing" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-nb-muted">
          <Spinner className="!h-4 !w-4" /> Loading map…
        </div>
      )}
      {selected && popupNode && createPortal(<SiteCard site={selected} onClose={onClose} />, popupNode)}
    </>
  );
}
