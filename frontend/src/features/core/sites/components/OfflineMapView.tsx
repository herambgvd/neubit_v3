"use client";

// The OFFLINE estate map — MapLibre GL over a self-hosted PMTiles planet basemap.
// Every byte comes from our own origin, so it works on an air-gapped install.
//
// It is an OPERATIONS surface, not a picture of where the buildings are. A pin
// carries what would make someone click it — unacknowledged alarms, cameras that
// have gone dark — and the estate is CLUSTERED, because the old one drew one DOM
// marker per site and a national estate arrived as a solid mat of overlapping
// teardrops through which nothing could be read or clicked.
//
// Clustering is MapLibre's own (a `cluster: true` GeoJSON source), but the
// markers stay real DOM: the pin art is a shared SVG both map providers use, and
// a symbol layer could not render it. So the source does the spatial work and
// `querySourceFeatures` says which bubbles and pins to keep on screen.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// maplibre-gl v6 dropped its default export — named imports only.
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
} from "maplibre-gl";
import { Icon } from "@iconify/react";

import "maplibre-gl/dist/maplibre-gl.css";

import { Spinner } from "@/components/ui/kit";
import { DEFAULT_TILES_URL, offlineStyle, probeTiles } from "@/lib/map";
import { THREAT_PIN, type SiteWithCoords } from "../constants";
import { EMPTY_OPS, SEVERITY_RANK, opsSeverity, type SiteOps } from "../estateRollup";
import { clusterElement, paintCluster, paintPin, pinElement } from "./clusterMarkers";
import { PIN_SCALE_SELECTED, PIN_TIP_Y } from "./pin";
import SiteCard from "./SiteCard";

const SINGLE_SITE_ZOOM = 14;
const SRC = "estate-sites";
/** A layer must exist for the source to produce tiles `querySourceFeatures` can
 *  read. It draws nothing — the markers are DOM. */
const HIT_LAYER = "estate-sites-hit";

/** A site's position as MapLibre wants it: [lng, lat]. */
const lngLat = (site: SiteWithCoords): [number, number] => [
  site.coordinates.longitude,
  site.coordinates.latitude,
];

