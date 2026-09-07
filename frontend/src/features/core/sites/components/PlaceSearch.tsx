"use client";

// The search box over the offline map picker. Without it the picker opens on the
// whole world and the only way to reach a site is to drag and zoom to it.
//
// Two kinds of query, because operators arrive with both:
//   • a place name, matched against the committed gazetteer (see lib/map/gazetteer)
//   • a pasted coordinate pair, which needs no lookup and drops the pin exactly
//
// Nothing here reaches the network beyond the one same-origin fetch of the
// gazetteer file itself.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import {
  loadGazetteer,
  looksNumeric,
  parseCoordinate,
  searchPlaces,
  zoomForPlace,
  type Place,
} from "@/lib/map/gazetteer";

export interface PlaceSearchProps {
  /** Fly the map here. `drop` is true only when the query WAS a position. */
  onGo: (target: { lat: number; lng: number; zoom: number; drop: boolean }) => void;
}

/** Zoom for a pasted coordinate — the operator already knows the exact spot. */
const COORDINATE_ZOOM = 16;

export default function PlaceSearch({ onGo }: PlaceSearchProps) {
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The highlighted row is stored WITH the query it belongs to, so a new query
  // resets it by derivation. Resetting it from an effect instead costs a second
  // render on every keystroke, and briefly highlights a row from the old results.
  const [highlight, setHighlight] = useState<{ query: string; index: number }>({ query: "", index: 0 });
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const coordinate = parseCoordinate(query);

  // The file is fetched on the FIRST search, not when the picker mounts: an
  // operator who already knows where to click should not pay for it at all.
  useEffect(() => {
    // `looksNumeric` covers the half-typed coordinate: "28.6139" is not a
    // coordinate yet and never will be a place, so it must not trigger the load.
    if (coordinate || looksNumeric(query) || query.trim().length < 2 || places || failed) return;
    let cancelled = false;
    loadGazetteer().then(
      (loaded) => !cancelled && setPlaces(loaded),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [query, coordinate, places, failed]);

  const active = highlight.query === query ? highlight.index : 0;

  const results = useMemo(
    () => (coordinate || !places ? [] : searchPlaces(places, query)),
    [places, query, coordinate],
  );

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

  function go(place: Place) {
    onGo({ lat: place.lat, lng: place.lng, zoom: zoomForPlace(place), drop: false });
    setQuery(place.label);
    setOpen(false);
  }

  function submit() {
    if (coordinate) {
      // A pasted pair IS the point, so it drops the pin as well as flying there.
      onGo({ ...coordinate, zoom: COORDINATE_ZOOM, drop: true });
      setOpen(false);
      return;
    }
    if (results[active]) go(results[active]);
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
      if (!results.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight({ query, index: (active + step + results.length) % results.length });
    }
  }

  const searching = query.trim().length >= 2 && !coordinate && !looksNumeric(query);
  const showList = open && (coordinate !== null || results.length > 0 || (searching && !places && !failed));

  return (
    <div ref={boxRef} className="relative w-full max-w-sm">
      <div className="flex items-center gap-2 rounded-lg border border-nb-line bg-[rgba(6,11,26,.92)] px-3 py-2 backdrop-blur-sm focus-within:border-[rgba(96,165,250,.6)]">
        <Icon icon="heroicons-outline:magnifying-glass" className="shrink-0 text-sm text-nb-muted" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search a city, or paste 28.6139, 77.2090"
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
        <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-nb-line bg-[rgba(6,11,26,.96)] shadow-2xl backdrop-blur-sm">
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
          ) : results.length ? (
            results.map((place, i) => (
              <button
                key={`${place.label}-${place.lat}-${place.lng}`}
                type="button"
                onMouseEnter={() => setHighlight({ query, index: i })}
                onClick={() => go(place)}
                className={`block w-full px-3 py-2 text-left transition ${
                  i === active ? "bg-[rgba(96,165,250,.14)]" : "hover:bg-[rgba(96,165,250,.08)]"
                }`}
              >
                <div className="text-[12.5px] text-nb-ink">{place.name}</div>
                <div className="text-[11px] text-nb-muted">
                  {[place.region, place.country].filter(Boolean).join(", ")}
                </div>
              </button>
            ))
          ) : (
            <div className="px-3 py-2.5 text-[11.5px] text-nb-muted">Loading places…</div>
          )}
        </div>
      )}

      {failed && (
        <p className="mt-1 text-[11px] text-amber-400">
          Place list not installed — paste coordinates, or run{" "}
          <code className="font-mono">node scripts/fetch-gazetteer.mjs</code>.
        </p>
      )}
      {searching && places && !results.length && open && (
        <p className="mt-1 text-[11px] text-nb-muted">
          No place matched. It covers towns over 15,000 people — try the nearest city, then click the
          exact spot.
        </p>
      )}
    </div>
  );
}
