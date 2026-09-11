"use client";

// The search box over the offline map picker. Without it the picker opens on the
// whole world and the only way to reach a site is to drag and zoom to it.
//
// THREE kinds of query, because operators arrive with all three:
//
//   • a full address — "Star Tower Sector 30 Gurgaon" — answered by the Photon
//     `geocoder` service if it is installed (lib/map/geocoder). Street and
//     building level, and still entirely on our own box.
//   • a city — matched against the committed gazetteer (lib/map/gazetteer). This
//     is the fallback that always works, with no service to provision.
//   • a pasted coordinate pair, which needs no lookup at all.
//
// Nothing here reaches the public internet. The geocoder is same-origin, and the
// gazetteer is one same-origin fetch of a static file.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { geocode, probeGeocoder, type GeocodeHit } from "@/lib/map/geocoder";
import {
  loadGazetteer,
  looksNumeric,
  parseCoordinate,
  searchPlaces,
  zoomForPlace,
  type Place,
} from "@/lib/map/gazetteer";

export interface PlaceSearchTarget {
  lat: number;
  lng: number;
  zoom: number;
  /** Whether choosing this also drops the pin, or only flies the map. */
  drop: boolean;
}

export interface PlaceSearchProps {
  onGo: (target: PlaceSearchTarget) => void;
  /** Where the map is looking, so the geocoder can bias towards it. */
  near?: { lat: number; lng: number } | null;
}

/** Zoom for a pasted coordinate — the operator already knows the exact spot. */
const COORDINATE_ZOOM = 16;
/** Long enough that typing an address is one lookup, short enough to feel live. */
const DEBOUNCE_MS = 250;

/** One row of the dropdown, whichever source produced it. */
interface Row extends PlaceSearchTarget {
  key: string;
  title: string;
  detail: string;
}

const fromHit = (hit: GeocodeHit, i: number): Row => ({
  key: `g${i}-${hit.lat}-${hit.lng}`,
  title: hit.title,
  detail: hit.detail,
  lat: hit.lat,
  lng: hit.lng,
  zoom: hit.zoom,
  // A house or a street is the point itself; a city is a region whose centre is
  // not a site, so that one only flies. See PRECISE_TYPES in lib/map/geocoder.
  drop: hit.precise,
});

const fromPlace = (place: Place): Row => ({
  key: `p-${place.label}-${place.lat}-${place.lng}`,
  title: place.name,
  detail: [place.region, place.country].filter(Boolean).join(", "),
  lat: place.lat,
  lng: place.lng,
  zoom: zoomForPlace(place),
  drop: false,
});