function OfflineDisabled({ reason }: { reason?: string }) {
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
// dark palette and strip the parts SiteCard already provides. Rendered by this
// component rather than the page, so the CSS ships with the canvas that needs it.
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
      .sites-map-root .site-pin-badge {
        position: absolute;
        top: -2px;
        right: -6px;
        min-width: 17px;
        height: 17px;
        padding: 0 4px;
        border-radius: 9999px;
        border: 1.5px solid rgba(4, 18, 43, 0.9);
        color: #04122b;
        font-size: 10.5px;
        font-weight: 700;
        line-height: 14px;
        text-align: center;
        pointer-events: none;
      }
      .sites-map-root .maplibregl-ctrl-scale {
        background: rgba(6, 11, 26, 0.7);
        border-color: rgba(150, 180, 245, 0.35);
        color: #cbd5e1;
      }
      .sites-map-root .maplibregl-ctrl-attrib,
      .sites-map-root .maplibregl-ctrl-attrib a {
        background: rgba(6, 11, 26, 0.7);
        color: #94a3b8;
      }
    `}</style>
  );
}

/** What the map canvas is doing: probing the archive, missing it, or drawing. */
type MapStatus = { state: "probing" | "missing" | "ready"; reason?: string };

export interface OfflineMapViewProps {
  tilesUrl?: string;
  /** Initial view only — later changes do not re-centre the map. */
  center: { lat: number; lng: number };
  zoom: number;
  sites: SiteWithCoords[];
  selected: SiteWithCoords | null;
  /** Per-site operational rollup; absent while the feeds load. */
  ops?: Map<string, SiteOps>;
  /** Draw the site name under each pin. */
  showLabels?: boolean;
  onSelect?: (site: SiteWithCoords) => void;
  onClose?: () => void;
}

export default function OfflineMapView({
  tilesUrl = DEFAULT_TILES_URL,
  center,
  zoom,
  sites,
  selected,
  ops,
  showLabels = true,
  onSelect,
  onClose,
}: OfflineMapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new Map<string, Marker>());
  const popupRef = useRef<Popup | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<MapStatus>({ state: "probing" });

  // A node MapLibre owns and React renders into, so the popup body can stay a
  // component instead of an innerHTML string.
  const popupNode = useMemo(
    () => (typeof document === "undefined" ? null : document.createElement("div")),
    [],
  );

  const siteById = useMemo(() => new Map(sites.map((s) => [s.site_id, s])), [sites]);

  // The source's data. Rebuilt when the sites or their rollup change — the
  // cluster aggregation happens inside MapLibre off THESE properties, so a badge
  // that is not in here cannot appear on a cluster bubble.
  const featureCollection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: sites.map((s) => {
        const o = ops?.get(s.site_id) || EMPTY_OPS;
        return {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: lngLat(s) },
          properties: {
            site_id: s.site_id,
            sev: SEVERITY_RANK[opsSeverity(o)],
            alarms: o.alarms,
            offline: o.offline,
          },
        };
      }),
    }),
    [sites, ops],
  );

  // Latest values, without making them dependencies of effects that must not
  // re-run: the map is built once per tiles URL.
  const onSelectRef = useRef(onSelect);
  const onCloseRef = useRef(onClose);
  const selectedRef = useRef(selected);
  const siteByIdRef = useRef(siteById);
  const opsRef = useRef(ops);
  const showLabelsRef = useRef(showLabels);
  // Refreshed after each commit rather than during render — a render React
  // discards must not hand its callbacks to the live map listeners.
  useEffect(() => {
    onSelectRef.current = onSelect;
    onCloseRef.current = onClose;
    selectedRef.current = selected;
    siteByIdRef.current = siteById;
    opsRef.current = ops;
    showLabelsRef.current = showLabels;
  });

  // ── map lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | undefined;

    // Back to square one whenever this re-runs. Without it a tiles-URL change
    // leaves `status` at its previous value: from "ready" the marker effects
    // (keyed on status.state) never re-run, so the rebuilt map comes up with no
    // pins; from "missing" the container isn't rendered and MapLibre throws.
    setStatus({ state: "probing" });

    // The marker Map, captured at SETUP — a local says plainly which Map the
    // cleanup empties: the one this run of the effect filled.
    const markers = markersRef.current;

    (async () => {
      const probe = await probeTiles(tilesUrl);
      if (cancelled) return;
      if (!probe.ok) {
        setStatus({ state: "missing", reason: probe.reason });
        return;
      }

      map = new MapLibreMap({
        container: containerRef.current!,
        style: offlineStyle(tilesUrl, probe.header),
        center: [center.lng, center.lat],
        zoom,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      // A scale bar, because this is a map people measure distances on by eye:
      // without one, "are those two sites close" has no answer at all.
      map.addControl(new ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-left");
      // Without an 'error' listener MapLibre swallows tile/style failures into a
      // console message that is easy to miss — and a blank canvas looks identical
      // to a slow one. Surface them.
      map.on("error", (e) => console.warn("[offline-map]", e?.error?.message || e));
      // Clicking bare map closes the card.
      map.on("click", () => onCloseRef.current?.());
      // The pointer's coordinates, written straight into the DOM: at 60 pointer
      // events a second, a React state update per move would re-render the whole
      // canvas subtree for a number in a corner.
      map.on("mousemove", (e) => {
        if (readoutRef.current) {
          readoutRef.current.textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
        }
      });
      map.on("mouseout", () => {
        if (readoutRef.current) readoutRef.current.textContent = "";
      });
      map.on("load", () => !cancelled && setStatus({ state: "ready" }));
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      popupRef.current?.remove();
      popupRef.current = null;
      markers.forEach((m) => m.remove());
      markers.clear();
      map?.remove();
      mapRef.current = null;
    };
    // Rebuilding the map on a centre/zoom change would fight the user's panning;
    // those are initial-view inputs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesUrl]);

  // ── the clustered source + the marker sync it drives ─────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status.state !== "ready") return;

    const markers = markersRef.current;

    // `clusterProperties` is what makes a bubble able to say "3 alarms in here"
    // without the client re-reading every site it folded in: MapLibre aggregates
    // these while it builds the cluster tree.
    const source = map.getSource(SRC);
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData(featureCollection);
    } else {
      map.addSource(SRC, {
        type: "geojson",
        data: featureCollection,
        cluster: true,
        clusterRadius: 48,
        // Past this zoom the estate is spread far enough that folding sites
        // together hides more than it saves.
        clusterMaxZoom: 13,
        clusterProperties: {
          sev: ["max", ["get", "sev"]],
          alarms: ["+", ["get", "alarms"]],
          offline: ["+", ["get", "offline"]],
        },
      });
      map.addLayer({
        id: HIT_LAYER,
        type: "circle",
        source: SRC,
        paint: { "circle-radius": 1, "circle-opacity": 0 },
      });
    }

    function syncMarkers() {
      const m = mapRef.current;
      if (!m || !m.getLayer(HIT_LAYER)) return;
      const features = m.querySourceFeatures(SRC);
      const live = new Set<string>();

      for (const f of features) {
        const props = (f.properties || {}) as Record<string, number | string>;
        const coords = (f.geometry as { coordinates: [number, number] }).coordinates;
        const isCluster = props.cluster_id !== undefined;
        const key = isCluster ? `c:${props.cluster_id}` : `s:${props.site_id}`;
        // querySourceFeatures returns the SAME feature once per tile it touches.
        if (live.has(key)) continue;
        live.add(key);

        let marker = markers.get(key);
        if (isCluster) {
          const info = {
            count: Number(props.point_count) || 0,
            severity: Number(props.sev) || 0,
            alarms: Number(props.alarms) || 0,
            offline: Number(props.offline) || 0,
          };
          if (!marker) {
            const el = clusterElement(info);
            el.addEventListener("click", (ev) => {
              ev.stopPropagation();
              const src = m.getSource(SRC) as unknown as {
                getClusterExpansionZoom: (id: number) => Promise<number>;
              };
              // Zoom to where this cluster breaks apart — a click that only
              // nudged the zoom would leave the same bubble under the cursor.
              Promise.resolve(src.getClusterExpansionZoom(Number(props.cluster_id)))
                .then((z) => m.easeTo({ center: coords, zoom: z }))
                .catch(() => m.easeTo({ center: coords, zoom: m.getZoom() + 2 }));
            });
            marker = new Marker({ element: el }).setLngLat(coords).addTo(m);
            markers.set(key, marker);
          } else {
            paintCluster(marker.getElement() as HTMLDivElement, info);
            marker.setLngLat(coords);
          }
          continue;
        }

        const site = siteByIdRef.current.get(String(props.site_id));
        if (!site) continue;
        if (!marker) {
          const el = pinElement();
          el.addEventListener("click", (ev) => {
            // else the map's own click handler closes the card we just opened
            ev.stopPropagation();
            const s = siteByIdRef.current.get(String(props.site_id));
            if (s) onSelectRef.current?.(s);
          });
          marker = new Marker({ element: el, anchor: "bottom" }).setLngLat(coords).addTo(m);
          markers.set(key, marker);
        }
        const o = opsRef.current?.get(site.site_id) || EMPTY_OPS;
        const tone = THREAT_PIN[site.threat_level] || THREAT_PIN.normal;
        const offset = paintPin(marker.getElement(), {
          name: site.name,
          color: tone.color,
          label: tone.label,
          selected: selectedRef.current?.site_id === site.site_id,
          alarms: o.alarms,
          offline: o.offline,
          showLabel: showLabelsRef.current,
        });
        marker.setOffset(offset);
        marker.setLngLat(coords);
      }

      // Anything the source no longer renders — panned off, or folded into a
      // cluster by a zoom out — goes away. Leaving them costs a DOM node per
      // site ever seen, and they would float at stale positions.
      for (const [key, marker] of markers) {
        if (!live.has(key)) {
          marker.remove();
          markers.delete(key);
        }
      }
    }

    // `idle` rather than `move`: the cluster tree is rebuilt asynchronously, and
    // querying mid-animation returns the previous zoom's clusters.
    map.on("idle", syncMarkers);
    map.on("sourcedata", syncMarkers);
    syncMarkers();

    return () => {
      map.off("idle", syncMarkers);
      map.off("sourcedata", syncMarkers);
    };
  }, [featureCollection, status.state]);

  // ── selection / label repaint ────────────────────────────────────────────
  // Selection and the label toggle change no geometry, so they repaint the
  // markers that already exist instead of rebuilding the layer.
  useEffect(() => {
    if (status.state !== "ready") return;
    for (const [key, marker] of markersRef.current) {
      if (!key.startsWith("s:")) continue;
      const site = siteById.get(key.slice(2));
      if (!site) continue;
      const o = ops?.get(site.site_id) || EMPTY_OPS;
      const tone = THREAT_PIN[site.threat_level] || THREAT_PIN.normal;
      marker.setOffset(
        paintPin(marker.getElement(), {
          name: site.name,
          color: tone.color,
          label: tone.label,
          selected: selected?.site_id === site.site_id,
          alarms: o.alarms,
          offline: o.offline,
          showLabel: showLabels,
        }),
      );
    }
  }, [selected, siteById, ops, showLabels, status.state]);

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
      <div
        ref={readoutRef}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-2 right-2 rounded-md border border-nb-line bg-[rgba(6,11,26,.75)] px-2 py-1 font-mono text-[10.5px] text-nb-soft"
      />
      {status.state === "probing" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-nb-muted">
          <Spinner className="!h-4 !w-4" /> Loading map…
        </div>
      )}
      {selected && popupNode &&
        createPortal(
          <SiteCard site={selected} ops={ops?.get(selected.site_id)} onClose={onClose} />,
          popupNode,
        )}
    </>
  );
}