export default function PlaceSearch({ onGo, near }: PlaceSearchProps) {
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [gazetteerFailed, setGazetteerFailed] = useState(false);
  const [found, setFound] = useState<GeocodeHit[] | null>(null);
  const [hasGeocoder, setHasGeocoder] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [geocoderFailed, setGeocoderFailed] = useState(false);
  // The highlighted row is stored WITH the query it belongs to, so a new query
  // resets it by derivation. Resetting it from an effect instead costs a second
  // render on every keystroke, and briefly highlights a row from the old results.
  const [highlight, setHighlight] = useState<{ query: string; index: number }>({ query: "", index: 0 });
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const coordinate = parseCoordinate(query);
  const searching = query.trim().length >= 2 && !coordinate && !looksNumeric(query);

  // Ask once, when the picker is opened — not at page load.
  useEffect(() => {
    let cancelled = false;
    probeGeocoder().then((ok) => !cancelled && setHasGeocoder(ok));
    return () => {
      cancelled = true;
    };
  }, []);

  // `near` moves with the map and must not restart the lookup, so it is read
  // through a ref rather than being a dependency.
  const nearRef = useRef(near);
  useEffect(() => {
    nearRef.current = near;
  });

  // The address lookup. Debounced and abortable: an address is a dozen
  // keystrokes, and every one of them would otherwise be a query.
  // A generation counter, and NOT an AbortController.
  //
  // Cancelling the request is the obvious way to drop a superseded lookup, and it
  // is what this did. But aborting an in-flight fetch manufactures an AbortError,
  // and in this app that error kept reaching Next's dev overlay as a runtime
  // error even though the rejection was caught — twice, at two different lines.
  // I could not reproduce it in jsdom, so rather than keep guessing at the
  // mechanism: there is nothing to cancel, so there is no error to leak.
  //
  // The cost is real but small. The geocoder is same-origin and answers in
  // milliseconds, and the debounce already means one request per pause in typing,
  // so what is given up is aborting a local request that was about to finish.
  const generation = useRef(0);

  useEffect(() => {
    if (!searching || !hasGeocoder) return;

    const mine = ++generation.current;
    const timer = setTimeout(() => {
      setBusy(true);
      geocode(query, { near: nearRef.current ?? undefined })
        .then((hits) => {
          // A late answer to an older query must not overwrite a newer one.
          if (mine !== generation.current) return;
          setFound(hits);
          setGeocoderFailed(false);
        })
        .catch(() => {
          if (mine !== generation.current) return;
          // Anything reaching here IS a failure, and has to be visible: a
          // geocoder answering 503 must not look like an address that is simply
          // not on the map.
          setFound(null);
          setGeocoderFailed(true);
        })
        .finally(() => {
          if (mine === generation.current) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, searching, hasGeocoder]);

  // Stale results belong to the PREVIOUS query, so they are derived away rather
  // than cleared from the effect above — clearing state in an effect body costs
  // a second render and shows the old address for one frame.
  const hits = searching && hasGeocoder ? found : null;

  // The city list is fetched on the FIRST search that needs it, never at mount —
  // and never for a query that is (or is becoming) a coordinate.
  useEffect(() => {
    if (!searching || places || gazetteerFailed) return;
    let cancelled = false;
    loadGazetteer().then(
      (loaded) => !cancelled && setPlaces(loaded),
      () => !cancelled && setGazetteerFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [searching, places, gazetteerFailed]);

  const rows = useMemo<Row[]>(() => {
    if (coordinate || !searching) return [];
    // Addresses first when we have them. The gazetteer is the fallback, not a
    // second opinion — showing both would put "Gurugram" under the actual building.
    if (hits?.length) return hits.map((hit, i) => fromHit(hit, i));
    // No addresses (or the service is down) — the city list is the fallback.
    return places ? searchPlaces(places, query).map(fromPlace) : [];
  }, [coordinate, searching, hits, places, query]);

  const active = highlight.query === query ? highlight.index : 0;

  // Click outside closes the list. The map is right underneath, and a stale
  // dropdown would swallow the click that drops the pin.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function go(row: Row) {
    onGo({ lat: row.lat, lng: row.lng, zoom: row.zoom, drop: row.drop });
    setQuery([row.title, row.detail].filter(Boolean).join(", "));
    setOpen(false);
  }

  function submit() {
    if (coordinate) {
      // A pasted pair IS the point, so it drops the pin as well as flying there.
      onGo({ ...coordinate, zoom: COORDINATE_ZOOM, drop: true });
      setOpen(false);
      return;
    }
    if (rows[active]) go(rows[active]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight({ query, index: (active + step + rows.length) % rows.length });
    }
  }

  const loading = searching && (busy || (!places && !gazetteerFailed && !hits));
  const showList = open && (coordinate !== null || rows.length > 0 || loading);
  const emptyHanded = open && searching && !loading && !rows.length;

  return (
    <div ref={boxRef} className="relative w-full max-w-sm">
      <div className="flex items-center gap-2 rounded-lg border border-nb-line bg-[rgba(6,11,26,.92)] px-3 py-2 backdrop-blur-sm focus-within:border-[rgba(96,165,250,.6)]">
        <Icon
          icon={loading ? "svg-spinners:180-ring" : "heroicons-outline:magnifying-glass"}
          className="shrink-0 text-sm text-nb-muted"
        />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={
            hasGeocoder
              ? "Search an address, or paste 28.6139, 77.2090"
              : "Search a city, or paste 28.6139, 77.2090"
          }
          aria-label="Search for a place"
          className="w-full bg-transparent text-[12.5px] text-nb-ink outline-none placeholder:text-nb-muted"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setOpen(false);
            }}
            aria-label="Clear search"
            className="shrink-0 text-nb-muted transition hover:text-nb-ink"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-sm" />
          </button>
        )}
      </div>

      {showList && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border border-nb-line bg-[rgba(6,11,26,.96)] shadow-2xl backdrop-blur-sm">
          {coordinate ? (
            <button
              type="button"
              onClick={submit}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-[rgba(96,165,250,.12)]"
            >
              <Icon icon="heroicons-outline:map-pin" className="shrink-0 text-sm text-nb-blueb" />
              <span className="text-[12.5px] text-nb-ink">
                Go to {coordinate.lat.toFixed(6)}, {coordinate.lng.toFixed(6)}
              </span>
            </button>
          ) : rows.length ? (
            rows.map((row, i) => (
              <button
                key={row.key}
                type="button"
                onMouseEnter={() => setHighlight({ query, index: i })}
                onClick={() => go(row)}
                className={`block w-full px-3 py-2 text-left transition ${
                  i === active ? "bg-[rgba(96,165,250,.14)]" : "hover:bg-[rgba(96,165,250,.08)]"
                }`}
              >
                <div className="text-[12.5px] text-nb-ink">{row.title}</div>
                {row.detail && <div className="text-[11px] text-nb-muted">{row.detail}</div>}
              </button>
            ))
          ) : (
            <div className="px-3 py-2.5 text-[11.5px] text-nb-muted">Searching…</div>
          )}
        </div>
      )}

      {gazetteerFailed && !hasGeocoder && (
        <p className="mt-1 text-[11px] text-amber-400">
          Place list not installed — paste coordinates, or run{" "}
          <code className="font-mono">npm run map:gazetteer</code>.
        </p>
      )}
      {geocoderFailed && (
        <p className="mt-1 text-[11px] text-amber-400">
          Address search is not answering — falling back to the city list. Check the{" "}
          <code className="font-mono">geocoder</code> service.
        </p>
      )}
      {emptyHanded && !geocoderFailed && (
        <p className="mt-1 text-[11px] text-nb-muted">
          {hasGeocoder
            ? "No match. Try the street and the city, or paste coordinates."
            : "No place matched. Address search is not installed, so this only knows towns over 15,000 people — try the nearest city, then click the exact spot."}
        </p>
      )}
    </div>
  );
}
